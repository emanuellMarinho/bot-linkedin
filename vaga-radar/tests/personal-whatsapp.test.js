import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { startPersonalWhatsApp, resetPersonalWhatsAppSession } from '../src/messaging/personal.js';

// All identities, QR material and messages below are synthetic. No socket or
// message is sent to WhatsApp by these tests.
const to = '5511999990000';
const target = to + '@s.whatsapp.net';
async function flush() { await tick(); await tick(); }
async function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaga-personal-'));
  const originalMask = process.umask();
  const sockets = [], sends = [], outputs = [], answers = [], statuses = [], timers = [], qrs = [];
  let saves = 0;
  const controller = new AbortController();
  const auth = {
    state: { creds: { me: { id: to + ':2@s.whatsapp.net', lid: '123456789@lid' } }, keys: { async set(value) { fs.writeFileSync(path.join(dataDir, 'whatsapp-session', 'keys.json'), JSON.stringify(value)); } } },
    async saveCreds() { saves++; fs.writeFileSync(path.join(dataDir, 'whatsapp-session', 'creds.json'), '{"fixture":true}'); },
  };
  const dependencies = {
    async loadAuth(directory) { assert.equal(directory, path.join(dataDir, 'whatsapp-session')); return auth; },
    makeSocket(config) {
      const socket = { ev: new EventEmitter(), user: { id: to + ':2@s.whatsapp.net', lid: '123456789@lid' }, ended: false,
        end() { this.ended = true; },
        async sendMessage(jid, message) { sends.push({ jid, ...message }); return { key: { id: 'out-' + sends.length } }; },
      };
      assert.equal(config.syncFullHistory, false);
      assert.equal(config.shouldSyncHistoryMessage(), false);
      assert.equal(config.shouldIgnoreJid('123@g.us'), true);
      sockets.push(socket); return socket;
    },
    renderQr(value, output) { qrs.push(value); output('[rendered QR fixture]'); },
    logger: {}, browser: ['Windows', 'Desktop', '10'],
  };
  const client = await startPersonalWhatsApp({
    dataDir, to, dependencies, signal: controller.signal,
    output: value => outputs.push(value),
    onAnswer: async value => { answers.push(value); return { accepted: true }; },
    onStatus: async value => statuses.push(value),
    schedule(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
    unschedule(timer) { if (timer) timer.cancelled = true; },
    ...options,
  });
  t.after(async () => { await client.close(); process.umask(originalMask); fs.rmSync(dataDir, { recursive: true, force: true }); });
  async function emit(event, value) { sockets.at(-1).ev.emit(event, value); await flush(); }
  async function open() { await emit('connection.update', { connection: 'open' }); }
  function message(id, text, key = {}, context) {
    return { key: { remoteJid: target, id, fromMe: true, ...key }, message: context ? { extendedTextMessage: { text, contextInfo: context } } : { conversation: text } };
  }
  return { client, dataDir, sockets, sends, outputs, answers, statuses, timers, qrs, controller, auth, emit, open, message, saves: () => saves };
}

test('QR somente é renderizado; conexão exige a conta pessoal configurada e preserva sessão privada', async t => {
  const h = await fixture(t);
  await assert.rejects(h.client.sendQuestion({ id: 'PROFILE_NAME', text: 'Nome?' }), { code: 'CONNECTION_REQUIRED' });
  await h.emit('connection.update', { qr: 'SYNTHETIC_NOT_A_REAL_QR' });
  assert.equal(h.client.getState().state, 'qr');
  assert.deepEqual(h.qrs, ['SYNTHETIC_NOT_A_REAL_QR']);
  assert.ok(!h.outputs.join('\n').includes('SYNTHETIC_NOT_A_REAL_QR'));
  await h.emit('creds.update', {});
  await h.auth.state.keys.set({ fixture: true });
  await h.open();
  assert.deepEqual(h.client.getState(), { state: 'connected', ready: true });
  assert.equal(await h.client.waitUntilReady({ timeoutMs: 5 }), true);
  const receipt = await h.client.sendQuestion({ id: 'PROFILE_NAME', text: 'Qual nome?' });
  assert.equal(receipt.verified, true);
  assert.equal(receipt.messageId, 'out-1');
  assert.equal(h.sends[0].jid, target);
  assert.match(h.sends[0].text, /PROFILE_NAME: sua resposta/);
  await h.client.close();
  assert.ok(h.saves() >= 2, 'Atualização de credenciais e encerramento persistem a sessão');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(h.dataDir, 'whatsapp-session')).mode & 0o777, 0o700);
    for (const name of ['keys.json', 'creds.json']) assert.equal(fs.statSync(path.join(h.dataDir, 'whatsapp-session', name)).mode & 0o777, 0o600);
  }
});

test('QR de outra conta bloqueia envio e encerra aquele socket', async t => {
  const h = await fixture(t);
  h.sockets[0].user.id = '5511888880000@s.whatsapp.net';
  await h.open();
  assert.equal(h.client.getState().state, 'account_mismatch');
  assert.equal(h.sockets[0].ended, true);
  assert.equal(await h.client.waitUntilReady({ timeoutMs: 10 }), false);
  await assert.rejects(h.client.sendQuestion({ id: 'TEST', text: 'Teste' }), { code: 'CONNECTION_REQUIRED' });
  assert.equal(h.sends.length, 0);
});

