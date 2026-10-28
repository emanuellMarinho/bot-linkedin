import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { askQuestion, notifyQuestions } from "../bot/questions.js";
import { inspectWhatsAppConfig } from "./diagnostics.js";

// This explicit diagnostic sends one question, never the normal job backlog.
// Receiving a valid answer is the only successful result; a transport receipt
// or delivery callback alone does not prove the return path works.
export async function verifyWhatsAppRoundTrip(
  db,
  config,
  {
    sender,
    env = process.env,
    signal,
    clock = Date.now,
    pollIntervalMs = 500,
    timeoutMs = 120000,
    output = console.log,
  } = {},
) {
  const result = (ok, code, questionId, status) => ({ ok, code, questionId, status });
  if (signal?.aborted) return result(false, "CANCELLED", null, "cancelled");
  const inspected = inspectWhatsAppConfig(config, { env });
  if (!inspected.ready) {
    output("O teste não foi enviado: a configuração do WhatsApp está incompleta.");
    return result(false, "WHATSAPP_CONFIGURATION_REQUIRED", null, "blocked");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000)
    throw new Error("Tempo limite do teste inválido");
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0)
    throw new Error("Intervalo de verificação inválido");
  const questionId = `WHATSAPP_TEST_${randomUUID()}`;
  askQuestion(db, {
    id: questionId,
    topic: "whatsapp_test",
    text: "Teste de conexão do Vaga Radar. Responda a esta mensagem com OK para confirmar que você recebe as perguntas e o bot recebe suas respostas.",
  });
  const readQuestion = () => db.prepare(
    "SELECT answer,notification_status,notification_error FROM bot_questions WHERE id=?",
  ).get(questionId);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeout.signal])
    : timeout.signal;
  const interrupted = () => {
    const row = readQuestion();
    const code = signal?.aborted ? "CANCELLED" : "TIMEOUT";
    output(code === "CANCELLED"
      ? "Teste cancelado. A pergunta não será reenviada automaticamente."
      : "O teste terminou sem receber uma resposta. O funcionamento completo do WhatsApp ainda não foi confirmado.");
    return result(false, code, questionId, row?.notification_status || "unknown");
  };
  try {
    output("Enviando uma pergunta de teste ao WhatsApp configurado...");
    const notified = await notifyQuestions(db, config, {
      env,
      ...(sender ? { sender } : {}),
      clock,
      signal: combinedSignal,
      questionId,
      limit: 1,
    });
    if (combinedSignal.aborted) return interrupted();
    if (notified.error) {
      output("A pergunta de teste não foi enviada. Confira a conexão do WhatsApp.");
      return result(false, notified.error, questionId, readQuestion().notification_status);
    }
    let previousStatus;
    while (!combinedSignal.aborted) {
      const row = readQuestion();
      if (row.answer !== null) {
        output("Resposta recebida pelo WhatsApp. Envio e recebimento confirmados neste teste.");
        return result(true, "VERIFIED", questionId, "answered");
      }
      if (["failed", "ambiguous", "pending"].includes(row.notification_status)) {
        output("O envio do teste não foi confirmado. Confira o estado da conexão antes de testar novamente.");
        return result(false, row.notification_error || "WHATSAPP_NOT_SENT", questionId, row.notification_status);
      }
      if (row.notification_status !== previousStatus) {
        previousStatus = row.notification_status;
        output(row.notification_status === "delivered"
          ? "Mensagem entregue. Responda pelo WhatsApp para concluir o teste."
          : row.notification_status === "read"
            ? "Mensagem lida. Responda pelo WhatsApp para concluir o teste."
            : "Mensagem aceita para envio. Aguardando sua resposta pelo WhatsApp para confirmar a conexão completa.");
      }
      try {
        await delay(pollIntervalMs, undefined, { signal: combinedSignal });
      } catch (error) {
        if (!combinedSignal.aborted) throw error;
      }
    }
    return interrupted();
  } finally {
    clearTimeout(timer);
  }
}
