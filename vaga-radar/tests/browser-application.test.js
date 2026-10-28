import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { submitLeverBrowserApplication, launchApplicationBrowser, leverApplicationUrl } from '../src/submissions/lever-browser.js';
import { harness, normalizedJob } from './helpers.js';
import { botConfigInput, applyBotConfig } from '../src/bot/config.js';
import { runBotCycle } from '../src/bot/worker.js';
import { acceptCandidateAnswer } from '../src/bot/questions.js';

const form = (mode='confirm') => `<!DOCTYPE html><html><body><form>
<label>Full name<input name="name" required></label><label>Email<input type="email" name="email" required></label>
<label>Phone<input type="tel" name="phone"></label><label>Resume<input type="file" name="resume" required></label>
<label>Expected salary<input name="salary" required></label>
<label>Do you have permission to work?<select name="work" required><option value="">Select</option><option value="yes">Yes</option><option value="no">No</option></select></label>
<label>Consent to data processing<input type="checkbox" name="consent" required></label><button type="submit">Submit application</button>
</form>${mode==='unknown'?'<div class="application-confirmation" style="display:none">Thank you! Your application has been submitted.</div>':''}<script>document.querySelector('form').onsubmit=(event)=>{event.preventDefault();${mode==='confirm'?`document.body.innerHTML='<div class="application-confirmation">Thank you! Your application has been submitted.</div>';history.pushState({},'',location.pathname.replace('/apply','/thanks'));`:''}}</script></body></html>`;
async function fixtureBrowser(html) {
  const browser = await launchApplicationBrowser();
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    await context.route('**/*', async (route)=> {
      if(route.request().url().startsWith('https://jobs.lever.co/fixture/posting/')) await route.fulfill({contentType:'text/html',body:html});
      else await route.abort();
    });
    return context;
  };
  return browser;
}
function input(t) {
  const h=harness();t.after(()=>h.close());
  const resumePath=path.join(h.dataDir,'resume.txt');fs.writeFileSync(resumePath,'Pessoa Fictícia\nNode.js JavaScript SQL');
  return {h,value:{board:'fixture',postingId:'posting',fullName:'Pessoa Fictícia',email:'fixture@example.org',phone:'5511999990000',resumePath}};
}

test('hosted Lever restricts destination and cannot submit without persistent callback',async(t)=>{
  assert.throws(()=>leverApplicationUrl('../evil','posting'));
  const {value}=input(t);
  const questions=(await submitLeverBrowserApplication(value,{browserFactory:()=>fixtureBrowser(form())})).pendingQuestions;
  const answers=Object.fromEntries(questions.map((q)=>[q.key,q.yesNo?'sim':q.options.length?'Yes':'5000']));
  await assert.rejects(submitLeverBrowserApplication({...value,answers},{browserFactory:()=>fixtureBrowser(form())}),{code:'VALIDATION'});
});

test('real browser collects salary, authorization and consent before clicking; answer resumes with confirmation evidence',async(t)=>{
  const {value}=input(t);let persisted=0;
  const opts={browserFactory:()=>fixtureBrowser(form()),onBeforeSubmit:async()=>persisted++};
  const prepared=await submitLeverBrowserApplication(value,opts);
  assert.equal(persisted,0);assert.equal(prepared.pendingQuestions.length,3);
  assert.ok(prepared.pendingQuestions.some((q)=>/salary/i.test(q.label)));
  const answers=Object.fromEntries(prepared.pendingQuestions.map((q)=>[q.key,q.yesNo?'sim':q.options.length?'Yes':'5000']));
  const receipt=await submitLeverBrowserApplication({...value,answers},opts);
  assert.equal(persisted,1);assert.equal(receipt.verified,true);assert.equal(receipt.method,'browser');
  assert.equal(receipt.applicationId,undefined);assert.match(receipt.confirmation.url,/\/thanks$/);assert.match(receipt.confirmation.sha256,/^[a-f0-9]{64}$/);
});

test('hosted Lever refuses guessed consent and marks result after click ambiguous without resending',async(t)=>{
  const {value}=input(t);let calls=0;
  const opts={browserFactory:()=>fixtureBrowser(form('unknown')),onBeforeSubmit:async()=>calls++,timeoutMs:500};
  const pending=await submitLeverBrowserApplication(value,opts);
  const answers=Object.fromEntries(pending.pendingQuestions.map((q)=>[q.key,q.yesNo?'não':q.options.length?'Yes':'5000']));
  await assert.rejects(submitLeverBrowserApplication({...value,answers},opts),{code:'CONSENT_DECLINED'});assert.equal(calls,0);
  for(const q of pending.pendingQuestions) if(q.yesNo) answers[q.key]='sim';
  await assert.rejects(submitLeverBrowserApplication({...value,answers},opts),{code:'AMBIGUOUS'});assert.equal(calls,1);
});

