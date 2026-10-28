import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { harness, normalizedJob } from "./helpers.js";
import { botConfigInput, applyBotConfig } from "../src/bot/config.js";
import { runBotCycle } from "../src/bot/worker.js";
import { planResume } from "../src/ai/openai.js";
import { submitLeverApplication } from "../src/submissions/lever.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, { jobs = 1, name = "Pessoa Fictícia", email = "fixture@example.org" } = {}) {
  const h = harness();
  t.after(() => h.close());
  const resumePath = path.join(h.dataDir, "resume.txt");
  fs.writeFileSync(resumePath, "Pessoa Fictícia\nEmpresa de teste — Desenvolvedor, 2021–2024.\nExperiência declarada em Node.js, JavaScript e SQL.\n");
  const config = botConfigInput.parse({
    dataDir: h.dataDir, sources: [], applicant: { resumePath, email },
    profile: { name, skills: ["Node.js", "JavaScript", "SQL"].map((name) => ({ name, verified: true })) },
    ai: { enabled: true, apiKeyEnv: "VAGA_TEST_AI" },
    autoApply: {
      enabled: true, maxPerRun: 2,
      sources: [{ provider: "lever", board: "fixture", apiKeyEnv: "VAGA_TEST_LEVER", authorizationConfirmed: true }],
    },
  });
  applyBotConfig(h.store, config);
  for (let i = 1; i <= jobs; i++) h.store.upsertJob(normalizedJob({
    provider: "lever", board: "fixture", originalId: `posting-${i}`,
    url: `https://jobs.lever.co/fixture/posting-${i}`,
    applicationUrl: `https://jobs.lever.co/fixture/posting-${i}/apply`,
  }));
  return { h, config, env: { VAGA_TEST_LEVER: "SYNTHETIC_LEVER_KEY", VAGA_TEST_AI: "SYNTHETIC_AI_KEY" } };
}

const collection = { status: "completed", received: 0, inserted: 0, errors: "[]" };
const plan = { skillOrder: ["Node.js"], questions: [], provider: "fixture" };
const receipt = (input) => ({ provider: "lever", board: input.board, postingId: input.postingId, applicationId: `fixture-${input.postingId}`, verified: true });

test("cada etapa aguarda a anterior: UI, busca, análise, envio de cada vaga e notificações", async (t) => {
  const { h, config, env } = fixture(t, { jobs: 2 });
  const uiGate = deferred(), collectionGate = deferred(), planGate = deferred(), submitGate = deferred(), notifyGate = deferred();
  const collectionStarted = deferred(), planStarted = deferred(), submitStarted = deferred(), notifyStarted = deferred();
  const events = [], analyzed = [], submitted = [];
  let collectionCalls = 0, finished = false;
  const controller = new AbortController();
  const run = runBotCycle(h.store, {
    async run() { collectionCalls++; collectionStarted.resolve(); return collectionGate.promise; },
  }, config, {
    env, signal: controller.signal,
    async onProgress(event) {
      events.push(event);
      if (event.stage === "collection" && event.status === "running") await uiGate.promise;
      if (event.stage === "complete") finished = true;
    },
    async aiPlanner(input, options) {
      assert.equal(options.signal, controller.signal);
      analyzed.push(input.job.id);
      if (analyzed.length === 1) { planStarted.resolve(); return planGate.promise; }
      return plan;
    },
    async submit(input, options) {
      assert.equal(options.signal, controller.signal);
      submitted.push(input);
      if (submitted.length === 1) { submitStarted.resolve(); await submitGate.promise; }
      return receipt(input);
    },
    notificationConfig: { transport: "sms", enabled: true },
    async notify(db, channel) {
      assert.equal(db, h.db);
      assert.equal(channel.transport, "sms");
      assert.equal(submitted.length, 2);
      notifyStarted.resolve();
      return notifyGate.promise;
    },
  });
  await tick();
  assert.equal(collectionCalls, 0, "A busca não começa enquanto a etapa visual aguarda conclusão");
  uiGate.resolve(); await collectionStarted.promise;
  assert.equal(analyzed.length, 0);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM submission_attempts").get().n, 0);
  collectionGate.resolve(collection); await planStarted.promise;
  assert.equal(submitted.length, 0, "A análise precisa terminar antes de preparar/enviar");
  assert.equal(fs.existsSync(path.join(h.dataDir, "tailored")), false);
  planGate.resolve(plan); await submitStarted.promise;
  assert.equal(analyzed.length, 1, "A segunda vaga só começa após a confirmação da primeira");
  assert.equal(events.some((event) => event.stage === "notifications"), false);
  submitGate.resolve(); await notifyStarted.promise;
  assert.equal(analyzed.length, 2);
  assert.equal(finished, false, "A rodada não é concluída com notificações em andamento");
  notifyGate.resolve({ acceptedThisRun: 1, sent: 1, pending: 0 });
  const report = await run;
  assert.equal(report.submitted, 2);
  assert.equal(report.notifications.acceptedThisRun, 1);
  assert.deepEqual(report.whatsapp, report.notifications, "Compatibilidade dos relatórios anteriores");
  assert.equal(finished, true);
});

