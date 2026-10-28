import { AsyncLocalStorage } from "node:async_hooks";
import { clearLine, cursorTo } from "node:readline";

const clean = (value) => String(value ?? "")
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
  .replace(/\t/g, "  ");

function cellWidth(text) {
  let width = 0;
  for (const char of text) {
    if (/\p{Mark}/u.test(char)) continue;
    const code = char.codePointAt(0);
    width += code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf ||
      code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff ||
      code >= 0xfe10 && code <= 0xfe6f || code >= 0xff00 && code <= 0xff60 ||
      code >= 0x1f300) ? 2 : 1;
  }
  return width;
}

export function wrapTerminalText(value, width = 60) {
  width = Math.max(12, Math.floor(width));
  const result = [];
  for (const line of clean(value).split(/\r?\n/)) {
    if (!line.trim()) { result.push(""); continue; }
    let current = "";
    for (const word of line.trim().split(/\s+/)) {
      if (current && cellWidth(`${current} ${word}`) <= width) { current += ` ${word}`; continue; }
      if (current) { result.push(current); current = ""; }
      if (cellWidth(word) <= width) { current = word; continue; }
      for (const char of word) {
        if (cellWidth(current + char) > width) { result.push(current); current = ""; }
        current += char;
      }
    }
    if (current) result.push(current);
  }
  return result;
}

