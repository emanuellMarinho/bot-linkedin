import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { createTerminalPrompt } from "../src/terminal/prompts.js";
import { prepareMessaging } from "../src/bot/startup.js";
import { botConfigInput } from "../src/bot/config.js";

// Child processes below never have a configured messaging credential or a job
// source. They exercise the actual executable entrypoint without external I/O.
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vaga-cli-ux-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "bot.config.json");
  const config = {
    setup: { completed: true, version: 1 },
    dataDir: "./data",
    sources: [],
    preferences: { collectionEnabled: false },
    workWindow: { enabled: false },
    notifications: { channel: "terminal", requireConnection: true },
    whatsapp: { enabled: false },
    ...overrides,
  };
  fs.writeFileSync(filename, JSON.stringify(config));
  const run = (...args) => spawnSync(process.execPath, ["src/bot.js", "--config", filename, ...args], {
    cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 30000,
    env: {
      ...process.env,
      VAGA_TEST_SMS_ACCOUNT_ABSENT: "",
      VAGA_TEST_SMS_AUTH_ABSENT: "",
    },
  });
  return { directory, filename, run, report: path.join(directory, "data", "reports", "latest.json") };
}

const smsConfig = {
  notifications: { channel: "sms", requireConnection: true },
  sms: {
    enabled: true,
    accountSidEnv: "VAGA_TEST_SMS_ACCOUNT_ABSENT",
    authTokenEnv: "VAGA_TEST_SMS_AUTH_ABSENT",
    from: "+12025550123",
    to: "+5511999990000",
  },
};

test("canal terminal explícito permite executar uma rodada local após a preparação", (t) => {
  const h = fixture(t);
  const result = h.run("--once");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(h.report), "Rodada real deve persistir o relatório");
  assert.equal(JSON.parse(fs.readFileSync(h.report, "utf8")).collection.status, "paused");
});

test("SMS sem credenciais bloqueia o trabalho e explica a pendência sem anunciar sucesso", (t) => {
  const h = fixture(t, smsConfig);
  const result = h.run("--once");
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /SMS|Twilio|credencia/i);
  assert.ok(!fs.existsSync(h.report), "Busca e preparação não podem começar antes do canal exigido");
  assert.doesNotMatch(result.stdout + result.stderr, /SMS conectado|SMS enviado|Ciclo concluído/i);
});

test("coleta isolada dispensa SMS e não cria uma sessão WhatsApp", (t) => {
  const h = fixture(t, smsConfig);
  const result = h.run("--once", "--collect-only");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.existsSync(h.report));
  assert.ok(!fs.existsSync(path.join(h.directory, "data", "whatsapp-session")));
});

test("validação assíncrona termina antes da próxima pergunta; entradas antecipadas não pulam a etapa", async () => {
  const input = new PassThrough();
  const chunks = [];
  const output = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  const prompt = createTerminalPrompt({ input, output });
  let release;
  const validated = new Promise((resolve) => { release = resolve; });
  let validationStarted = false;
  const first = prompt.ask("Validar currículo", {
    validate: async () => {
      validationStarted = true;
      await validated;
      return true;
    },
  });
  try {
    input.write("curriculo.txt\n");
    await tick();
    assert.equal(validationStarted, true);
    input.write("entrada antecipada\n\n");
    await tick();
    assert.doesNotMatch(chunks.join(""), /Próxima informação/);
    release();
    assert.equal(await first, "curriculo.txt");
    const next = prompt.ask("Próxima informação");
    input.write("resposta confirmada\n");
    assert.equal(await next, "resposta confirmada");
  } finally {
    release();
    prompt.close();
    input.destroy();
    output.destroy();
  }
});

function startupUI(events) {
  return {
    step: (...args) => events.push(["step", ...args]),
    status: (...args) => events.push(["status", ...args]),
    success: (text) => events.push(["success", text]),
    error: (text) => events.push(["error", text]),
    info: (text) => events.push(["info", text]),
    raw: (text) => events.push(["raw", text]),
    async withExclusive(action) {
      events.push(["exclusive-start"]);
      try { return await action(); }
      finally { events.push(["exclusive-end"]); }
    },
  };
}

