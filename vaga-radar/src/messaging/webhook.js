import crypto from "node:crypto";
import express from "express";

function equalSecret(value, expected) {
  if (typeof value !== "string") return false;
  const candidate = Buffer.from(value);
  const target = Buffer.from(expected);
  return (
    candidate.length === target.length &&
    crypto.timingSafeEqual(candidate, target)
  );
}

export function createWhatsAppWebhook({
  verifyToken,
  appSecret,
  allowedSender,
  phoneNumberId,
  onAnswer,
  onStatus,
}) {
  if (
    typeof verifyToken !== "string" ||
    verifyToken.length < 16 ||
    typeof appSecret !== "string" ||
    appSecret.length < 16 ||
    !/^\d{8,15}$/.test(allowedSender || "") ||
    typeof onAnswer !== "function" ||
    (phoneNumberId !== undefined && !/^\d{5,25}$/.test(phoneNumberId)) ||
    (onStatus !== undefined && typeof onStatus !== "function")
  ) {
    throw new Error(
      "Configure os segredos do webhook e o remetente permitido antes de iniciar",
    );
  }
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    next();
  });
  app.get("/webhook", (req, res) => {
    if (
      req.query["hub.mode"] !== "subscribe" ||
      !equalSecret(req.query["hub.verify_token"], verifyToken)
    )
      return res.sendStatus(403);
    const challenge = req.query["hub.challenge"];
    if (typeof challenge !== "string" || challenge.length > 512)
      return res.sendStatus(400);
    res.status(200).type("text/plain").send(challenge);
  });
  app.post(
    "/webhook",
    express.raw({ type: "application/json", limit: "256kb" }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body)) return res.sendStatus(415);
      const signature = req.get("x-hub-signature-256");
      const expected =
        "sha256=" +
        crypto.createHmac("sha256", appSecret).update(req.body).digest("hex");
      if (!equalSecret(signature, expected)) return res.sendStatus(403);
      let payload;
      try {
        payload = JSON.parse(req.body.toString("utf8"));
      } catch {
        return res.sendStatus(400);
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return res.sendStatus(400);
      if (payload.object !== "whatsapp_business_account")
        return res.sendStatus(200);
      const entries = Array.isArray(payload.entry)
        ? payload.entry.slice(0, 20)
        : [];
      for (const entry of entries) {
        for (const change of Array.isArray(entry?.changes)
          ? entry.changes.slice(0, 50)
          : []) {
          const value = change?.value;
          if (
            change?.field !== "messages" ||
            value?.messaging_product !== "whatsapp" ||
            (phoneNumberId && value.metadata?.phone_number_id !== phoneNumberId)
          )
            continue;
          if (onStatus) {
            for (const status of Array.isArray(value.statuses)
              ? value.statuses.slice(0, 100)
              : []) {
              if (!status || status.recipient_id !== allowedSender) continue;
              await onStatus({
                messageId: status.id,
                status: status.status,
                recipient: status.recipient_id,
                phoneNumberId: value.metadata?.phone_number_id,
                timestamp: status.timestamp,
                errorCode: Array.isArray(status.errors) ? status.errors[0]?.code : undefined,
              });
            }
          }
          for (const message of Array.isArray(value.messages)
            ? value.messages.slice(0, 100)
            : []) {
            if (
              !message ||
              message.from !== allowedSender ||
              message.type !== "text" ||
              typeof message.id !== "string" ||
              !message.id ||
              message.id.length > 512 ||
              typeof message.text?.body !== "string" ||
              message.text.body.length > 4000
            )
              continue;
            const match = message.text.body.match(
              /^\s*([A-Za-z0-9_.-]{1,120})\s*:\s*([\s\S]+?)\s*$/,
            );
            const replyToMessageId = message.context?.id;
            const reply = typeof replyToMessageId === "string" &&
              /^wamid\.[A-Za-z0-9_+/=.-]{1,500}$/.test(replyToMessageId);
            if (!match && !reply) continue;
            const answer = match ? match[2] : message.text.body.trim();
            if (!answer.trim() || answer.length > 2000) continue;
            // onAnswer must atomically deduplicate message.id and resolve only a known question.
            await onAnswer({
              messageId: message.id,
              sender: message.from,
              ...(match ? { questionId: match[1] } : {}),
              ...(reply ? { replyToMessageId } : {}),
              answer,
            });
          }
        }
      }
      res.sendStatus(200);
    },
  );
  app.use((req, res) => res.sendStatus(404));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res
      .status(error.type === "entity.too.large" ? 413 : 500)
      .json({ error: "Webhook não processado" });
  });
  return app;
}
