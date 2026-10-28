import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { startSmsMessaging, inspectSmsConfig } from "../src/messaging/sms.js";
import { harness } from "./helpers.js";
import { askQuestion, acceptCandidateAnswer, recordWhatsAppStatus } from "../src/bot/questions.js";
import { notificationConfigFor } from "../src/bot/startup.js";
import { verifyWhatsAppRoundTrip } from "../src/messaging/verify.js";

// Synthetic local fixtures only. No real phone number, token or SMS is used.
const sid = "AC" + "a".repeat(32);
const authToken = "SYNTHETIC_LOCAL_TOKEN_NOT_A_CREDENTIAL";
const env = { VAGA_TWILIO_ACCOUNT_SID: sid, VAGA_TWILIO_AUTH_TOKEN: authToken };
const config = { enabled: true, from: "+15550000001", to: "+5511999990000", pollIntervalSeconds: 15 };
const id = (n = 1) => "SM" + n.toString(16).padStart(32, "0");
const question = { id: "APPLICANT_EMAIL", text: "Qual e-mail profissional?" };
const outgoing = (overrides = {}) => ({ sid: id(), account_sid: sid, from: config.from, to: config.to, status: "queued", ...overrides });
const incoming = (overrides = {}) => ({ sid: id(2), account_sid: sid, from: config.to, to: config.from, direction: "inbound", body: "APPLICANT_EMAIL: fixture@example.org", date_sent: new Date().toUTCString(), ...overrides });

test("teste SMS completo usa referência curta, recebe resposta por polling e não envia a fila de vagas", async (t) => {
  let reference;
  const { client, h, calls } = await fixture(t, { fetcher(url, request) {
    if (request.method === "POST") {
      reference = new URLSearchParams(request.body).get("Body").match(/Q[A-F0-9]{8}/)?.[0];
      return Response.json(outgoing());
    }
    if (url.includes("/Messages/SM")) return Response.json(outgoing({ status: "delivered", date_updated: new Date().toUTCString() }));
    return Response.json({ messages: [incoming({ body: `${reference}: OK` })] });
  } });
  askQuestion(h.db, { id: "JOB_UNRELATED", topic: "job", text: "Outra pergunta da vaga" });
  assert.equal((await client.checkConnection()).ready, true);
  const outputs = [];
  const result = await verifyWhatsAppRoundTrip(h.db, notificationConfigFor({ notifications: { channel: "sms" }, sms: {
    ...config, accountSidEnv: "VAGA_TWILIO_ACCOUNT_SID", authTokenEnv: "VAGA_TWILIO_AUTH_TOKEN",
  } }), { sender: client.sendQuestion, poll: client.pollAnswers, env, output: (line) => outputs.push(line), timeoutMs: 1000 });
  assert.equal(result.ok, true);
  assert.match(result.questionId, /^SMS_TEST_/);
  assert.equal(h.db.prepare("SELECT answer FROM bot_questions WHERE id=?").get(result.questionId).answer, "OK");
  assert.equal(h.db.prepare("SELECT notification_status FROM bot_questions WHERE id='JOB_UNRELATED'").get().notification_status, "pending");
  assert.equal(calls.filter((call) => call.request.method === "POST").length, 1);
  assert.match(outputs.join("\n"), /Resposta recebida pelo SMS/);
});

function preflight(url) {
  if (url.endsWith(`${sid}.json`)) return Response.json({ sid, status: "active" });
  if (url.includes("/IncomingPhoneNumbers.json")) return Response.json({ incoming_phone_numbers: [{ account_sid: sid, phone_number: config.from, capabilities: { SMS: true } }] });
  return null;
}
async function fixture(t, options = {}) {
  const calls = [];
  const h = harness();
  t.after(() => h.close());
  const fetcher = async (url, request) => {
    calls.push({ url, request });
    const standard = preflight(url);
    if (standard) return standard;
    if (options.fetcher) return options.fetcher(url, request);
    if (request.method === "POST") return Response.json(outgoing());
    return Response.json({ messages: [] });
  };
  const client = await startSmsMessaging({
    db: h.db, config, env, onAnswer: (input) => acceptCandidateAnswer(h.db, input),
    onStatus: (input) => recordWhatsAppStatus(h.db, input), ...options, fetcher,
  });
  t.after(() => client.close());
  return { client, calls, h };
}

