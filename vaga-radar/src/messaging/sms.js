import { createHash } from "node:crypto";

const ACCOUNT = /^AC[a-fA-F0-9]{32}$/;
const MESSAGE = /^SM[a-fA-F0-9]{32}$/;
const NUMBER = /^\+[1-9]\d{7,14}$/;
const HOST = "https://api.twilio.com";

export class SmsError extends Error {
  constructor(code, message, providerCode) {
    super(message);
    this.name = "SmsError";
    this.code = code;
    this.requiresReconciliation = code === "AMBIGUOUS";
    if (Number.isSafeInteger(providerCode) && providerCode >= 0)
      this.providerCode = providerCode;
  }
}

export function inspectSmsConfig(config = {}, { env = process.env } = {}) {
  const issues = [];
  const add = (code, message) => issues.push({ code, message });
  if (!config.enabled) add("SMS_DISABLED", "SMS desativado. Escolha o canal no assistente.");
  if (!ACCOUNT.test(env[config.accountSidEnv || "VAGA_TWILIO_ACCOUNT_SID"] || ""))
    add("SMS_ACCOUNT_REQUIRED", "Informe o Account SID da sua conta Twilio no assistente local.");
  const token = env[config.authTokenEnv || "VAGA_TWILIO_AUTH_TOKEN"];
  if (typeof token !== "string" || !token || token.length > 4096 || /\s/.test(token))
    add("SMS_TOKEN_REQUIRED", "Informe o Auth Token da Twilio no assistente local.");
  if (!NUMBER.test(config.from || ""))
    add("SMS_SENDER_REQUIRED", "Informe o número Twilio habilitado para enviar e receber SMS, com + e código do país.");
  if (!NUMBER.test(config.to || ""))
    add("SMS_RECIPIENT_REQUIRED", "Informe seu celular com +, código do país e DDD.");
  if (config.from && config.from === config.to)
    add("SMS_NUMBERS_EQUAL", "O remetente Twilio precisa ser diferente do seu celular pessoal.");
  return { ready: issues.length === 0, issues };
}