/** A single output owner for startup, QR pairing, prompts and live activity. */
export function createTerminalUI({ output = process.stdout, width, env = process.env } = {}) {
  const columns = Math.max(24, Math.min(100, Math.floor(width || output.columns || process.stdout.columns || 68)));
  const write = typeof output === "function"
    ? (text) => output(text.replace(/\n$/, ""))
    : (text) => output.write(text);
  const isTTY = Boolean(output.isTTY);
  const ansi = isTTY && env.NO_COLOR === undefined && env.TERM !== "dumb";
  const context = new AsyncLocalStorage();
  let suspended = 0, activeToken, reader, detachReader, exclusiveQueue = Promise.resolve();
  const pending = [];
  const aliases = new Map();
  let nextAlias = 1;
  let lastNotificationIssue, lastAcceptance;

  function draw(text) {
    if (!text) return;
    if (reader) {
      if (ansi && typeof output.write === "function") { clearLine(output, 0); cursorTo(output, 0); }
      else write("\n");
    }
    write(text.endsWith("\n") ? text : text + "\n");
    if (reader) reader.prompt(true);
  }
  function blocked() {
    const owned = activeToken && context.getStore() === activeToken;
    // A raw question is always exclusive, including callbacks created by the
    // current startup stage (such as WhatsApp socket events).
    return suspended > 0 || (!owned && (activeToken || Boolean(reader?.line)));
  }
  function emit(text) {
    if (blocked()) {
      if (pending.length >= 100) pending.shift();
      pending.push(text);
    } else draw(text);
  }
  function flush() {
    if (blocked() || !pending.length) return;
    draw(pending.splice(0).join("\n"));
  }
  const lines = (value) => wrapTerminalText(value, columns).join("\n");
  function header(title = "VAGA RADAR", subtitle = "Seu assistente de candidaturas") {
    const inside = columns - 4;
    const border = "+" + "-".repeat(columns - 2) + "+";
    const body = [...wrapTerminalText(title, inside), ...wrapTerminalText(subtitle, inside)]
      .map((text) => `| ${text}${" ".repeat(Math.max(0, inside - cellWidth(text)))} |`);
    emit([border, ...body, border].join("\n"));
  }
  function step(index, total, title, detail) {
    emit(lines(`\nETAPA ${index}/${total}  ${title}${detail ? `\n${detail}` : ""}`));
  }
  function status(label, value) { emit(lines(`${label}: ${value}`)); }
  function info(text) { emit(lines(text)); }
  function success(text) { emit(lines(`[OK] ${text}`)); }
  function error(text) { emit(lines(`[ATENCAO] ${text}`)); }
  function summary(result = {}) {
    const pendingCount = Array.isArray(result.pending) ? result.pending.length : result.pending || 0;
    emit(lines(`\nRODADA CONCLUIDA\nVagas recebidas: ${result.received ?? result.collection?.received ?? 0}\nCurriculos preparados: ${result.prepared || 0}  |  Candidaturas enviadas: ${result.submitted || 0}\nPendencias: ${pendingCount}${result.next ? `\nProxima acao: ${result.next}` : ""}`));
  }
  function notificationStatus(stats = {}) {
    const count = (value) => Number.isFinite(value) ? Math.max(0, Math.min(1e9, Math.floor(value))) : 0;
    const failed = count(stats.failed), ambiguous = count(stats.ambiguous);
    // Error text and provider responses can contain credentials or private
    // request data. Only classification codes participate in deduplication;
    // the UI always supplies its own plain-language message.
    const codes = [...(Array.isArray(stats.errors) ? stats.errors : []), stats.error]
      .filter((value) => typeof value === "string" && /^[A-Z_0-9]{1,60}$/.test(value));
    const hasIssue = failed > 0 || ambiguous > 0 || Boolean(stats.error) || (Array.isArray(stats.errors) && stats.errors.length > 0);
    const signature = JSON.stringify([failed, ambiguous, [...new Set(codes)].sort()]);
    if (hasIssue && signature !== lastNotificationIssue) {
      error(ambiguous > 0
        ? "Nao foi possivel confirmar o envio de algumas perguntas. O resultado e incerto; elas nao serao reenviadas automaticamente. Use a opcao 3 para responder no terminal. Revise o canal com --setup."
        : "Nao foi possivel confirmar o envio de algumas perguntas pelo canal escolhido. Use a opcao 3 para responder no terminal. Revise o canal com --setup.");
      lastNotificationIssue = signature;
    } else if (!hasIssue) lastNotificationIssue = undefined;
    const accepted = count(stats.acceptedThisRun);
    if (!accepted) { lastAcceptance = undefined; return; }
    const acceptance = JSON.stringify([accepted, count(stats.accepted), count(stats.delivered), count(stats.read), count(stats.answered)]);
    if (acceptance !== lastAcceptance) {
      info(`O servico aceitou ${accepted} pergunta(s) para envio. Isso ainda nao confirma a entrega nem a sua resposta. Acompanhe as perguntas pela opcao 3.`);
      lastAcceptance = acceptance;
    }
  }
  function questions(rows = []) {
    if (!rows.length) { info("Nenhuma pergunta aguardando resposta."); return []; }
    const shown = [];
    const body = ["PERGUNTAS PENDENTES"];
    for (const question of rows.slice(0, 10)) {
      if (!aliases.has(question.id)) aliases.set(question.id, nextAlias++);
      const ordinal = aliases.get(question.id);
      shown.push({ ...question, ordinal });
      body.push(`${ordinal}. ${question.text}`);
    }
    body.push('Para responder, digite o numero e a resposta. Ex.: 1: sua resposta.');
    info(body.join("\n"));
    return shown;
  }
  function menu() {
    info("ACOMPANHAR\n1  Ver vagas\n2  Ver candidaturas\n3  Responder perguntas\n4  Ajuda\n0  Encerrar\nEscolha um numero ou digite um comando.");
  }
  function suspend() {
    suspended++;
    let released = false;
    return () => { if (!released) { released = true; suspended--; flush(); } };
  }
  function withExclusive(action) {
    const next = exclusiveQueue.then(async () => {
      const token = Symbol("terminal-owner");
      activeToken = token;
      try { return await context.run(token, action); }
      finally { activeToken = undefined; flush(); }
    });
    exclusiveQueue = next.catch(() => {});
    return next;
  }
  function attachReader(rl) {
    detachReader?.();
    reader = rl;
    const afterInput = () => queueMicrotask(flush);
    rl.on("line", afterInput);
    rl.input?.on("keypress", afterInput);
    let detached = false;
    detachReader = () => {
      if (detached) return;
      detached = true;
      rl.off("line", afterInput);
      rl.input?.off("keypress", afterInput);
      if (reader === rl) reader = undefined;
      detachReader = undefined;
      flush();
    };
    return detachReader;
  }
  return {
    width: columns, header, step, status, info, success, error, summary, notificationStatus, questions, menu,
    output: info, raw: (value) => emit(String(value)), suspend, withExclusive, attachReader, flush,
    resolveQuestion: (reference) => {
      if (!/^\d+$/.test(String(reference))) return String(reference);
      const ordinal = Number(reference);
      return [...aliases].find(([, value]) => value === ordinal)?.[0];
    },
  };
}
