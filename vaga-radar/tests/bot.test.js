import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { harness, normalizedJob } from "./helpers.js";
import { botConfigInput, applyBotConfig } from "../src/bot/config.js";
import {
  runBotCycle,
  recoverInterruptedSubmissions,
} from "../src/bot/worker.js";
import {
  acceptWhatsAppAnswer,
  applyQuestionAnswers,
} from "../src/bot/questions.js";
import { inWorkWindow } from "../src/bot/schedule.js";
import { acquireBotLock } from "../src/bot/lock.js";
import { SubmissionError } from "../src/submissions/lever.js";
import { extractResume } from "../src/resume/index.js";
import { openDatabase } from "../src/database/index.js";
import { createStore } from "../src/database/store.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// No HTTP server, real messaging service or real application is used here.
// Candidate identities and credentials below are synthetic test fixtures.
const originalFacts =
  "Pessoa Fictícia de Teste\nfixture@example.org\n\n" +
  "Empresa Fictícia Alfa — Desenvolvedor, 2020–2023.\n" +
  "Experiência declarada em JavaScript, Node.js e SQL.\n";
const dummyEnv = { VAGA_TEST_LEVER_KEY: "TEST_NOT_A_REAL_LEVER_KEY" };
const collector = {
  run: async () => ({
    status: "completed",
    received: 0,
    inserted: 0,
    errors: "[]",
  }),
};

test("encerrar ciclo antes do envio impede candidaturas e notificações", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const { config } = configure(h);
  const controller = new AbortController();
  controller.abort();
  let externalCalls = 0;
  const report = await runBotCycle(h.store, collector, config, {
    signal: controller.signal,
    submit: async () => {
      externalCalls++;
    },
    questionSender: async () => {
      externalCalls++;
    },
    env: dummyEnv,
  });
  assert.equal(externalCalls, 0);
  assert.equal(report.submitted, 0);
  assert.equal(report.prepared, 0);
});

test("CLI informa webhook sem credenciais sem rejeição assíncrona nem listener", (t) => {
  const h = harness();
  t.after(() => h.close());
  const filename = path.join(h.dataDir, "bot.json");
  fs.writeFileSync(filename, JSON.stringify({ dataDir: "data", sources: [] }));
  const env = { ...process.env };
  for (const name of [
    "VAGA_WHATSAPP_VERIFY_TOKEN",
    "VAGA_META_APP_SECRET",
    "VAGA_WHATSAPP_TO",
  ])
    delete env[name];
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../src/bot.js", import.meta.url)),
      "--config",
      filename,
      "--whatsapp-webhook",
    ],
    { env, encoding: "utf8", timeout: 20000 },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Webhook não iniciado/);
  assert.ok(!result.stderr.includes("UnhandledPromiseRejection"));
});

function configure(h, changes = {}) {
  const resumePath = path.join(h.dataDir, "original-fixture.txt");
  fs.writeFileSync(resumePath, originalFacts, { mode: 0o600 });
  const config = botConfigInput.parse({
    dataDir: h.dataDir,
    preferences: { minScore: 65 },
    workWindow: { enabled: false },
    sources: [],
    applicant: { email: "fixture@example.org", resumePath },
    profile: {
      name: "Pessoa Fictícia de Teste",
      summary: "Resumo de teste fornecido pelo candidato fictício.",
      skills: ["Node.js", "JavaScript", "SQL"].map((name) => ({
        name,
        verified: true,
      })),
    },
    autoApply: {
      enabled: true,
      sources: [
        {
          provider: "lever",
          board: "fixture",
          apiKeyEnv: "VAGA_TEST_LEVER_KEY",
          authorizationConfirmed: true,
        },
      ],
    },
    ...changes,
  });
  applyBotConfig(h.store, config);
  const job = h.store.upsertJob(
    normalizedJob({
      provider: "lever",
      board: "fixture",
      originalId: "fixture-posting-123",
      url: "https://jobs.lever.co/fixture/fixture-posting-123",
      applicationUrl: "https://jobs.lever.co/fixture/fixture-posting-123/apply",
    }),
  ).job;
  return { config, job };
}

function verifiedReceipt(input) {
  return {
    provider: "lever",
    applicationId: "fixture-receipt-123",
    board: input.board,
    postingId: input.postingId,
    submittedAt: new Date().toISOString(),
    verified: true,
  };
}

