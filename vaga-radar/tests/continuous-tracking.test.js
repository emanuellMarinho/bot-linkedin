import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { harness, normalizedJob } from './helpers.js';
import { createCollector } from '../src/services/collector.js';
import { fetchJobs } from '../src/providers/index.js';
import { formatTracking } from '../src/bot/tracking.js';
import { startTerminalAnswers } from '../src/terminal/answers.js';
import { askQuestion } from '../src/bot/questions.js';

const epoch = Date.parse('2026-10-28T12:00:00Z');
function source(db, board='fixture') {
  return Number(db.prepare("INSERT INTO sources(provider,board,company,enabled) VALUES ('lever',?,'Empresa fictícia',1)").run(board).lastInsertRowid);
}
const runCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM collection_runs').get().n;

test('busca contínua consulta fontes elegíveis, persiste cooldown e não cria execuções durante espera', async (t) => {
  let time = epoch, calls = 0;
  const h = harness({ continuous: true, clock: () => time, provider: async () => { calls++; return { jobs: [], errors: [] }; } });
  t.after(() => h.close());
  source(h.db);
  const first = await h.collector.run();
  assert.equal(first.status, 'completed');
  assert.equal(first.retryAfterMs, 30000);
  for (let i=0;i<3;i++) assert.equal((await h.collector.run()).status, 'waiting');
  assert.equal(calls,1);
  assert.equal(runCount(h.db),1);
  // A new collector uses persisted state; restarting cannot bypass throttling.
  const restarted = createCollector(h.store, { continuous:true, clock:()=>time, provider:async()=>{ calls++; return {jobs:[],errors:[]}; } });
  t.after(()=>restarted.stop());
  assert.equal((await restarted.run()).status,'waiting');
  time += 30000;
  assert.equal((await restarted.run()).status,'completed');
  assert.equal(calls,2);
  assert.equal(runCount(h.db),2);
});

test('falha adia somente sua fonte e Retry-After continua válido após reiniciar', async (t) => {
  let time=epoch;
  const calls=[];
  const h=harness({continuous:true,clock:()=>time,provider:async(s)=>{
    calls.push(s.board);
    if(s.board==='limited') throw Object.assign(new Error('lever: HTTP 429'),{retryAfterMs:180000,retryAt:new Date(time+180000).toISOString()});
    return {jobs:[],errors:[]};
  }});
  t.after(()=>h.close());
  source(h.db,'limited'); source(h.db,'ready');
  assert.equal((await h.collector.run()).status,'partial');
  time+=30000;
  assert.equal((await h.collector.run()).status,'completed');
  assert.deepEqual(calls,['limited','ready','ready']);
  h.db.prepare("UPDATE sources SET enabled=0 WHERE board='ready'").run();
  const restarted=createCollector(h.store,{continuous:true,clock:()=>time,provider:async(s)=>{calls.push(s.board);return {jobs:[],errors:[]};}});
  t.after(()=>restarted.stop());
  const waiting=await restarted.run();
  assert.equal(waiting.status,'waiting');
  assert.equal(waiting.retryAfterMs,150000);
  time+=150000;
  assert.equal((await restarted.run()).status,'completed');
  assert.deepEqual(calls,['limited','ready','ready','limited']);
});

test('falhas consecutivas usam backoff exponencial e sucesso restaura intervalo mínimo', async (t) => {
  let time=epoch, calls=0;
  const h=harness({continuous:true,clock:()=>time,provider:async()=>{
    calls++;
    if(calls<=2) throw new Error('offline');
    return {jobs:[],errors:[]};
  }});
  t.after(()=>h.close()); source(h.db);
  assert.equal((await h.collector.run()).retryAfterMs,60000);
  time+=59999; assert.equal((await h.collector.run()).status,'waiting');
  time++; assert.equal((await h.collector.run()).retryAfterMs,120000);
  time+=120000; assert.equal((await h.collector.run()).retryAfterMs,30000);
  assert.equal(calls,3);
});

test('fontes pausadas ou ausentes não geram execuções vazias; metadados inválidos não bloqueiam para sempre', async (t) => {
  const h=harness({continuous:true,clock:()=>epoch,provider:async()=>({jobs:[],errors:[]})});
  t.after(()=>h.close());
  assert.equal((await h.collector.run()).status,'no_sources');
  assert.equal(runCount(h.db),0);
  const id=source(h.db);
  h.store.saveSettings({...h.store.getSettings(),collectionEnabled:false});
  assert.equal((await h.collector.run()).status,'paused');
  assert.equal(runCount(h.db),0);
  h.store.saveSettings({...h.store.getSettings(),collectionEnabled:true});
  h.db.prepare('UPDATE sources SET last_checked=? WHERE id=?').run('bad-date',id);
  h.db.prepare('INSERT INTO settings VALUES (?,?)').run(`collection_cooldown:${id}`,'{"until":1e100}');
  assert.equal((await h.collector.run()).status,'completed');
});