async function boundedJson(response) {
  const limit = 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("Response too large");
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > limit) throw new Error("Response too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Twilio REST transport for a local executable. The sender must be provisioned
 * by the user's Twilio account; a destination number alone cannot send SMS.
 * No listener/webhook/QR is needed: incoming replies are polled serially.
 */
export async function startSmsMessaging({
  db,
  config = {},
  env = process.env,
  signal,
  output = () => {},
  onAnswer,
  onStatus = () => {},
  fetcher = fetch,
  clock = Date.now,
} = {}) {
  const inspected = inspectSmsConfig(config, { env });
  const sid = env[config.accountSidEnv || "VAGA_TWILIO_ACCOUNT_SID"];
  const token = env[config.authTokenEnv || "VAGA_TWILIO_AUTH_TOKEN"];
  const base = `${HOST}/2010-04-01/Accounts/${sid}`;
  let state = inspected.ready ? "disconnected" : "configuration_required";
  let closed = false;
  let tail = Promise.resolve();
  let lastPoll = -Infinity;
  const controller = new AbortController();
  const interval = Math.max(15, Math.min(300, Number(config.pollIntervalSeconds) || 15)) * 1000;

  function cancelled() {
    return closed || signal?.aborted || controller.signal.aborted;
  }
  function serialize(action) {
    const result = tail.then(action);
    tail = result.catch(() => {});
    return result;
  }
  async function request(url, { method = "GET", body, requestSignal } = {}) {
    if (cancelled() || requestSignal?.aborted)
      throw new SmsError("CANCELLED", "Operação SMS cancelada antes da requisição.");
    const combined = AbortSignal.any([
      controller.signal, signal, requestSignal, AbortSignal.timeout(20000),
    ].filter(Boolean));
    let response;
    try {
      response = await fetcher(url, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(body ? { body } : {}),
        redirect: "error",
        signal: combined,
      });
    } catch {
      throw new SmsError(method === "POST" ? "AMBIGUOUS" : cancelled() || requestSignal?.aborted ? "CANCELLED" : "CONNECTION_REQUIRED",
        method === "POST"
          ? "Resultado do SMS inconclusivo. Confira a Twilio antes de reenviar."
          : "Não foi possível consultar o serviço SMS. Confira a conexão.");
    }
    let parsed;
    try { parsed = await boundedJson(response); }
    catch {
      if (response.ok)
        throw new SmsError(method === "POST" ? "AMBIGUOUS" : "CONNECTION_REQUIRED", "O serviço SMS retornou uma resposta inválida.");
    }
    if (!response.ok) {
      const code = Number.isSafeInteger(parsed?.code) ? parsed.code : undefined;
      if ([401, 403].includes(response.status))
        throw new SmsError("AUTHORIZATION", "A Twilio recusou as credenciais ou a permissão da conta SMS.", code);
      if (response.status === 429)
        throw new SmsError("RATE_LIMIT", "Limite temporário da Twilio. Aguarde antes de uma nova tentativa.", code);
      if (response.status >= 400 && response.status < 500)
        throw new SmsError("REJECTED", "A Twilio recusou o SMS. Revise o número remetente, permissões do destino e saldo da conta.", code);
      throw new SmsError(method === "POST" ? "AMBIGUOUS" : "CONNECTION_REQUIRED", "O serviço SMS não confirmou esta operação.", code);
    }
    return parsed;
  }

  function checkConnection() {
    return serialize(async () => {
      if (cancelled()) return { ready: false, issues: [{ code: "CANCELLED", message: "Verificação SMS cancelada." }] };
      if (!inspected.ready) return inspected;
      state = "checking";
      try {
        const account = await request(`${base}.json`);
        if (account.sid !== sid || account.status !== "active")
          throw new SmsError("AUTHORIZATION", "A conta Twilio não está ativa para o serviço SMS.");
        const params = new URLSearchParams({ PhoneNumber: config.from, PageSize: "50" });
        const numbers = await request(`${base}/IncomingPhoneNumbers.json?${params}`);
        const sender = numbers.incoming_phone_numbers?.find((number) =>
          number.phone_number === config.from && (!number.account_sid || number.account_sid === sid));
        if (!sender || !(sender.capabilities?.sms === true || sender.capabilities?.SMS === true))
          throw new SmsError("CONFIGURATION", "O remetente precisa ser um número da sua conta Twilio habilitado para enviar e receber SMS. SMS pode ter cobrança e limitações por país.");
        state = "connected";
        return { ready: true, issues: [] };
      } catch (error) {
        state = cancelled() ? "stopped" : "disconnected";
        return { ready: false, issues: [{ code: error.code || "CONNECTION_REQUIRED", message: error instanceof SmsError ? error.message : "Não foi possível validar o serviço SMS." }] };
      }
    });
  }

  function sendQuestion(question, options = {}) {
    return serialize(async () => {
      if (cancelled() || options.signal?.aborted)
        throw new SmsError("CANCELLED", "Envio SMS cancelado antes de começar.");
      if (state !== "connected")
        throw new SmsError("CONNECTION_REQUIRED", "Conecte o serviço SMS antes de enviar perguntas.");
      if (!/^[A-Za-z0-9_.-]{1,120}$/.test(question?.id || "") ||
          typeof question.text !== "string" || !question.text.trim() || question.text.length > 700)
        throw new SmsError("CONFIGURATION", "A pergunta SMS está inválida.");
      if (!db)
        throw new SmsError("CONFIGURATION", "SMS precisa do banco local para guardar a referência da pergunta.");
      const reference = "Q" + createHash("sha256").update(question.id).digest("hex").slice(0, 8).toUpperCase();
      // Save before dispatch: a reply may arrive before the POST returns. A
      // reference can never be reassigned to a different candidate question.
      const mapKey = `sms_question:${reference}`;
      db.transaction(() => {
        const existing = db.prepare("SELECT value FROM settings WHERE key=?").get(mapKey);
        if (existing && JSON.parse(existing.value).questionId !== question.id)
          throw new SmsError("CONFIGURATION", "Não foi possível reservar a referência desta pergunta SMS.");
        db.prepare("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING")
          .run(mapKey, JSON.stringify({ questionId: question.id }));
      })();
      const body = new URLSearchParams({
        From: config.from,
        To: config.to,
        Body: `Vaga Radar\n${question.text}\nResponda: ${reference}: sua resposta`,
      });
      const receipt = await request(`${base}/Messages.json`, { method: "POST", body: body.toString(), requestSignal: options.signal });
      if (receipt.account_sid === sid && receipt.from === config.from && receipt.to === config.to &&
          ["failed", "undelivered", "canceled"].includes(receipt.status))
        throw new SmsError("REJECTED", "A Twilio não enviou o SMS. Revise as permissões de destino e o saldo da conta.", receipt.error_code);
      if (!MESSAGE.test(receipt.sid || "") || receipt.account_sid !== sid ||
          receipt.from !== config.from || receipt.to !== config.to ||
          !["accepted", "scheduled", "queued", "sending", "sent", "delivered"].includes(receipt.status))
        throw new SmsError("AMBIGUOUS", "O serviço SMS não retornou um comprovante compatível. Confira a Twilio antes de reenviar.");
      return { provider: "sms", verified: true, messageId: `sms:${receipt.sid}`, status: "accepted" };
    });
  }

  async function updateDelivery() {
    if (!db) return;
    const rows = db.prepare("SELECT notification_id FROM bot_questions WHERE notification_id LIKE 'sms:SM%' AND notification_status='accepted' ORDER BY created_at DESC LIMIT 5").all();
    for (const row of rows) {
      if (cancelled()) break;
      const messageSid = row.notification_id.slice(4);
      if (!MESSAGE.test(messageSid)) continue;
      const message = await request(`${base}/Messages/${messageSid}.json`);
      if (message.sid !== messageSid || message.account_sid !== sid || message.from !== config.from || message.to !== config.to) continue;
      const status = { sent: "sent", delivered: "delivered", undelivered: "failed", failed: "failed", canceled: "failed" }[message.status];
      if (!status) continue;
      const stamp = Date.parse(message.date_updated || "");
      await onStatus({
        messageId: row.notification_id, status, recipient: config.to.slice(1), phoneNumberId: null,
        timestamp: Math.floor((Number.isFinite(stamp) ? stamp : clock()) / 1000),
        errorCode: Number.isSafeInteger(message.error_code) ? message.error_code : undefined,
      });
    }
  }

  function pollAnswers() {
    return serialize(async () => {
      if (cancelled() || state !== "connected") return { accepted: 0, skipped: true };
      if (clock() - lastPoll < interval) return { accepted: 0, skipped: true };
      lastPoll = clock();
      let accepted = 0;
      try {
        await updateDelivery();
        const since = new Date(clock() - 7 * 86400000).toISOString().slice(0, 10);
        const params = new URLSearchParams({ From: config.to, To: config.from, "DateSent>": since, PageSize: "50" });
        let endpoint = `${base}/Messages.json?${params}`;
        for (let page = 0; endpoint && page < 3 && !cancelled(); page++) {
          const data = await request(endpoint);
          if (!Array.isArray(data.messages)) throw new SmsError("CONNECTION_REQUIRED", "O serviço SMS retornou uma lista inválida.");
          for (const message of data.messages.slice(0, 50).reverse()) {
            if (cancelled()) break;
            if (!MESSAGE.test(message.sid || "") || message.account_sid !== sid || message.direction !== "inbound" ||
                message.from !== config.to || message.to !== config.from || typeof message.body !== "string" || message.body.length > 3000) continue;
            const stamp = Date.parse(message.date_sent || message.date_created || "");
            if (!Number.isFinite(stamp) || stamp > clock() + 60000 || stamp < clock() - 7 * 86400000) continue;
            const match = message.body.match(/^\s*([A-Za-z0-9_.-]{1,120})\s*:\s*([\s\S]+?)\s*$/);
            if (!match || !match[2].trim()) continue;
            let questionId = match[1];
            if (db && /^Q[a-fA-F0-9]{8}$/i.test(questionId)) {
              const saved = db.prepare("SELECT value FROM settings WHERE key=?").get(`sms_question:${questionId.toUpperCase()}`);
              if (saved) {
                try { questionId = JSON.parse(saved.value).questionId; }
                catch { continue; }
              }
            }
            if (db) {
              const question = db.prepare("SELECT created_at FROM bot_questions WHERE id=? AND answer IS NULL").get(questionId);
              if (!question || stamp < Date.parse(question.created_at) - 1000) continue;
            }
            const result = await onAnswer?.({ messageId: `sms:${message.sid}`, sender: config.to.slice(1), questionId, answer: match[2].trim() });
            if (result?.accepted) accepted++;
          }
          endpoint = null;
          if (typeof data.next_page_uri === "string" && data.next_page_uri) {
            const next = new URL(data.next_page_uri, HOST);
            if (next.origin === HOST && next.pathname === `/2010-04-01/Accounts/${sid}/Messages.json`) endpoint = next.href;
          }
        }
        return { accepted };
      } catch (error) {
        if (!cancelled()) output("Não foi possível atualizar os SMS agora. As perguntas e respostas anteriores continuam salvas.");
        return { accepted, error: error instanceof SmsError ? error.code : "CONNECTION_REQUIRED" };
      }
    });
  }

  let closing;
  function close() {
    if (closing) return closing;
    closed = true;
    state = "stopped";
    controller.abort();
    signal?.removeEventListener("abort", close);
    closing = tail.then(() => {});
    return closing;
  }
  signal?.addEventListener("abort", close, { once: true });
  if (signal?.aborted) await close();
  return { sendQuestion, getState: () => ({ state, ready: state === "connected" && !closed }), checkConnection, pollAnswers, close };
}
