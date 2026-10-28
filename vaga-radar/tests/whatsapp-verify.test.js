import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./helpers.js";
import {
  askQuestion,
  acceptWhatsAppAnswer,
  notifyQuestions,
  recordWhatsAppStatus,
} from "../src/bot/questions.js";
import { verifyWhatsAppRoundTrip } from "../src/messaging/verify.js";

const personal = { transport: "personal", enabled: true, to: "5511999990000" };
const receipt = { verified: true, messageId: "TEST_OUTBOUND_1" };

test("teste de ida e volta confirma resposta e não envia outras perguntas pendentes", async (t) => {
  const h = harness();
  t.after(() => h.close());
  askQuestion(h.db, { id: "PROFILE_NAME", topic: "name", text: "Seu nome?" });
  const output = [];
  const calls = [];
  let reply;
  const result = await verifyWhatsAppRoundTrip(h.db, personal, {
    env: {}, pollIntervalMs: 5, timeoutMs: 1000,
    output: text => output.push(text),
    sender: async (question, options) => {
      calls.push(question.id);
      assert.equal(question.topic, "whatsapp_test");
      assert.ok(options.signal);
      reply = setTimeout(() => {
        const accepted = acceptWhatsAppAnswer(h.db, {
          messageId: "TEST_INBOUND_1",
          replyToMessageId: receipt.messageId,
          answer: "OK",
        });
        assert.equal(accepted.accepted, true);
      }, 15);
      return receipt;
    },
  });
  clearTimeout(reply);
  assert.equal(result.ok, true);
  assert.equal(result.code, "VERIFIED");
  assert.equal(result.status, "answered");
  assert.deepEqual(calls, [result.questionId]);
  assert.equal(h.db.prepare("SELECT notification_status FROM bot_questions WHERE id='PROFILE_NAME'").get().notification_status, "pending");
  assert.match(output.join("\n"), /Resposta recebida/);
});

test("aceitação e entrega sem resposta não concluem teste; pergunta expirada não é reenviada", async (t) => {
  const h = harness();
  t.after(() => h.close());
  let delivered;
  let calls = 0;
  const result = await verifyWhatsAppRoundTrip(h.db, personal, {
    env: {}, pollIntervalMs: 5, timeoutMs: 60, output() {},
    sender: async () => {
      calls++;
      delivered = setTimeout(() => recordWhatsAppStatus(h.db, {
        messageId: receipt.messageId,
        status: "delivered",
        recipient: personal.to,
        timestamp: Math.floor(Date.now() / 1000),
      }), 5);
      return receipt;
    },
  });
  clearTimeout(delivered);
  assert.equal(result.ok, false);
  assert.equal(result.code, "TIMEOUT");
  assert.equal(result.status, "delivered");
  const row = h.db.prepare("SELECT answer FROM bot_questions WHERE id=?").get(result.questionId);
  assert.equal(row.answer, null);
  await notifyQuestions(h.db, personal, { env: {}, sender: async () => { calls++; return receipt; } });
  assert.equal(calls, 1);
});

test("cancelar teste durante espera encerra imediatamente e não transforma aceitação em sucesso", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const controller = new AbortController();
  let cancellation;
  const result = await verifyWhatsAppRoundTrip(h.db, personal, {
    env: {}, pollIntervalMs: 500, timeoutMs: 120000, signal: controller.signal, output() {},
    sender: async () => {
      cancellation = setTimeout(() => controller.abort(), 5);
      return receipt;
    },
  });
  clearTimeout(cancellation);
  assert.equal(result.ok, false);
  assert.equal(result.code, "CANCELLED");
  assert.equal(result.status, "accepted");
});

test("configuração ausente e cancelamento prévio não enviam nem criam pergunta de teste", async (t) => {
  const h = harness();
  t.after(() => h.close());
  for (const options of [
    { config: { ...personal, enabled: false }, expected: "WHATSAPP_CONFIGURATION_REQUIRED" },
    { config: personal, signal: AbortSignal.abort(), expected: "CANCELLED" },
  ]) {
    let calls = 0;
    const result = await verifyWhatsAppRoundTrip(h.db, options.config, {
      env: {}, signal: options.signal, output() {}, sender: async () => { calls++; return receipt; },
    });
    assert.equal(result.code, options.expected);
    assert.equal(calls, 0);
    assert.equal(result.questionId, null);
  }
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM bot_questions").get().n, 0);
});

test("falha definitiva ou resultado ambíguo encerra teste sem retentar envio", async (t) => {
  const h = harness();
  t.after(() => h.close());
  for (const code of ["AUTHORIZATION", "AMBIGUOUS", "CONNECTION_REQUIRED"]) {
    let calls = 0;
    const result = await verifyWhatsAppRoundTrip(h.db, personal, {
      env: {}, pollIntervalMs: 5, timeoutMs: 1000, output() {},
      sender: async () => {
        calls++;
        throw Object.assign(new Error("private provider details"), { code });
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(result).includes("private provider details"));
  }
});
