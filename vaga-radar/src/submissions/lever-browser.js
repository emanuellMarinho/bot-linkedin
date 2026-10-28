import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright-core';
import { SubmissionError } from './lever.js';

const error = (code, text) => new SubmissionError(code, text);
const clean = (text) => String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
export function leverApplicationUrl(board, postingId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(board || '') || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,149}$/.test(postingId || ''))
    throw error('VALIDATION', 'Identificador da vaga Lever inválido.');
  return `https://jobs.lever.co/${board}/${postingId}/apply`;
}
export async function launchApplicationBrowser() {
  const paths = process.platform === 'win32'
    ? [path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe')]
    : [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  const executablePath = paths.find((p) => p && fs.existsSync(p));
  if (!executablePath) throw error('BROWSER_UNAVAILABLE', 'Instale Microsoft Edge ou Google Chrome para preencher formulários Lever.');
  return chromium.launch({ executablePath, headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] });
}

/** Public Lever candidate forms only. No login, CAPTCHA solving or employer API credentials. */
export async function submitLeverBrowserApplication(input, {
  browserFactory = launchApplicationBrowser,
  onBeforeSubmit,
  signal,
  timeoutMs = 20000,
} = {}) {
  const url = leverApplicationUrl(input?.board, input?.postingId);
  if (!input.fullName?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email || '') || !fs.existsSync(input.resumePath || ''))
    throw error('VALIDATION', 'Nome, e-mail e currículo são necessários para o formulário.');
  if (signal?.aborted) throw error('CANCELLED', 'Preenchimento cancelado.');
  let browser, page, dispatched = false;
  const abort = () => { browser?.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    browser = await browserFactory();
    if (signal?.aborted) throw error('CANCELLED', 'Preenchimento cancelado.');
    const context = await browser.newContext({ acceptDownloads: false });
    page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const current = new URL(page.url());
    if (current.origin !== 'https://jobs.lever.co' || !current.pathname.startsWith(`/${input.board}/${input.postingId}/`))
      throw error('UNSUPPORTED_FORM', 'O formulário redirecionou para uma plataforma ainda não suportada.');
    if (await page.locator('input[type="password"]').count()) throw error('LOGIN_REQUIRED', 'O formulário exige login.');
    if (await hasCaptcha(page)) throw error('CAPTCHA_REQUIRED', 'O formulário exige verificação humana.');
    const controls = await page.evaluate(() => {
      const visible = (el) => !el.disabled && (el.type === 'file' || el.getClientRects().length > 0);
      const controls = [...document.querySelectorAll('input,select,textarea')].filter(visible);
      const seen = new Set();
      return controls.flatMap((el, index) => {
        const type = (el.type || el.tagName).toLowerCase();
        if (['submit','button','reset','hidden'].includes(type)) return [];
        el.setAttribute('data-vaga-control', String(index));
        const container = el.closest('.application-question, .application-field, li, fieldset') || el.parentElement;
        const group = type === 'radio' ? controls.filter((other) => other.type === 'radio' && other.name === el.name) : [el];
        if (type === 'radio' && seen.has(el.name)) return [];
        if (type === 'radio') seen.add(el.name);
        const fieldLabel = container?.querySelector('.application-label, legend, .field-label')?.textContent || el.labels?.[0]?.textContent || el.getAttribute('aria-label') || el.placeholder || el.name;
        const required = el.required || group.some((other) => other.required) || !!container?.querySelector('.required, [aria-required="true"]') || /\*\s*$/.test(fieldLabel || '');
        let options = [];
        if (el.tagName === 'SELECT') options = [...el.options].filter((o) => o.value && !o.disabled).map((o) => ({value:o.value,label:o.textContent.trim()}));
        if (type === 'radio') options = group.map((o) => ({value:o.value,label:(o.labels?.[0]?.textContent || o.parentElement?.textContent || o.value).trim(),index:controls.indexOf(o)}));
        return [{ index, type, name: el.name || '', label: (fieldLabel || '').trim().slice(0,500), required, options, multiple: !!el.multiple }];
      });
    });
    if (!controls.length || !controls.some((c) => c.type === 'file')) throw error('UNSUPPORTED_FORM', 'O formulário Lever esperado não foi encontrado.');
    const pendingQuestions = [];
    for (const control of controls) {
      if (control.required && control.label.length > 350) throw error('UNSUPPORTED_FORM','Leia e responda diretamente no formulário: o campo obrigatório contém instruções extensas.');
      const signature = `${control.name}|${control.label}|${control.type}|${JSON.stringify(control.options)}`;
      const key = crypto.createHash('sha256').update(signature).digest('hex').slice(0,16);
      const identity = `${control.name} ${control.label}`.toLowerCase();
      const locator = page.locator(`[data-vaga-control="${control.index}"]`);
      let value;
      if (control.type === 'file') {
        if (/(^|[^a-z])(resume|curr[ií]culo|cv)([^a-z]|$)/i.test(identity)) await locator.setInputFiles(input.resumePath);
        else if (control.required) throw error('UNSUPPORTED_FORM','O formulário exige um documento adicional ao currículo.');
        continue;
      }
      if (['text','email','tel','textarea','url','number'].includes(control.type)) {
        if (/^(name|fullname|full name|nome completo)(\b|\s)/i.test(identity)) value = input.fullName;
        else if (control.type === 'email' || /^email\b|e-mail/.test(identity)) value = input.email;
        else if (control.type === 'tel' || /^phone\b|telefone|celular/.test(identity)) value = input.phone;
        else if (/linkedin/.test(identity)) value = input.links?.find((link) => /^https:\/\/(www\.)?linkedin\.com\//i.test(link));
        else if (/github/.test(identity)) value = input.links?.find((link) => /^https:\/\/(www\.)?github\.com\//i.test(link));
      }
      if (value === undefined || value === '') value = input.answers?.[key];
      if (value === undefined || value === '') {
        if (control.required) pendingQuestions.push({key,label:clean(control.label || control.name).slice(0,350),type:control.type,options:control.options.map((o)=>o.label),yesNo:control.type==='checkbox'});
        continue;
      }
      value = String(value);
      if (control.multiple) throw error('UNSUPPORTED_FORM','Campo de seleção múltipla ainda precisa de revisão.');
      if (control.type === 'select-one' || control.type === 'radio') {
        const option = control.options.find((o) => o.label.toLowerCase() === value.toLowerCase() || o.value === value);
        if (!option) throw error('INVALID_FORM_ANSWER','Uma resposta não corresponde às opções atuais do formulário.');
        if (control.type === 'select-one') await locator.selectOption(option.value);
        else await page.locator(`[data-vaga-control="${option.index}"]`).check();
      } else if (control.type === 'checkbox') {
        if (!/^(sim|n[aã]o)$/i.test(value)) throw error('INVALID_FORM_ANSWER','Responda sim ou não para a autorização solicitada.');
        const yes = /^sim$/i.test(value);
        if (control.required && !yes) throw error('CONSENT_DECLINED','Você não autorizou um requisito obrigatório desta candidatura.');
        await locator.setChecked(yes);
      } else if (control.type === 'file') throw error('UNSUPPORTED_FORM','O formulário pede um documento adicional.');
      else await locator.fill(value);
    }
    if (pendingQuestions.length) return { pendingQuestions };
    if (await hasCaptcha(page)) throw error('CAPTCHA_REQUIRED','O formulário exige verificação humana.');
    const invalid = await page.evaluate(() => [...document.querySelectorAll('input,select,textarea')].filter((e) => !e.disabled && e.getClientRects().length && typeof e.checkValidity === 'function' && !e.checkValidity()).length);
    if (invalid) throw error('INVALID_FORM_ANSWER','O formulário recusou um valor informado. Revise a candidatura.');
    const submit = page.locator('button[type="submit"],input[type="submit"],button#btn-submit,.application-submit button').filter({visible:true});
    if (await submit.count() !== 1 || !(await submit.isEnabled())) throw error('UNSUPPORTED_FORM','O botão de candidatura não está disponível.');
    const destination = await submit.evaluate((button) => button.form?.getAttribute('action') || '');
    const action = new URL(destination || page.url(), page.url());
    if (action.origin !== 'https://jobs.lever.co' || !action.pathname.startsWith(`/${input.board}/${input.postingId}`))
      throw error('UNSUPPORTED_FORM', 'O envio deste formulário usa um destino ainda não suportado.');
    if (signal?.aborted) throw error('CANCELLED','Preenchimento cancelado.');
    if (typeof onBeforeSubmit !== 'function') throw error('VALIDATION','O envio exige registro persistente antes de começar.');
    await onBeforeSubmit();
    if (signal?.aborted) throw error('CANCELLED','Preenchimento cancelado antes do envio.');
    dispatched = true;
    await submit.click({noWaitAfter:true});
    await page.waitForFunction(() => {
      const confirmation = document.querySelector('.application-confirmation, .application-confirmation-page, [data-qa="application-confirmation"]');
      return confirmation && confirmation.getClientRects().length > 0 && getComputedStyle(confirmation).visibility !== 'hidden' && /thank you|application (?:has been )?(?:submitted|received)|candidatura (?:foi )?(?:enviada|recebida)/i.test(confirmation.textContent || '');
    }, null, {timeout:timeoutMs});
    const confirmation = clean(await page.locator('.application-confirmation, .application-confirmation-page, [data-qa="application-confirmation"]').first().innerText());
    const receiptUrl = new URL(page.url());
    if (receiptUrl.origin !== 'https://jobs.lever.co' || !receiptUrl.pathname.startsWith(`/${input.board}/${input.postingId}`)) throw error('AMBIGUOUS','A confirmação veio de uma página inesperada.');
    return {provider:'lever',method:'browser',board:input.board,postingId:input.postingId,verified:true,confirmation:{url:receiptUrl.toString(),text:confirmation.slice(0,1000),sha256:crypto.createHash('sha256').update(confirmation).digest('hex')}};
  } catch (cause) {
    if (dispatched) throw error('AMBIGUOUS','Resultado do formulário inconclusivo; confira a vaga antes de reenviar.');
    if (signal?.aborted) throw error('CANCELLED','Preenchimento cancelado antes do envio.');
    if (cause instanceof SubmissionError) throw cause;
    throw error('FORM_UNAVAILABLE','Não foi possível abrir ou preencher o formulário Lever.');
  } finally {
    signal?.removeEventListener('abort',abort);
    await browser?.close().catch(()=>{});
  }
}
async function hasCaptcha(page) {
  return page.locator('iframe[title*="challenge" i], iframe[title*="recaptcha" i], .g-recaptcha, .h-captcha').filter({visible:true}).count().then((n)=>n>0);
}
