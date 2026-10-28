import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import request from "supertest";
import { openDatabase } from "../src/database/index.js";
import {
  askQuestion, acceptWhatsAppAnswer, notifyQuestions,
  getWhatsAppStatus, recordWhatsAppStatus,
} from "../src/bot/questions.js";
import { createWhatsAppWebhook } from "../src/messaging/webhook.js";
import { recoverInterruptedSubmissions } from "../src/bot/worker.js";

const config = {
  enabled: true, phoneNumberId: "12345678901", to: "5511999999999",
  accessTokenEnv: "TEST_TOKEN", templateName: "vaga_radar_duvida",
};
const env = { TEST_TOKEN: "TEST_NOT_REAL" };
const receipt = { verified: true, messageId: "wamid.test-delivery" };
const fixture = (t, id = "EMAIL", topic = "email") => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  askQuestion(db, { id, topic, text: "Qual é o seu e-mail?" });
  return db;
};
const notification = (db, id = "EMAIL") => db.prepare("SELECT * FROM bot_questions WHERE id=?").get(id);
const send = (db, options = {}, configuration = config) =>
  notifyQuestions(db, configuration, { env, sender: async () => receipt, ...options });
const status = (db, value, options = {}) => recordWhatsAppStatus(db, {
  messageId: receipt.messageId, status: value, recipient: config.to,
  phoneNumberId: config.phoneNumberId, timestamp: "1793102400", ...options,
});

test("banco anterior migra sem perder respostas e reabrir não repete migração", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vaga-whatsapp-migration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, "old.sqlite");
  const old = new Database(filename);
  old.exec("CREATE TABLE migrations(version TEXT PRIMARY KEY,applied_at TEXT NOT NULL)");
  for (const migration of ["001_initial.sql", "002_bot.sql", "003_questions.sql"]) {
    old.exec(fs.readFileSync(new URL(`../src/database/migrations/${migration}`, import.meta.url), "utf8"));
    old.prepare("INSERT INTO migrations VALUES (?,?)").run(migration, new Date().toISOString());
  }
  old.prepare(
    "INSERT INTO bot_questions(id,topic,text,created_at,notification_status,notification_error,answer) VALUES (?,?,?,?,?,?,?)",
  ).run("OLD_SENT", "email", "Email?", new Date().toISOString(), "sent", null, "fixture@example.org");
  old.prepare(
    "INSERT INTO bot_questions(id,topic,text,created_at,notification_status,notification_error) VALUES (?,?,?,?,?,?)",
  ).run("OLD_REJECTED", "name", "Name?", new Date().toISOString(), "ambiguous", "AUTHORIZATION");
  old.close();
  for (let i = 0; i < 2; i++) {
    const migrated = openDatabase(filename);
    try {
      assert.equal(notification(migrated, "OLD_SENT").answer, "fixture@example.org");
      assert.equal(notification(migrated, "OLD_SENT").notification_status, "accepted");
      assert.equal(notification(migrated, "OLD_REJECTED").notification_status, "failed");
      assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM migrations WHERE version='004_whatsapp_delivery.sql'").get().n, 1);
    } finally { migrated.close(); }
  }
});

test("receipt da API fica aceito até callback de entrega; callbacks atrasados não regridem leitura", async (t) => {
  const db = fixture(t);
  const first = await send(db);
  assert.equal(first.acceptedThisRun, 1);
  assert.equal(first.accepted, 1);
  assert.equal(first.delivered, 0);
  assert.equal(notification(db).notification_status, "accepted");
  assert.equal(status(db, "sent").accepted, true);
  assert.equal(notification(db).notification_status, "accepted");
  assert.equal(status(db, "delivered", { timestamp: "1793102401" }).accepted, true);
  assert.equal(status(db, "read", { timestamp: "1793102402" }).accepted, true);
  assert.equal(status(db, "sent", { timestamp: "1793102403" }).accepted, false);
  assert.equal(status(db, "failed", { timestamp: "1793102404" }).accepted, false);
  assert.equal(status(db, "delivered").accepted, false);
  assert.equal(getWhatsAppStatus(db).read, 1);
  assert.ok(notification(db).notification_delivered_at);
  assert.ok(notification(db).notification_read_at);
});

test("falha de entrega é persistida sem texto privado e exige mudança real antes de reenvio", async (t) => {
  const db = fixture(t);
  await send(db);
  assert.equal(status(db, "failed", { errorCode: 131026 }).accepted, true);
  assert.equal(notification(db).notification_error, "DELIVERY_FAILED");
  assert.equal(notification(db).notification_provider_code, "131026");
  let calls = 0;
  const sender = async () => { calls++; return receipt; };
  await send(db, { sender });
  assert.equal(calls, 0);
  await send(db, { sender }, { ...config, templateName: "template_corrigido" });
  assert.equal(calls, 1);
});