test("bot sem servidor prepara ATS real, confirma recibo autorizado e não duplica envio", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const { config, job } = configure(h);
  let submissions = 0;
  const submit = async (input) => {
    submissions++;
    assert.equal(input.fullName, "Pessoa Fictícia de Teste");
    assert.equal(input.email, "fixture@example.org");
    assert.equal(input.resume.subarray(0, 5).toString(), "%PDF-");
    assert.equal(input.apiKey, dummyEnv.VAGA_TEST_LEVER_KEY);
    return verifiedReceipt(input);
  };
  const report = await runBotCycle(h.store, collector, config, {
    env: dummyEnv,
    submit,
  });
  assert.equal(report.prepared, 1);
  assert.equal(report.submitted, 1);
  assert.equal(submissions, 1);
  const packet = JSON.parse(
    fs.readFileSync(path.join(h.dataDir, "outbox", `job-${job.id}.json`)),
  );
  assert.equal(packet.sent, true);
  assert.equal(packet.applicationId, "fixture-receipt-123");
  assert.ok(fs.readFileSync(packet.resumeText, "utf8").endsWith(originalFacts));
  const pdf = await extractResume(packet.resumePdf);
  assert.ok(pdf.text.includes("Empresa Fictícia Alfa"));
  assert.ok(pdf.text.includes("2020–2023"));
  assert.ok(
    !pdf.text.includes("Resumo de teste fornecido"),
    "O resumo do perfil não substitui fatos do currículo original",
  );
  const application = h.store.getApplication(1);
  assert.equal(application.status, "sent");
  assert.ok(application.sent_at);
  assert.equal(
    application.events.at(-1).note,
    "Envio confirmado pela API autorizada do Lever; recibo registrado no banco",
  );
  assert.equal(h.store.getJob(job.id).status, "sent");
  assert.equal(
    h.db.prepare("SELECT status FROM submission_attempts").get().status,
    "submitted",
  );
  await runBotCycle(h.store, collector, config, { env: dummyEnv, submit });
  assert.equal(
    submissions,
    1,
    "Executar de novo não duplica uma candidatura confirmada",
  );
});

test("bot com envio desativado ou sem credencial prepara arquivos sem chamar o conector", async (t) => {
  for (const disabled of [true, false]) {
    const h = harness();
    t.after(() => h.close());
    const { config } = configure(h);
    config.autoApply.enabled = !disabled;
    let called = 0;
    const report = await runBotCycle(h.store, collector, config, {
      env: {},
      submit: async () => {
        called++;
        throw new Error("Não deve enviar");
      },
    });
    assert.equal(called, 0);
    assert.equal(report.prepared, 1);
    assert.equal(report.submitted, 0);
    assert.ok(
      report.pending.some(
        (p) =>
          p.reason ===
          (disabled ? "AUTO_APPLY_DISABLED" : "PROVIDER_CREDENTIAL_REQUIRED"),
      ),
    );
    assert.equal(
      h.db.prepare("SELECT COUNT(*) AS n FROM submission_attempts").get().n,
      0,
    );
    assert.equal(h.store.getApplication(1).status, "prepared");
  }
});

test("resultado ambíguo fica durável e não é retentado após novo ciclo ou reinício", async (t) => {
  const h = harness({ persistent: true });
  let reopened;
  t.after(() => {
    h.collector.stop();
    if (h.db.open) h.db.close();
    if (reopened?.open) reopened.close();
    fs.rmSync(h.dataDir, { recursive: true, force: true });
  });
  const { config } = configure(h);
  let calls = 0;
  const submit = async () => {
    calls++;
    throw new SubmissionError("AMBIGUOUS", "Timeout simulado depois do POST");
  };
  const first = await runBotCycle(h.store, collector, config, {
    env: dummyEnv,
    submit,
  });
  assert.ok(first.pending.some((p) => p.reason === "AMBIGUOUS"));
  assert.equal(h.store.getApplication(1).sent_at, null);
  assert.equal(
    h.db.prepare("SELECT status FROM submission_attempts").get().status,
    "ambiguous",
  );
  await runBotCycle(h.store, collector, config, { env: dummyEnv, submit });
  assert.equal(calls, 1);

  // Simulate a process that stopped while a durable attempt still said sending.
  h.db.prepare("UPDATE submission_attempts SET status='sending'").run();
  h.db.close();
  reopened = openDatabase(path.join(h.dataDir, "radar.sqlite"));
  recoverInterruptedSubmissions(reopened);
  const row = reopened
    .prepare("SELECT status,error_code FROM submission_attempts")
    .get();
  assert.deepEqual(row, { status: "ambiguous", error_code: "INTERRUPTED" });
  const afterRestart = await runBotCycle(
    createStore(reopened),
    collector,
    config,
    { env: dummyEnv, submit },
  );
  assert.ok(
    afterRestart.pending.some((p) => p.reason === "PREVIOUS_AMBIGUOUS"),
  );
  assert.equal(
    calls,
    1,
    "Um reinício não transforma resultado desconhecido em nova candidatura",
  );
});