test("início aguarda terminar o pareamento e mantém QR na etapa exclusiva", async () => {
  const events = [];
  let resolveReady;
  let completed = false;
  let waitStarted = false;
  const readiness = new Promise((resolve) => { resolveReady = resolve; });
  const sender = async () => {};
  const pending = prepareMessaging({
    config: botConfigInput.parse({ notifications: { channel: "whatsapp" }, whatsapp: { enabled: true, transport: "personal", to: "5511999990000" } }),
    db: {}, ui: startupUI(events),
    personalFactory: async ({ output }) => {
      output("QR FICTICIO RENDERIZADO");
      return {
        async waitUntilReady() { waitStarted = true; return readiness; },
        sendQuestion: sender,
        async close() { events.push(["close"]); },
      };
    },
  }).then((result) => { completed = true; return result; });
  await tick();
  assert.equal(waitStarted, true);
  assert.equal(completed, false, "Não pode liberar a busca enquanto a conta está conectando");
  assert.ok(events.find((entry) => entry[0] === "raw"));
  assert.ok(!events.some((entry) => entry[0] === "exclusive-end"));
  assert.ok(!events.some((entry) => entry[0] === "success"));
  resolveReady(true);
  const result = await pending;
  assert.equal(result.ready, true);
  assert.equal(result.questionSender, sender);
  assert.ok(events.findIndex((entry) => entry[0] === "raw") < events.findIndex((entry) => entry[0] === "exclusive-end"));
  await result.close();
});

test("falha de conexão é encerrada antes de oferecer terminal; fallback é explícito e utilizável", async () => {
  const events = [];
  const result = await prepareMessaging({
    config: botConfigInput.parse({ notifications: { channel: "whatsapp" }, whatsapp: { enabled: true, transport: "personal", to: "5511999990000" } }),
    db: {}, ui: startupUI(events), interactive: true,
    personalFactory: async () => ({
      async waitUntilReady() { return false; },
      async close() { events.push(["close-client"]); },
    }),
    promptFactory: () => ({
      async ask() { events.push(["fallback-choice"]); return "3"; },
      close() { events.push(["close-prompt"]); },
    }),
  });
  assert.equal(result.ready, true);
  assert.equal(result.channel, "terminal");
  assert.equal(result.notificationConfig.enabled, false);
  assert.ok(events.findIndex((entry) => entry[0] === "close-client") < events.findIndex((entry) => entry[0] === "fallback-choice"));
  assert.ok(!events.some((entry) => entry[0] === "success" && /WhatsApp conectado/.test(entry[1])));
  await result.close();
});

test("validação SMS pendente não anuncia canal pronto nem libera a próxima etapa", async () => {
  const events = [];
  let finishCheck;
  let completed = false;
  const checked = new Promise((resolve) => { finishCheck = resolve; });
  const pending = prepareMessaging({
    config: botConfigInput.parse(smsConfig), db: {}, ui: startupUI(events),
    smsFactory: async () => ({
      checkConnection: () => checked,
      sendQuestion: async () => {}, pollAnswers: async () => {}, close: async () => {},
    }),
  }).then((result) => { completed = true; return result; });
  await tick();
  assert.equal(completed, false);
  assert.ok(!events.some((entry) => entry[0] === "success"));
  finishCheck({ ready: false, issues: [{ code: "AUTHORIZATION", message: "Credencial de teste indisponível" }] });
  const result = await pending;
  assert.equal(result.ready, false);
  assert.ok(!events.some((entry) => entry[0] === "success"));
  await result.close();
});

test("trocar para SMS aguarda o assistente terminar antes de validar o provedor", async () => {
  const events = [];
  let finishConfiguration;
  let configuring = false;
  let checks = 0;
  const configured = new Promise((resolve) => { finishConfiguration = resolve; });
  const pending = prepareMessaging({
    config: botConfigInput.parse({ notifications: { channel: "whatsapp" }, whatsapp: { enabled: false } }),
    db: {}, ui: startupUI(events), interactive: true,
    promptFactory: () => ({ ask: async () => "2", close() {} }),
    configureSms: async () => { configuring = true; events.push(["configure-start"]); const result = await configured; events.push(["configure-end"]); return result; },
    smsFactory: async () => ({
      async checkConnection() { checks++; events.push(["check-sms"]); return { ready: true, issues: [] }; },
      sendQuestion: async () => {}, pollAnswers: async () => {}, close: async () => {},
    }),
  });
  await tick();
  assert.equal(configuring, true);
  assert.equal(checks, 0, "Não se valida nem envia com uma configuração parcial");
  finishConfiguration(botConfigInput.parse(smsConfig));
  const result = await pending;
  assert.equal(result.ready, true);
  assert.equal(result.channel, "sms");
  assert.equal(checks, 1);
  assert.ok(events.findIndex((entry) => entry[0] === "configure-end") < events.findIndex((entry) => entry[0] === "check-sms"));
  await result.close();
});