test("SMS ausente identifica conta, remetente e celular sem rede nem valores privados", async () => {
  const report = inspectSmsConfig({}, { env: {} });
  assert.equal(report.ready, false);
  assert.ok(report.issues.some((issue) => issue.code === "SMS_ACCOUNT_REQUIRED"));
  const client = await startSmsMessaging({ config: {}, env: {}, fetcher() { throw new Error("Unexpected network"); } });
  const check = await client.checkConnection();
  assert.equal(check.ready, false);
  await assert.rejects(client.sendQuestion(question), { code: "CONNECTION_REQUIRED" });
  await client.close();
  assert.ok(!JSON.stringify(report).includes(authToken));
});

test("SMS só fica conectado após validar conta ativa e número SMS próprio; check não envia", async (t) => {
  const { client, calls } = await fixture(t);
  assert.deepEqual(client.getState(), { state: "disconnected", ready: false });
  assert.equal((await client.checkConnection()).ready, true);
  assert.deepEqual(client.getState(), { state: "connected", ready: true });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.request.method === "GET"));
  assert.ok(calls.every((call) => call.request.redirect === "error"));
  assert.equal(calls[0].request.headers.Authorization, `Basic ${Buffer.from(`${sid}:${authToken}`).toString("base64")}`);
});

test("SMS envia uma vez com referência curta persistida antes do envio; receipt representa aceitação", async (t) => {
  const { client, calls, h } = await fixture(t);
  await client.checkConnection();
  const receipt = await client.sendQuestion(question);
  assert.equal(receipt.provider, "sms");
  assert.equal(receipt.messageId, "sms:" + id());
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.verified, true);
  const sends = calls.filter((call) => call.request.method === "POST");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].url, `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`);
  const body = new URLSearchParams(sends[0].request.body);
  assert.equal(body.get("From"), config.from);
  assert.equal(body.get("To"), config.to);
  const reference = body.get("Body").match(/(Q[A-F0-9]{8}): sua resposta/)?.[1];
  assert.ok(reference);
  assert.ok(!body.get("Body").includes("APPLICANT_EMAIL"));
  const mapping = h.db.prepare("SELECT value FROM settings WHERE key=?").get(`sms_question:${reference}`);
  assert.equal(JSON.parse(mapping.value).questionId, question.id);
  assert.ok(!body.get("Body").includes(authToken));
});

test("SMS resolve referência curta sem diferenciar maiúsculas e preserva compatibilidade com ID completo", async (t) => {
  let body = "";
  const { client, h, calls } = await fixture(t, { fetcher(url, request) {
    if (request.method === "POST") return Response.json(outgoing());
    if (url.includes("/Messages/SM")) return Response.json(outgoing({ status: "queued" }));
    return Response.json({ messages: [incoming({ body })] });
  } });
  askQuestion(h.db, { ...question, topic: "email" });
  await client.checkConnection();
  await client.sendQuestion(question);
  const sent = calls.find((call) => call.request.method === "POST");
  const reference = new URLSearchParams(sent.request.body).get("Body").match(/(Q[A-F0-9]{8}):/)?.[1];
  body = `${reference.toLowerCase()}: fixture@example.org`;
  assert.equal((await client.pollAnswers()).accepted, 1);
  assert.equal(h.db.prepare("SELECT answer FROM bot_questions WHERE id=?").get(question.id).answer, "fixture@example.org");
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM whatsapp_inbound_messages").get().n, 1);
  // The earlier poll test exercises the legacy APPLICANT_EMAIL: response path.
});

test("resposta SMS válida resolve pergunta conhecida; outros remetentes, histórico e duplicatas não alteram dados", async (t) => {
  let polls = 0;
  const current = Date.now();
  const { client, h } = await fixture(t, {
    clock: () => current + polls * 15000,
    fetcher(url) {
      polls++;
      assert.equal(new URL(url).searchParams.get("From"), config.to);
      return Response.json({ messages: [
        incoming(), incoming({ sid: id(3), from: "+15550000002" }),
        incoming({ sid: id(4), direction: "outbound-api" }),
        incoming({ sid: id(5), body: "UNKNOWN: answer" }),
        incoming({ sid: id(6), date_sent: new Date(current - 8 * 86400000).toUTCString() }),
      ] });
    },
  });
  askQuestion(h.db, { ...question, topic: "email" });
  await client.checkConnection();
  assert.equal((await client.pollAnswers()).accepted, 1);
  assert.equal(h.db.prepare("SELECT answer FROM bot_questions").get().answer, "fixture@example.org");
  assert.equal((await client.pollAnswers()).accepted, 0);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM whatsapp_inbound_messages").get().n, 1);
});