test("pergunta no WhatsApp falso aguarda resposta, deduplica mensagem e retoma com dados declarados", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const { config } = configure(h, {
    profile: {
      name: "",
      skills: ["Node.js", "JavaScript", "SQL"].map((name) => ({
        name,
        verified: true,
      })),
    },
    whatsapp: {
      enabled: true,
      phoneNumberId: "123456789",
      to: "5511999999999",
      accessTokenEnv: "VAGA_TEST_WHATSAPP_TOKEN",
    },
  });
  const env = {
    ...dummyEnv,
    VAGA_TEST_WHATSAPP_TOKEN: "TEST_NOT_A_REAL_META_TOKEN",
  };
  const notified = [];
  let submissions = 0;
  const questionSender = async (question, options) => {
    assert.equal(options.accessToken, env.VAGA_TEST_WHATSAPP_TOKEN);
    notified.push(question.id);
    return { verified: true, messageId: "wamid.fake-question" };
  };
  const submit = async (input) => {
    submissions++;
    assert.equal(input.fullName, "Nome Profissional Fictício Respondido");
    return verifiedReceipt(input);
  };
  const first = await runBotCycle(h.store, collector, config, {
    env,
    submit,
    questionSender,
  });
  assert.equal(first.submitted, 0);
  assert.equal(first.whatsapp.sent, 1);
  assert.deepEqual(notified, ["PROFILE_NAME"]);
  assert.ok(
    first.pending.some((p) => p.reason === "AWAITING_CANDIDATE_ANSWERS"),
  );
  const answer = {
    messageId: "wamid.fake-user-answer",
    questionId: "PROFILE_NAME",
    answer: "Nome Profissional Fictício Respondido",
  };
  assert.deepEqual(acceptWhatsAppAnswer(h.db, answer), { accepted: true });
  assert.deepEqual(acceptWhatsAppAnswer(h.db, answer), {
    accepted: false,
    reason: "duplicate",
  });
  assert.deepEqual(
    acceptWhatsAppAnswer(h.db, {
      ...answer,
      messageId: "wamid.fake-second-answer",
    }),
    { accepted: false, reason: "unknown_or_answered" },
  );
  const answeredConfig = applyQuestionAnswers(h.store, config);
  assert.equal(h.store.getProfile().name, answer.answer);
  const resumed = await runBotCycle(h.store, collector, answeredConfig, {
    env,
    submit,
    questionSender,
  });
  assert.equal(resumed.submitted, 1);
  assert.equal(submissions, 1);
  assert.deepEqual(
    notified,
    ["PROFILE_NAME"],
    "Não notifica novamente uma pergunta já respondida",
  );
  assert.equal(
    h.db.prepare("SELECT COUNT(*) AS n FROM whatsapp_inbound_messages").get().n,
    1,
  );
});

test("janela 08h–20h usa São Paulo com limites corretos e suporta virada da meia-noite", () => {
  const window = {
    enabled: true,
    startHour: 8,
    hours: 12,
    timeZone: "America/Sao_Paulo",
  };
  for (const [utc, expected] of [
    ["2026-10-28T10:59:59Z", false],
    ["2026-10-28T11:00:00Z", true],
    ["2026-10-28T22:59:59Z", true],
    ["2026-10-28T23:00:00Z", false],
  ])
    assert.equal(inWorkWindow(window, new Date(utc)), expected, utc);
  const overnight = { ...window, startHour: 22, hours: 4 };
  for (const [utc, expected] of [
    ["2026-10-29T00:59:59Z", false],
    ["2026-10-29T01:00:00Z", true],
    ["2026-10-29T04:59:59Z", true],
    ["2026-10-29T05:00:00Z", false],
  ])
    assert.equal(inWorkWindow(overnight, new Date(utc)), expected, utc);
  assert.equal(
    inWorkWindow(
      { ...window, enabled: false },
      new Date("2026-10-28T23:00:00Z"),
    ),
    true,
  );
  assert.equal(
    inWorkWindow({ ...window, hours: 24 }, new Date("2026-10-28T23:00:00Z")),
    true,
  );
});

test("lock do diretório impede segundo bot e libera exclusividade ao encerrar", (t) => {
  const h = harness();
  t.after(() => h.close());
  const release = acquireBotLock(h.dataDir);
  try {
    assert.throws(() => acquireBotLock(h.dataDir), /bot ativo/i);
    assert.ok(fs.existsSync(path.join(h.dataDir, "bot.lock")));
  } finally {
    release();
  }
  assert.equal(fs.existsSync(path.join(h.dataDir, "bot.lock")), false);
  const releaseSecond = acquireBotLock(h.dataDir);
  releaseSecond();
  assert.equal(fs.existsSync(path.join(h.dataDir, "bot.lock")), false);
});