test('browser worker persists form questions, validates WhatsApp options, then records hosted receipt once without employer key',async(t)=>{
  const {h,value}=input(t);
  const config=botConfigInput.parse({dataDir:h.dataDir,applicant:{email:value.email,resumePath:value.resumePath},profile:{name:value.fullName,skills:['Node.js','JavaScript','SQL'].map(name=>({name,verified:true}))},sources:[],autoApply:{enabled:true,mode:'browser'},whatsapp:{to:value.phone}});
  applyBotConfig(h.store,config);
  const job=h.store.upsertJob(normalizedJob({provider:'lever',board:'fixture',originalId:'posting',url:'https://jobs.lever.co/fixture/posting',applicationUrl:'https://jobs.lever.co/fixture/posting/apply'})).job;
  const collector={run:async()=>({status:'completed',received:0,inserted:0,errors:'[]'})};
  let requests=0;
  const browserSubmit=async(input,opts)=>{requests++;return submitLeverBrowserApplication(input,{...opts,browserFactory:()=>fixtureBrowser(form())});};
  const first=await runBotCycle(h.store,collector,config,{env:{},browserSubmit});
  assert.equal(first.submitted,0);assert.ok(first.pending.some(p=>p.reason==='AWAITING_FORM_ANSWERS'));
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM submission_attempts').get().n,0);
  const qs=h.db.prepare("SELECT * FROM bot_questions WHERE topic='form'").all();assert.equal(qs.length,3);
  for(const q of qs){const m=JSON.parse(q.metadata);if(m.options.length) assert.equal(acceptCandidateAnswer(h.db,{messageId:'invalid-'+q.id,questionId:q.id,answer:'Maybe'}).reason,'invalid_option');assert.equal(acceptCandidateAnswer(h.db,{messageId:'fixture-'+q.id,questionId:q.id,answer:m.yesNo?'sim':m.options.length?'Yes':'5000'}).accepted,true);}
  const second=await runBotCycle(h.store,collector,config,{env:{},browserSubmit});
  assert.equal(second.submitted,1);assert.equal(h.store.getJob(job.id).status,'sent');
  assert.equal(h.db.prepare('SELECT provider_application_id FROM submission_attempts').get().provider_application_id,null);
  const packet=JSON.parse(fs.readFileSync(path.join(h.dataDir,'outbox',`job-${job.id}.json`)));
  assert.match(packet.confirmation.sha256,/^[a-f0-9]{64}$/);assert.equal(packet.applicationId,undefined);
  await runBotCycle(h.store,collector,config,{env:{},browserSubmit});assert.equal(requests,2);
});

test('Lever refuses a foreign form action before recording or sending candidate data',async(t)=>{
  const {value}=input(t);let attempts=0;
  const html=form().replace('<form>','<form action="https://example.org/collect">');
  const opts={browserFactory:()=>fixtureBrowser(html),onBeforeSubmit:async()=>attempts++};
  const pending=await submitLeverBrowserApplication(value,opts);
  const answers=Object.fromEntries(pending.pendingQuestions.map((q)=>[q.key,q.yesNo?'sim':q.options.length?'Yes':'5000']));
  await assert.rejects(submitLeverBrowserApplication({...value,answers},opts),{code:'UNSUPPORTED_FORM'});
  assert.equal(attempts,0);
});

test('browser worker retains ambiguous attempt and avoids reopening an unchanged blocked form',async(t)=>{
  for(const kind of ['CAPTCHA_REQUIRED','AMBIGUOUS']) {
    const {h,value}=input(t);
    const config=botConfigInput.parse({dataDir:h.dataDir,applicant:{email:value.email,resumePath:value.resumePath},profile:{name:value.fullName,skills:['Node.js','JavaScript','SQL'].map(name=>({name,verified:true}))},sources:[],autoApply:{enabled:true,mode:'browser'}});
    applyBotConfig(h.store,config);
    h.store.upsertJob(normalizedJob({provider:'lever',board:'fixture',originalId:'posting',url:'https://jobs.lever.co/fixture/posting',applicationUrl:'https://jobs.lever.co/fixture/posting/apply'}));
    const collector={run:async()=>({status:'completed',received:0,inserted:0,errors:'[]'})};
    let calls=0;
    const browserSubmit=async(value,opts)=>{calls++;if(kind==='AMBIGUOUS')await opts.onBeforeSubmit();throw Object.assign(new Error('fixture'),{code:kind});};
    await runBotCycle(h.store,collector,config,{env:{},browserSubmit});
    await runBotCycle(h.store,collector,config,{env:{},browserSubmit});
    assert.equal(calls,1);
    if(kind==='AMBIGUOUS') assert.equal(h.db.prepare('SELECT status FROM submission_attempts').get().status,'ambiguous');
    else assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM submission_attempts').get().n,0);
  }
});