test("SMS consulta delivery e persiste entregue sem confundir aceite com resposta", async (t) => {
  const { client, h } = await fixture(t, { fetcher(url) {
    if (url.endsWith(`/Messages/${id()}.json`)) return Response.json(outgoing({ status: "delivered", date_updated: new Date().toUTCString() }));
    return Response.json({ messages: [] });
  } });
  askQuestion(h.db, { ...question, topic: "email" });
  h.db.prepare("UPDATE bot_questions SET notification_id=?,notification_status='accepted',notification_recipient=?").run("sms:" + id(), config.to.slice(1));
  await client.checkConnection();
  await client.pollAnswers();
  const row = h.db.prepare("SELECT answer,notification_status FROM bot_questions").get();
  assert.equal(row.notification_status, "delivered");
  assert.equal(row.answer, null);
});

test("SMS contém erros de autorização/rate limit e não retenta resultado inconclusivo", async (t) => {
  for (const [status, code] of [[401, "AUTHORIZATION"], [429, "RATE_LIMIT"], [500, "AMBIGUOUS"]]) {
    const { client, calls } = await fixture(t, { fetcher() { return Response.json({ code: 12345, message: "PRIVATE_PROVIDER_TEXT" }, { status }); } });
    await client.checkConnection();
    await assert.rejects(client.sendQuestion(question), (error) => {
      assert.equal(error.code, code);
      assert.ok(!error.message.includes("PRIVATE_PROVIDER_TEXT"));
      return true;
    });
    assert.equal(calls.filter((call) => call.request.method === "POST").length, 1);
  }
});

test("timeout, receipt errado e cancelamento após POST nunca geram reenvio automático", async (t) => {
  const controller = new AbortController();
  const { client, calls } = await fixture(t, { fetcher(url, request) {
    return new Promise((resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("PRIVATE_CANCEL_TEXT")), { once: true }));
  } });
  await client.checkConnection();
  const pending = client.sendQuestion(question, { signal: controller.signal });
  await tick();
  controller.abort();
  await assert.rejects(pending, { code: "AMBIGUOUS" });
  assert.equal(calls.filter((call) => call.request.method === "POST").length, 1);
  const malformed = await fixture(t, { fetcher() { return Response.json(outgoing({ sid: "not-a-message" })); } });
  await malformed.client.checkConnection();
  await assert.rejects(malformed.client.sendQuestion(question), { code: "AMBIGUOUS" });
});

test("poll tem limite de frequência, não segue paginação externa e não sobrepõe envio", async (t) => {
  let release;
  const current = Date.now();
  const { client, calls } = await fixture(t, { clock: () => current, fetcher(url, request) {
    if (request.method === "POST") return new Promise((resolve) => { release = () => resolve(Response.json(outgoing())); });
    return Response.json({ messages: [], next_page_uri: "https://example.org/private" });
  } });
  await client.checkConnection();
  const send = client.sendQuestion(question);
  await tick();
  const poll = client.pollAnswers();
  assert.equal(calls.length, 3, "A leitura aguarda o envio terminar");
  release(); await send; await poll;
  assert.equal(calls.length, 4);
  assert.equal((await client.pollAnswers()).skipped, true);
  assert.equal(calls.length, 4);
});

test("conta suspensa, número sem SMS e cancelamento prévio não liberam envio", async (t) => {
  for (const state of ["suspended", "no-sms"]) {
    const client = await startSmsMessaging({ config, env, fetcher: async (url) =>
      url.endsWith(`${sid}.json`) ? Response.json({ sid, status: state === "suspended" ? "suspended" : "active" })
        : Response.json({ incoming_phone_numbers: [{ phone_number: config.from, capabilities: { SMS: false } }] }) });
    t.after(() => client.close());
    assert.equal((await client.checkConnection()).ready, false);
    await assert.rejects(client.sendQuestion(question), { code: "CONNECTION_REQUIRED" });
  }
  const controller = new AbortController(); controller.abort();
  const client = await startSmsMessaging({ config, env, signal: controller.signal, fetcher() { throw new Error("Unexpected request"); } });
  assert.equal((await client.checkConnection()).ready, false);
  await assert.rejects(client.sendQuestion(question), { code: "CANCELLED" });
  await client.close();
});
