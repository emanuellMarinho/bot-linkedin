import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { openDatabase } from "./database/index.js";
import { acceptWhatsAppAnswer } from "./bot/questions.js";
import { createWhatsAppWebhook } from "./messaging/webhook.js";

export async function startWhatsAppServer({ env = process.env, dataDir } = {}) {
  const verifyToken = env.VAGA_WHATSAPP_VERIFY_TOKEN;
  const appSecret = env.VAGA_META_APP_SECRET;
  const allowedSender = env.VAGA_WHATSAPP_TO;
  const host = env.VAGA_WHATSAPP_HOST || "127.0.0.1";
  const port = Number(env.VAGA_WHATSAPP_PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Porta do webhook inválida");
  if (!verifyToken || !appSecret || !allowedSender)
    throw new Error(
      "Configure os segredos do webhook e o remetente permitido nas variáveis de ambiente",
    );
  process.umask(0o077);
  const app = createWhatsAppWebhook({
    verifyToken,
    appSecret,
    allowedSender,
    onAnswer: (input) => acceptWhatsAppAnswer(db, input),
  });
  const db = openDatabase(
    path.join(
      path.resolve(dataDir || env.VAGA_BOT_DATA_DIR || "data"),
      "radar.sqlite",
    ),
  );
  const server = app.listen(port, host);
  try {
    await once(server, "listening");
  } catch {
    db.close();
    throw new Error("Não foi possível iniciar o webhook WhatsApp");
  }
  console.log(
    "Webhook WhatsApp iniciado; configure o endpoint HTTPS /webhook na Meta.",
  );
  let closing;
  function close() {
    if (closing) return closing;
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    closing = new Promise((resolve) => {
      const timer = setTimeout(() => server.closeAllConnections(), 10000);
      timer.unref();
      server.close(() => {
        clearTimeout(timer);
        db.close();
        resolve();
      });
    });
    return closing;
  }
  const stop = () => {
    close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return { server, close };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await startWhatsAppServer();
  } catch {
    console.error(
      "Não foi possível iniciar o webhook. Confira as variáveis de ambiente, o diretório e a porta.",
    );
    process.exitCode = 1;
  }
}