test("callback recebido antes do receipt HTTP é reconciliado sem perder confirmação de entrega", async (t) => {
  const db = fixture(t);
  await send(db, { sender: async () => {
    assert.equal(status(db, "delivered").reason, "awaiting_receipt");
    return receipt;
  } });
  assert.equal(notification(db).notification_status, "delivered");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM whatsapp_status_events").get().n, 0);
});

test("callbacks só atualizam recibo conhecido do destinatário e conta configurados", async (t) => {
  const db = fixture(t);
  await send(db);
  for (const override of [
    { recipient: "5511888888888" },
    { phoneNumberId: "99999999999" },
    { phoneNumberId: undefined },
    { messageId: "wamid.unknown" },
    { timestamp: "not-a-date" },
    { status: "not-a-status" },
  ]) assert.equal(status(db, "delivered", override).accepted, false);
  assert.equal(notification(db).notification_status, "accepted");
  status(db, "failed", { errorCode: "private-provider-text" });
  assert.equal(notification(db).notification_provider_code, null);
});

test("resposta nativa citando mensagem resolve somente pergunta conhecida ainda aberta", async (t) => {
  const db = fixture(t);
  await send(db);
  for (const input of [
    { replyToMessageId: "wamid.unknown", answer: "person@example.org" },
    { replyToMessageId: receipt.messageId, questionId: "DIFFERENT", answer: "person@example.org" },
    { replyToMessageId: receipt.messageId, answer: "invalid-email" },
  ]) assert.equal(acceptWhatsAppAnswer(db, { messageId: "wamid.answer-invalid", ...input }).accepted, false);
  const answer = { messageId: "wamid.answer", replyToMessageId: receipt.messageId, answer: "person@example.org" };
  assert.equal(acceptWhatsAppAnswer(db, answer).accepted, true);
  assert.equal(acceptWhatsAppAnswer(db, answer).accepted, false);
  assert.equal(notification(db).answer, "person@example.org");
});

test("rejeições definitivas não são ambíguas e recuperam somente após alterar configuração", async (t) => {
  for (const code of ["AUTHORIZATION", "CONFIGURATION", "REJECTED"]) {
    const db = fixture(t, code);
    let calls = 0;
    const sender = async () => { calls++; throw Object.assign(new Error("sensitive"), { code }); };
    await send(db, { sender });
    assert.equal(notification(db, code).notification_status, "failed");
    await send(db, { sender });
    assert.equal(calls, 1);
    const recovered = await send(db, { env: { TEST_TOKEN: "NEW_TEST_NOT_REAL" } });
    assert.equal(recovered.acceptedThisRun, 1);
    assert.equal(notification(db, code).notification_attempts, 1);
    assert.deepEqual(recovered.errors, []);
  }
});

test("rate limit usa backoff persistido de 60/120s e para após três tentativas", async (t) => {
  const db = fixture(t);
  let instant = 1000000, calls = 0;
  const options = {
    clock: () => instant,
    sender: async () => { calls++; throw Object.assign(new Error("limit"), { code: "RATE_LIMIT" }); },
  };
  await send(db, options);
  assert.equal(notification(db).notification_next_attempt_at, instant + 60000);
  instant += 59999;
  await send(db, options);
  assert.equal(calls, 1);
  instant++;
  await send(db, options);
  assert.equal(notification(db).notification_next_attempt_at, instant + 120000);
  instant += 120000;
  await send(db, options);
  assert.equal(notification(db).notification_status, "failed");
  instant += 3600000;
  await send(db, options);
  assert.equal(calls, 3);
});

test("timeout ou interrupção fica ambíguo e não reenvia mesmo após trocar token", async (t) => {
  const db = fixture(t);
  await send(db, { sender: async () => { throw new Error("unknown-secret-error"); } });
  assert.equal(notification(db).notification_error, "WHATSAPP_AMBIGUOUS");
  let calls = 0;
  await send(db, { env: { TEST_TOKEN: "CHANGED" }, sender: async () => { calls++; return receipt; } });
  assert.equal(calls, 0);
  db.prepare("UPDATE bot_questions SET notification_status='sending'").run();
  recoverInterruptedSubmissions(db);
  assert.equal(notification(db).notification_error, "INTERRUPTED");
  await send(db, { sender: async () => { calls++; return receipt; } });
  assert.equal(calls, 0);
});