test('respostas próprias explícitas e citadas funcionam; outros chats, histórico e ecos do bot são ignorados', async t => {
  const h = await fixture(t); await h.open();
  await h.client.sendQuestion({ id: 'EMAIL', text: 'E-mail?' });
  await h.emit('messages.upsert', { type: 'notify', messages: [
    h.message('own-explicit', 'EMAIL: fixture@example.org'),
    h.message('own-quote', 'sim', {}, { stanzaId: 'out-1' }),
    h.message('lid-quote', 'não', { remoteJid: '123456789@lid' }, { stanzaId: 'out-1' }),
    h.message('foreign', 'EMAIL: wrong@example.org', { remoteJid: '5511888880000@s.whatsapp.net' }),
    h.message('group', 'EMAIL: wrong@example.org', { remoteJid: '123@g.us', remoteJidAlt: target }),
    h.message('other-sender', 'EMAIL: wrong@example.org', { fromMe: false }),
    h.message('out-1', 'EMAIL: wrong@example.org'),
    h.message('bot-copy', 'Vaga Radar — pergunta\nEMAIL: wrong@example.org'),
  ] });
  await h.emit('messages.upsert', { type: 'append', messages: [h.message('history', 'EMAIL: old@example.org')] });
  assert.deepEqual(h.answers.map(a => a.messageId), ['own-explicit', 'own-quote', 'lid-quote']);
  assert.equal(h.answers[0].questionId, 'EMAIL');
  assert.equal(h.answers[1].replyToMessageId, 'out-1');
  assert.equal(h.answers[2].answer, 'não');
});

test('comandos respondem uma vez no self-chat e IDs são persistidos para reinício', async t => {
  const commands = [];
  const h = await fixture(t, { onCommand: async text => { commands.push(text); return 'Vagas disponíveis'; } });
  await h.open();
  const command = h.message('command-1', 'vagas');
  await h.emit('messages.upsert', { type: 'notify', messages: [command, command] });
  assert.deepEqual(commands, ['vagas']);
  assert.equal(h.sends.length, 1);
  assert.match(h.sends[0].text, /^Vaga Radar — acompanhamento/);
  const saved = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'whatsapp-session', 'processed-commands.json'), 'utf8'));
  assert.deepEqual(saved, ['command-1']);
});

test('recibos do self-chat usam status real e ignoram recibos de outros contatos', async t => {
  const h = await fixture(t); await h.open();
  await h.emit('messages.update', [
    { key: { remoteJid: target, fromMe: true, id: 'out-1' }, update: { status: 3, messageTimestamp: 1700000000 } },
    { key: { remoteJid: target, fromMe: true, id: 'out-1' }, update: { status: 4 } },
    { key: { remoteJid: '123@g.us', fromMe: true, id: 'group' }, update: { status: 4 } },
  ]);
  assert.deepEqual(h.statuses.map(s => s.status), ['delivered', 'read']);
  assert.equal(h.statuses[0].recipient, to);
  assert.equal(h.statuses[0].phoneNumberId, null);
});

test('desconexão temporária reconecta; logout exige novo QR e abort cancela espera', async t => {
  const h = await fixture(t); await h.open();
  await h.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 408 } } } });
  assert.equal(h.client.getState().state, 'reconnecting');
  assert.equal(h.timers[0].delay, 1000);
  h.timers[0].callback(); await flush();
  assert.equal(h.sockets.length, 2);
  await h.open();
  await h.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
  assert.equal(h.client.getState().state, 'logged_out');
  assert.equal(h.timers.length, 1);
  const controller = new AbortController(); controller.abort();
  assert.equal(await h.client.waitUntilReady({ signal: controller.signal }), false);
  h.controller.abort(); await h.client.close();
  assert.equal(h.client.getState().state, 'stopped');
});

test('falha async em resposta é contida e cancelamento não envia outra mensagem', async t => {
  let called = 0;
  const h = await fixture(t, { onAnswer: async () => { called++; throw new Error('private-message-must-not-leak'); } });
  await h.open();
  await h.emit('messages.upsert', { type: 'notify', messages: [h.message('throw', 'EMAIL: fixture@example.org')] });
  assert.equal(called, 1);
  assert.ok(h.outputs.some(text => text.includes('não foi possível processar')));
  assert.ok(!h.outputs.join('\n').includes('private-message-must-not-leak'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.client.sendQuestion({ id: 'EMAIL', text: 'E-mail?' }, { signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(h.sends.length, 0);
});

test('reset remove apenas a sessão do bot e dependência real importa sem abrir conexão', async t => {
  const h = await fixture(t); await h.client.close();
  fs.writeFileSync(path.join(h.dataDir, 'keep.txt'), 'preserve');
  resetPersonalWhatsAppSession({ dataDir: h.dataDir });
  assert.equal(fs.existsSync(path.join(h.dataDir, 'whatsapp-session')), false);
  assert.equal(fs.readFileSync(path.join(h.dataDir, 'keep.txt'), 'utf8'), 'preserve');
  const baileys = await import('@whiskeysockets/baileys');
  assert.equal(typeof baileys.default, 'function');
  assert.equal(typeof baileys.useMultiFileAuthState, 'function');
  assert.equal(typeof baileys.Browsers.windows, 'function');
});