test("cancelamento durante análise impede preparação, candidatura e notificação seguintes", async (t) => {
  const { h, config, env } = fixture(t, { jobs: 2 });
  const started = deferred();
  const controller = new AbortController();
  let analyzed = 0, submissions = 0, notifications = 0;
  const run = runBotCycle(h.store, { run: async () => collection }, config, {
    env, signal: controller.signal,
    aiPlanner: async (input, options) => {
      analyzed++; started.resolve();
      return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "AI_CANCELLED" })), { once: true }));
    },
    submit: async () => { submissions++; },
    notify: async () => { notifications++; },
  });
  await started.promise;
  controller.abort();
  const report = await run;
  assert.equal(analyzed, 1);
  assert.equal(submissions, 0);
  assert.equal(notifications, 0);
  assert.equal(report.prepared, 0);
  assert.equal(fs.existsSync(path.join(h.dataDir, "tailored")), false);
});

test("dados de contato pendentes são perguntados antes de usar GPT ou preparar candidatura", async (t) => {
  const { h, config, env } = fixture(t, { name: "", email: "" });
  let analyzed = 0, submitted = 0;
  const report = await runBotCycle(h.store, { run: async () => collection }, config, {
    env,
    aiPlanner: async () => { analyzed++; return plan; },
    submit: async () => { submitted++; },
    notify: async (db) => ({ pending: db.prepare("SELECT COUNT(*) AS n FROM bot_questions WHERE answer IS NULL").get().n }),
  });
  assert.equal(analyzed, 0);
  assert.equal(submitted, 0);
  assert.equal(report.prepared, 0);
  assert.equal(report.notifications.pending, 2);
  assert.ok(report.pending.some((row) => row.reason === "AWAITING_CANDIDATE_ANSWERS"));
});

test("cancelamento prévio impede até a coleta e não avança etapas", async (t) => {
  const { h, config } = fixture(t);
  let called = 0;
  const report = await runBotCycle(h.store, { run: async () => { called++; return collection; } }, config, {
    signal: AbortSignal.abort(), onProgress: async () => { called++; }, notify: async () => { called++; },
  });
  assert.equal(called, 0);
  assert.equal(report.collection.status, "cancelled");
});

test("formulário usa o telefone SMS escolhido quando não há número WhatsApp", async (t) => {
  const { h, config, env } = fixture(t);
  config.autoApply.mode = "browser";
  config.notifications = { channel: "sms" };
  config.sms = { to: "+5511888880000" };
  config.whatsapp.to = "";
  let phone;
  const report = await runBotCycle(h.store, { run: async () => collection }, config, {
    env, aiPlanner: async () => plan,
    browserSubmit: async (input) => {
      phone = input.phone;
      return { pendingQuestions: [{ key: "salary", label: "Pretensão salarial", options: [] }] };
    },
    notify: async () => ({ pending: 1 }),
  });
  assert.equal(phone, "5511888880000");
  assert.equal(report.submitted, 0);
  assert.ok(report.pending.some((row) => row.reason === "AWAITING_FORM_ANSWERS"));
});

test("clientes GPT/Lever respeitam sinal antes da rede; cancelamento durante POST Lever permanece ambíguo", async () => {
  let calls = 0;
  await assert.rejects(planResume({}, { enabled: true, signal: AbortSignal.abort(), fetcher: () => { calls++; } }), { code: "AI_CANCELLED" });
  await assert.rejects(submitLeverApplication({}, { signal: AbortSignal.abort(), fetcher: () => { calls++; } }), { code: "CANCELLED" });
  assert.equal(calls, 0);
  const controller = new AbortController();
  await assert.rejects(submitLeverApplication({
    board: "fixture", postingId: "posting", apiKey: "SYNTHETIC_KEY", fullName: "Pessoa Fictícia", email: "fixture@example.org",
    resume: Buffer.from("Currículo fictício"), resumeName: "resume.txt",
  }, {
    signal: controller.signal,
    fetcher: async (url, options) => {
      calls++; controller.abort();
      assert.equal(options.signal.aborted, true);
      throw new Error("aborted after dispatch");
    },
  }), { code: "AMBIGUOUS" });
  assert.equal(calls, 1);
});