test("cancelamento durante lote impede próximas mensagens e cancelamento antes da rede preserva fila", async (t) => {
  const db = fixture(t, "A");
  askQuestion(db, { id: "B", topic: "name", text: "Nome?" });
  const controller = new AbortController();
  let calls = 0;
  await send(db, {
    signal: controller.signal,
    sender: async (question, options) => {
      assert.equal(options.signal, controller.signal);
      calls++; controller.abort(); return receipt;
    },
  });
  assert.equal(calls, 1);
  assert.equal(notification(db, "B").notification_status, "pending");
  await send(db, { sender: async () => { throw Object.assign(new Error("cancelled"), { code: "CANCELLED" }); } });
  assert.equal(notification(db, "B").notification_attempts, 0);
  assert.equal(notification(db, "B").notification_status, "pending");
});

test("polls concorrentes reivindicam uma pergunta uma vez", async (t) => {
  const db = fixture(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const sender = async () => { calls++; await gate; return receipt; };
  const first = send(db, { sender });
  await send(db, { sender });
  release();
  await first;
  assert.equal(calls, 1);
});

test("teste explícito envia somente sua pergunta e rotina exclui testes pendentes", async (t) => {
  const db = fixture(t);
  askQuestion(db, { id: "WHATSAPP_TEST_fixture", topic: "whatsapp_test", text: "Responda OK" });
  const calls = [];
  const sender = async (question) => { calls.push(question.id); return { ...receipt, messageId: `wamid.${question.id}` }; };
  await send(db, { questionId: "WHATSAPP_TEST_fixture", sender });
  assert.deepEqual(calls, ["WHATSAPP_TEST_fixture"]);
  askQuestion(db, { id: "WHATSAPP_TEST_old", topic: "whatsapp_test", text: "Responda OK" });
  await send(db, { sender });
  assert.deepEqual(calls, ["WHATSAPP_TEST_fixture", "EMAIL"]);
  assert.equal(notification(db, "WHATSAPP_TEST_old").notification_attempts, 0);
  assert.equal(getWhatsAppStatus(db).pending, 1);
  assert.equal(getWhatsAppStatus(db, { includeDiagnostics: true }).pending, 3);
});

test("transporte pessoal usa remetente conectado sem credenciais Cloud e retoma após reconectar", async (t) => {
  const db = fixture(t);
  const personal = { enabled: true, transport: "personal", to: config.to };
  let instant = 0;
  await send(db, {
    clock: () => instant,
    sender: async () => { throw Object.assign(new Error("offline"), { code: "CONNECTION_REQUIRED" }); },
  }, personal);
  assert.equal(notification(db).notification_status, "pending");
  assert.equal(notification(db).notification_attempts, 0);
  instant += 60000;
  await send(db, { clock: () => instant, sender: async () => ({ verified: true, messageId: "WEB_MESSAGE_ID" }) }, personal);
  assert.equal(notification(db).notification_phone_number_id, null);
  assert.equal(recordWhatsAppStatus(db, {
    messageId: "WEB_MESSAGE_ID", recipient: personal.to, status: "delivered", timestamp: "1793102400",
  }).accepted, true);
  assert.equal(acceptWhatsAppAnswer(db, {
    messageId: "WEB_REPLY_ID", replyToMessageId: "WEB_MESSAGE_ID", answer: "person@example.org",
  }).accepted, true);
});

test("webhook integrado valida conta, persiste entrega e aceita resposta citada autenticada", async (t) => {
  const db = fixture(t);
  await send(db);
  const secret = "FAKE_LOCAL_APP_SECRET_FOR_TEST";
  const app = createWhatsAppWebhook({
    verifyToken: "FAKE_VERIFY_TOKEN_FOR_TEST", appSecret: secret,
    phoneNumberId: config.phoneNumberId, allowedSender: config.to,
    onAnswer: (answer) => acceptWhatsAppAnswer(db, answer),
    onStatus: (update) => recordWhatsAppStatus(db, update),
  });
  const post = async (value) => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [null, {
      changes: [null, { field: "messages", value: { messaging_product: "whatsapp", ...value } }],
    }] });
    return request(app).post("/webhook").type("application/json")
      .set("x-hub-signature-256", "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex"))
      .send(body).expect(200);
  };
  const delivery = { id: receipt.messageId, status: "delivered", recipient_id: config.to, timestamp: "1793102400" };
  const reply = { id: "wamid.webhook-reply", from: config.to, type: "text", context: { id: receipt.messageId }, text: { body: "person@example.org" } };
  await post({ metadata: { phone_number_id: "99999999999" }, statuses: [delivery], messages: [reply] });
  assert.equal(notification(db).notification_status, "accepted");
  assert.equal(notification(db).answer, null);
  await post({ metadata: { phone_number_id: config.phoneNumberId }, statuses: [null, delivery], messages: [null, reply] });
  assert.equal(notification(db).notification_status, "delivered");
  assert.equal(notification(db).answer, "person@example.org");
  assert.equal(getWhatsAppStatus(db).answered, 1);
});