test('modo de coleta existente permanece sem cooldown e corpo Retry-After longo não é retentado internamente',async(t)=>{
  let calls=0;
  const h=harness({provider:async()=>{calls++; return {jobs:[],errors:[]};}});
  t.after(()=>h.close());source(h.db);
  await h.collector.run();await h.collector.run();assert.equal(calls,2);
  let network=0;
  await assert.rejects(fetchJobs({provider:'lever',board:'fixture'},{fetcher:async()=>{network++;return new Response('',{status:429,headers:{'Retry-After':'300'}});}}),(error)=>error.status===429&&error.retryAfterMs===300000&&Number.isFinite(Date.parse(error.retryAt)));
  assert.equal(network,1);
});

test('acompanhamento mostra estado atual, link e dúvidas sem anunciar envio não confirmado', (t)=>{
  const h=harness();t.after(()=>h.close());
  const {job}=h.store.upsertJob(normalizedJob());
  const application=h.store.ensureApplication(job.id);
  askQuestion(h.db,{id:'VISA_FIXTURE',jobId:job.id,topic:'form',text:'Você tem autorização para trabalhar?'});
  h.db.prepare('INSERT INTO settings VALUES (?,?)').run(`bot_pending:${job.id}`,JSON.stringify({reason:'AWAITING_CANDIDATE_ANSWERS'}));
  const summary=formatTracking(h.db,'candidaturas');
  assert.match(summary,/Empresa de teste/);assert.match(summary,/aguardando suas respostas/);assert.match(summary,/1 dúvida/);
  const details=formatTracking(h.store,`vaga ${job.id}`);
  assert.match(details,/https:\/\/example.org\/jobs\/1/);assert.match(details,/VISA_FIXTURE/);assert.match(details,/ainda não tem confirmação/);
  h.db.prepare("UPDATE applications SET status='interview' WHERE id=?").run(application.id);
  h.db.prepare("INSERT INTO submission_attempts(job_id,provider,board,posting_id,status,created_at,updated_at) VALUES (?,'lever','fixture','posting','submitted',?,?)").run(job.id,new Date(epoch).toISOString(),new Date(epoch).toISOString());
  assert.match(formatTracking(h.db,'candidaturas'),/entrevista/);
  assert.equal(formatTracking(h.db,'assunto não reconhecido'),null);
  assert.match(formatTracking(h.db,'vaga 999'),/não encontrada/);
});

test('acompanhamento limita tamanho e remove controles fornecidos pela vaga', (t)=>{
  const h=harness();t.after(()=>h.close());
  for(let i=0;i<12;i++) h.store.upsertJob(normalizedJob({url:`https://example.org/jobs/${i}`,title:`${'Título '.repeat(100)}\u001b[31m\u202e${i}`,company:'Empresa '.repeat(100)}));
  const report=formatTracking(h.db,'vagas');
  assert.ok(report.length<=3500);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f\u202e]/.test(report));
  assert.match(report,/vaga ID/);
});

test('terminal compartilha comandos de acompanhamento e preserva resposta de pergunta sem encerrar execução',async(t)=>{
  const h=harness();t.after(()=>h.close());
  askQuestion(h.db,{id:'APPLICANT_EMAIL',topic:'email',text:'Qual e-mail?'});
  const input=new PassThrough(), output=new PassThrough();
  let text='',stopped=0;
  output.on('data',(chunk)=>{text+=chunk.toString();});
  const terminal=startTerminalAnswers(h.db,{input,output,onStop:()=>stopped++,onCommand:(command)=>formatTracking(h.db,command)});
  t.after(()=>{terminal.close();input.destroy();output.destroy();});
  input.write('ajuda\n');input.write('vagas\n');input.write('APPLICANT_EMAIL: fixture@example.org\n');
  assert.match(text,/Comandos:/);assert.match(text,/Nenhuma vaga encontrada/);assert.match(text,/Resposta salva/);
  assert.equal(h.db.prepare("SELECT answer FROM bot_questions WHERE id='APPLICANT_EMAIL'").get().answer,'fixture@example.org');
  assert.equal(stopped,0);
});
