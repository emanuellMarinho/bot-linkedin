import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import request from "supertest";
import { sendQuestion } from "../src/messaging/whatsapp.js";
import { createWhatsAppWebhook } from "../src/messaging/webhook.js";

const options = {
  enabled: true,
  phoneNumberId: "12345678901",
  to: "5511999999999",
  accessToken: "TEST_TOKEN_NOT_REAL",
  templateName: "vaga_radar_duvida",
};
const question = {
  id: "profile.name",
  text: "Qual é seu nome profissional completo?",
};
const secret = "test-meta-app-secret-not-real";
const verify = "test-webhook-verify-token-not-real";
const sender = options.to;
const event = (overrides = {}) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            messages: [
              {
                id: "wamid.fake-inbound",
                from: sender,
                type: "text",
                text: { body: "profile.name: Pessoa de teste" },
                ...overrides,
              },
            ],
          },
        },
      ],
    },
  ],
});
const sign = (body) =>
  "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
const webhook = (onAnswer) =>
  createWhatsAppWebhook({
    verifyToken: verify,
    appSecret: secret,
    allowedSender: sender,
    onAnswer,
  });

test("WhatsApp desativado não faz requisição", async () => {
  const result = await sendQuestion(question, {
    fetcher() {
      throw new Error("Não deveria consultar");
    },
  });
  assert.equal(result.sent, false);
});
test("WhatsApp envia template aprovado ao endpoint fixo e verifica receipt", async () => {
  let called = 0;
  const result = await sendQuestion(question, {
    ...options,
    fetcher: async (url, requestOptions) => {
      called++;
      assert.equal(
        url,
        "https://graph.facebook.com/v24.0/12345678901/messages",
      );
      assert.equal(requestOptions.method, "POST");
      assert.equal(requestOptions.redirect, "error");
      assert.equal(
        requestOptions.headers.Authorization,
        "Bearer TEST_TOKEN_NOT_REAL",
      );
      const body = JSON.parse(requestOptions.body);
      assert.equal(body.type, "template");
      assert.equal(body.template.language.code, "pt_BR");
      assert.deepEqual(
        body.template.components[0].parameters.map((p) => p.text),
        [question.text, question.id],
      );
      return Response.json({
        messaging_product: "whatsapp",
        messages: [{ id: "wamid.fake-receipt" }],
      });
    },
  });
  assert.equal(called, 1);
  assert.equal(result.verified, true);
  assert.equal(result.messageId, "wamid.fake-receipt");
});
test("WhatsApp recusa configuração, destinos, caminho e pergunta inválidos antes da rede", async () => {
  for (const override of [
    { accessToken: "" },
    { to: "https://127.0.0.1" },
    { phoneNumberId: "../bad" },
    { apiVersion: "v24.0/../../bad" },
    { templateName: "Unapproved Name" },
  ]) {
    await assert.rejects(
      sendQuestion(question, {
        ...options,
        ...override,
        fetcher() {
          throw new Error("no-network");
        },
      }),
      (e) => e.code === "CONFIGURATION",
    );
  }
  await assert.rejects(
    sendQuestion({ id: "bad:id", text: "Pergunta" }, options),
    (e) => e.code === "CONFIGURATION",
  );
});
test("WhatsApp não retenta timeout, 5xx, rate-limit nem resposta sem receipt", async () => {
  for (const [response, code] of [
    [new Response("private text", { status: 503 }), "AMBIGUOUS"],
    [new Response("private text", { status: 429 }), "RATE_LIMIT"],
    [Response.json({ accepted: true }), "AMBIGUOUS"],
    [new Response("private text", { status: 403 }), "AUTHORIZATION"],
  ]) {
    let called = 0;
    await assert.rejects(
      sendQuestion(question, {
        ...options,
        fetcher: async () => {
          called++;
          return response;
        },
      }),
      (e) =>
        e.code === code &&
        !e.message.includes("private text") &&
        !e.message.includes(options.accessToken),
    );
    assert.equal(called, 1);
  }
  await assert.rejects(
    sendQuestion(question, {
      ...options,
      fetcher: async () => {
        throw new Error(options.accessToken);
      },
    }),
    (e) => e.code === "AMBIGUOUS" && !e.message.includes(options.accessToken),
  );
});
test("webhook verifica challenge e token; nenhum segredo é retornado", async () => {
  const app = webhook(() => {});
  await request(app)
    .get("/webhook")
    .query({
      "hub.mode": "subscribe",
      "hub.verify_token": verify,
      "hub.challenge": "challenge-123",
    })
    .expect(200, "challenge-123");
  await request(app)
    .get("/webhook")
    .query({
      "hub.mode": "subscribe",
      "hub.verify_token": "wrong",
      "hub.challenge": "challenge-123",
    })
    .expect(403);
});
test("webhook processa apenas JSON autenticado com assinatura dos bytes originais", async () => {
  const received = [];
  const app = webhook((input) => received.push(input));
  const body = JSON.stringify(event());
  await request(app)
    .post("/webhook")
    .type("application/json")
    .set("x-hub-signature-256", sign(body))
    .send(body)
    .expect(200);
  assert.deepEqual(received, [
    {
      messageId: "wamid.fake-inbound",
      sender,
      questionId: "profile.name",
      answer: "Pessoa de teste",
    },
  ]);
  await request(app)
    .post("/webhook")
    .type("application/json")
    .set("x-hub-signature-256", sign(body))
    .send(body + " ")
    .expect(403);
  await request(app)
    .post("/webhook")
    .type("application/json")
    .send(body)
    .expect(403);
  assert.equal(received.length, 1);
});
test("webhook ignora remetentes não autorizados, recibos e mensagens sem ID de pergunta", async () => {
  const received = [];
  const app = webhook((input) => received.push(input));
  for (const payload of [
    event({ from: "5511888888888" }),
    event({ type: "image", text: undefined }),
    event({ text: { body: "Resposta sem identificação" } }),
    {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                statuses: [{ id: "wamid.receipt", status: "read" }],
              },
            },
          ],
        },
      ],
    },
  ]) {
    const body = JSON.stringify(payload);
    await request(app)
      .post("/webhook")
      .type("application/json")
      .set("x-hub-signature-256", sign(body))
      .send(body)
      .expect(200);
  }
  assert.deepEqual(received, []);
});
test("webhook rejeita JSON inválido e corpo grande, e sinaliza falha de persistência para retry da Meta", async () => {
  const app = webhook(() => {
    throw new Error("sensitive internal details");
  });
  const body = JSON.stringify(event());
  const response = await request(app)
    .post("/webhook")
    .type("application/json")
    .set("x-hub-signature-256", sign(body))
    .send(body)
    .expect(500);
  assert.ok(!response.text.includes("sensitive"));
  const malformed = "{";
  await request(app)
    .post("/webhook")
    .type("application/json")
    .set("x-hub-signature-256", sign(malformed))
    .send(malformed)
    .expect(400);
  await request(app)
    .post("/webhook")
    .type("application/json")
    .send("x".repeat(300000))
    .expect(413);
});
