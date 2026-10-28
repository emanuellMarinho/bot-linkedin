import fs from "node:fs";
import path from "node:path";

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizedJid(jid) {
  const match = typeof jid === "string" && jid.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|c\.us|lid)$/);
  return match ? `${match[1]}@${match[2] === "c.us" ? "s.whatsapp.net" : match[2]}` : "";
}

function privateSession(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink())
    throw failure("CONFIGURATION", "A pasta da sessão WhatsApp precisa ser local.");
  fs.chmodSync(directory, 0o700);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
    if (entry.isFile()) {
      try { fs.chmodSync(path.join(directory, entry.name), 0o600); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
}

async function defaults() {
  const [baileys, qr, pino] = await Promise.all([
    import("@whiskeysockets/baileys"),
    import("qrcode-terminal"),
    import("pino"),
  ]);
  return {
    makeSocket: baileys.default,
    loadAuth: baileys.useMultiFileAuthState,
    renderQr: (value, output) => qr.default.generate(value, { small: true }, output),
    logger: pino.default({ level: "silent" }),
    browser: baileys.Browsers.windows("Vaga Radar"),
  };
}

function textMessage(message) {
  let body = message;
  for (let i = 0; body && i < 5; i++) {
    const inner = body.ephemeralMessage?.message || body.deviceSentMessage?.message;
    if (!inner) break;
    body = inner;
  }
  const text = body?.conversation ?? body?.extendedTextMessage?.text;
  return {
    text: typeof text === "string" ? text : "",
    context: body?.extendedTextMessage?.contextInfo,
  };
}

/**
 * One local linked device, restricted to the configured account's self-chat.
 * Merely constructing the controller is not evidence of authentication/delivery.
 * Dependencies are injectable so automated tests never open a WhatsApp socket.
 */
export async function startPersonalWhatsApp({
  dataDir,
  to,
  onAnswer,
  onStatus = () => {},
  onCommand,
  output = console.log,
  signal,
  dependencies,
  schedule = setTimeout,
  unschedule = clearTimeout,
  clock = Date.now,
}) {
  if (!/^\d{8,15}$/.test(to || "") || typeof onAnswer !== "function" || !dataDir)
    throw failure("CONFIGURATION", "Informe seu número pessoal com país e DDD para conectar o WhatsApp.");
  const directory = path.join(path.resolve(dataDir), "whatsapp-session");
  // Auth library writes multiple private files over the socket's lifetime.
  // Restrict their creation as well as existing files; do not weaken caller permissions.
  process.umask(process.umask() | 0o077);
  privateSession(directory);
  const deps = dependencies || await defaults();
  const auth = await deps.loadAuth(directory);
  const keysSet = auth.state.keys.set.bind(auth.state.keys);
  auth.state.keys.set = async (...args) => {
    await keysSet(...args);
    privateSession(directory);
  };
  const target = `${to}@s.whatsapp.net`;
  const lifecycle = new AbortController();
  let socket, state = "connecting", closed = false, generation = 0;
  let reconnectTimer, attempts = 0, handlers = [];
  let pending = Promise.resolve();
  const outbound = new Set();
  const recentStatuses = new Map();
  const waiting = new Set();
  const commandFile = path.join(directory, "processed-commands.json");
  let commandIds;
  try {
    const saved = JSON.parse(fs.readFileSync(commandFile, "utf8"));
    commandIds = new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === "string").slice(-500) : []);
  } catch { commandIds = new Set(); }
  function reserveCommand(id) {
    if (commandIds.has(id)) return false;
    commandIds.add(id);
    if (commandIds.size > 500) commandIds.delete(commandIds.values().next().value);
    const temp = commandFile + ".tmp";
    fs.writeFileSync(temp, JSON.stringify([...commandIds]), { mode: 0o600 });
    fs.renameSync(temp, commandFile);
    return true;
  }

  function updateState(next) {
    state = next;
    for (const check of waiting) check();
  }
  function tracked(action) {
    pending = pending.then(action).catch(() => {
      if (!closed) output("WhatsApp: não foi possível processar uma atualização; os dados anteriores foram preservados.");
    });
    return pending;
  }
  function cleanSocket() {
    generation++;
    for (const [event, listener] of handlers) socket?.ev.off(event, listener);
    handlers = [];
    try { socket?.end?.(new Error("Vaga Radar encerrou esta conexão")); } catch { /* Already closed. */ }
    socket = undefined;
  }
  function isSelfChat(key) {
    const remote = normalizedJid(key?.remoteJid);
    const alternative = normalizedJid(key?.remoteJidAlt);
    const ownLid = normalizedJid(socket?.user?.lid || auth.state.creds.me?.lid);
    // An alternate JID cannot turn a group, status or foreign PN into self-chat.
    if (remote === target) return true;
    if (remote.endsWith("@lid"))
      return remote === ownLid || alternative === target;
    return false;
  }
  function reconnect(code) {
    if (closed) return;
    if ([401, 403, 411, 440, 500].includes(code)) {
      updateState(code === 401 ? "logged_out" : "action_required");
      output(code === 401
        ? "WhatsApp desconectado no celular. Use --reset-whatsapp para gerar um novo QR code."
        : "WhatsApp precisa ser reconectado. Encerre outros bots e use --reset-whatsapp se a sessão não puder ser restaurada.");
      return;
    }
    if (attempts >= 6) {
      updateState("disconnected");
      output("WhatsApp sem conexão após seis tentativas. Verifique a internet e reinicie o bot; as perguntas continuam salvas.");
      return;
    }
    const wait = code === 515 ? 500 : Math.min(30000, 1000 * 2 ** attempts);
    attempts++;
    updateState("reconnecting");
    output("WhatsApp perdeu a conexão; tentando restaurar a sessão salva.");
    reconnectTimer = schedule(() => {
      reconnectTimer = undefined;
      if (!closed) openSocket();
    }, wait);
  }
  function openSocket() {
    if (closed || signal?.aborted) return;
    cleanSocket();
    const version = ++generation;
    updateState("connecting");
    try {
      socket = deps.makeSocket({
        auth: auth.state,
        logger: deps.logger,
        browser: deps.browser,
        printQRInTerminal: false,
        emitOwnEvents: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        shouldIgnoreJid: (jid) => /@(g\.us|broadcast|newsletter)$/.test(jid),
        getMessage: async () => undefined,
        connectTimeoutMs: 20000,
        defaultQueryTimeoutMs: 20000,
      });
    } catch {
      reconnect();
      return;
    }
    function listen(name, action) {
      const listener = (event) => {
        if (!closed && version === generation) tracked(() => {
          if (!closed && version === generation) return action(event);
        });
      };
      handlers.push([name, listener]);
      socket.ev.on(name, listener);
    }
    listen("creds.update", async () => {
      await auth.saveCreds();
      privateSession(directory);
    });
    listen("connection.update", (event) => {
      if (event.qr) {
        updateState("qr");
        output("No celular: WhatsApp → Aparelhos conectados → Conectar aparelho. Leia o QR code abaixo com a conta do número informado.");
        deps.renderQr(event.qr, output);
      }
      if (event.connection === "open") {
        const own = normalizedJid(socket.user?.id || auth.state.creds.me?.id);
        if (own !== target) {
          updateState("account_mismatch");
          output("A conta lida no QR code não corresponde ao número informado. Corrija o número com --setup ou use --reset-whatsapp para conectar a conta correta.");
          cleanSocket();
          return;
        }
        attempts = 0;
        updateState("connected");
        output("WhatsApp conectado. As dúvidas aparecerão na conversa com você mesmo. Use Responder na pergunta ou ID: resposta.");
      }
      if (event.connection === "close") {
        const code = event.lastDisconnect?.error?.output?.statusCode;
        cleanSocket();
        reconnect(code);
      }
    });
    listen("messages.upsert", async (event) => {
      if (state !== "connected" || event.type !== "notify") return;
      for (const entry of event.messages || []) {
        const key = entry.key;
        if (!isSelfChat(key) || key.fromMe !== true || !key.id || outbound.has(key.id)) continue;
        const { text, context } = textMessage(entry.message);
        if (!text.trim() || text.length > 3000 || text.startsWith("Vaga Radar — ")) continue;
        if (typeof onCommand === "function" && /^(vagas|candidaturas|ajuda|vaga\s+\d+)$/i.test(text.trim())) {
          if (!reserveCommand(key.id)) continue;
          const response = await onCommand(text.trim());
          if (typeof response === "string" && response.trim())
            await transmit(`Vaga Radar — acompanhamento\n${response.slice(0,3400)}`);
          continue;
        }
        const explicit = text.match(/^\s*([A-Za-z0-9_.-]{1,120})\s*:\s*([\s\S]+?)\s*$/);
        const replyToMessageId = typeof context?.stanzaId === "string" ? context.stanzaId : undefined;
        if (!explicit && !replyToMessageId) continue;
        const result = await onAnswer({
          messageId: key.id,
          sender: to,
          questionId: explicit?.[1],
          replyToMessageId,
          answer: explicit?.[2] || text.trim(),
        });
        if (result?.accepted) output("WhatsApp: resposta recebida e salva.");
        else if (result?.reason && !["duplicate", "unknown_or_answered", "unknown_reply"].includes(result.reason)) {
          output("WhatsApp: resposta inválida. Confira o formato solicitado na pergunta e envie novamente.");
          if (reserveCommand(key.id))
            await transmit(`Vaga Radar — resposta inválida\n${result.reason === "invalid_email" ? "Informe um e-mail válido." : result.reason === "expected_yes_no" ? "Responda sim ou não." : "Confira o formato solicitado."} Use Responder na pergunta original para tentar novamente.`);
        }
      }
    });
    listen("messages.update", async (updates) => {
      if (state !== "connected") return;
      for (const entry of updates || []) {
        if (!isSelfChat(entry.key) || entry.key.fromMe !== true || !entry.key.id) continue;
        const status = { 0: "failed", 2: "sent", 3: "delivered", 4: "read", 5: "read" }[entry.update?.status];
        if (!status) continue;
        const stamp = Number(entry.update.messageTimestamp);
        const receipt = {
          messageId: entry.key.id,
          status,
          recipient: to,
          phoneNumberId: null,
          timestamp: Number.isFinite(stamp) && stamp > 0 ? Math.floor(stamp) : Math.floor(clock() / 1000),
        };
        recentStatuses.set(entry.key.id, receipt);
        if (recentStatuses.size > 200) recentStatuses.delete(recentStatuses.keys().next().value);
        await onStatus(receipt);
      }
    });
  }

  async function transmit(text, { signal: sendSignal } = {}) {
    if (signal?.aborted || sendSignal?.aborted || closed)
      throw failure("CANCELLED", "Envio cancelado antes de começar.");
    if (state !== "connected" || !socket)
      throw failure("CONNECTION_REQUIRED", "Leia o QR code ou aguarde a reconexão do WhatsApp.");
    let abort, timeout;
    const activeSignal = AbortSignal.any([lifecycle.signal, signal, sendSignal].filter(Boolean));
    try {
      const guard = new Promise((resolve, reject) => {
        abort = () => reject(failure("AMBIGUOUS", "Envio interrompido; confirme no WhatsApp antes de tentar novamente."));
        activeSignal.addEventListener("abort", abort, { once: true });
        timeout = setTimeout(abort, 20000);
      });
      const sent = await Promise.race([socket.sendMessage(target, { text }), guard]);
      const messageId = sent?.key?.id;
      if (typeof messageId !== "string" || !messageId || messageId.length > 512)
        throw failure("AMBIGUOUS", "WhatsApp não retornou um identificador de mensagem.");
      outbound.add(messageId);
      if (outbound.size > 500) outbound.delete(outbound.values().next().value);
      // A receipt may arrive before the queue persists the returned message ID.
      // Defer replay until the caller has committed that ID; duplicates are safe.
      const receipt = recentStatuses.get(messageId);
      if (receipt) setImmediate(() => { if (!closed) tracked(() => onStatus(receipt)); });
      return { provider: "whatsapp_personal", verified: true, messageId };
    } catch (error) {
      if (error.code === "AMBIGUOUS") throw error;
      throw failure("AMBIGUOUS", "Resultado do envio ao WhatsApp inconclusivo; não reenviar automaticamente.");
    } finally {
      clearTimeout(timeout);
      activeSignal.removeEventListener("abort", abort);
    }
  }

  async function sendQuestion(question, options) {
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(question?.id || "") ||
        typeof question.text !== "string" || !question.text.trim() || question.text.length > 700)
      throw failure("CONFIGURATION", "Pergunta do WhatsApp inválida.");
    const text = `Vaga Radar — pergunta\n${question.text}\n\nID: ${question.id}\nUse Responder nesta mensagem ou envie:\n${question.id}: sua resposta`;
    return transmit(text, options);
  }

  function waitUntilReady({ timeoutMs = 120000, signal: waitSignal } = {}) {
    return new Promise((resolve) => {
      let timer;
      const finish = (ready) => {
        clearTimeout(timer);
        waiting.delete(check);
        waitSignal?.removeEventListener("abort", check);
        resolve(ready);
      };
      const check = () => {
        if (state === "connected") finish(true);
        else if (closed || waitSignal?.aborted || ["logged_out", "action_required", "account_mismatch", "disconnected"].includes(state)) finish(false);
      };
      waiting.add(check);
      waitSignal?.addEventListener("abort", check, { once: true });
      timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      check();
    });
  }
  let closing;
  function close() {
    if (closing) return closing;
    closed = true;
    lifecycle.abort();
    generation++;
    unschedule(reconnectTimer);
    signal?.removeEventListener("abort", onAbort);
    cleanSocket();
    updateState("stopped");
    closing = pending.then(async () => {
      try { await auth.saveCreds(); }
      finally { privateSession(directory); }
    });
    return closing;
  }
  const onAbort = () => {
    close().catch(() => output("WhatsApp: não foi possível salvar a sessão ao encerrar. Confira as permissões da pasta antes de reconectar."));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) await close();
  else openSocket();
  return { sendQuestion, getState: () => ({ state, ready: state === "connected" }), close, waitUntilReady };
}

/** Explicit local reset only; does not log out or remove other linked devices. */
export function resetPersonalWhatsAppSession({ dataDir }) {
  const directory = path.join(path.resolve(dataDir), "whatsapp-session");
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink())
    throw failure("CONFIGURATION", "A pasta da sessão WhatsApp precisa ser local.");
  fs.rmSync(directory, { recursive: true, force: true });
}
