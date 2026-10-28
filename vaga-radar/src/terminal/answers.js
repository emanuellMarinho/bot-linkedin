import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { acceptCandidateAnswer } from "../bot/questions.js";

const menuCommands = { 1: "vagas", 2: "candidaturas", 4: "ajuda" };
export function startTerminalAnswers(
  db,
  { input = process.stdin, output = process.stdout, onStop = () => {}, onCommand, ui } = {},
) {
  const terminal = Boolean(input.isTTY && output.isTTY);
  const rl = createInterface({ input, output, terminal, historySize: 0 });
  const detachUI = ui?.attachReader(rl);
  const write = (message, kind = "info") => {
    if (closing) return;
    if (ui) ui[kind](message);
    else output.write(message + "\n");
  };
  let closing = false, running = false, activeLine;
  const queue = [], idleWaiters = [];
  const pendingQuestions = () => db.prepare(
    "SELECT id,text FROM bot_questions WHERE answer IS NULL AND topic<>'whatsapp_test' ORDER BY created_at,id LIMIT 10",
  ).all();
  function showQuestions() {
    const rows = pendingQuestions();
    if (ui) return ui.questions(rows);
    if (!rows.length) write("Nenhuma pergunta aguardando resposta.");
    else write("PERGUNTAS PENDENTES\n" + rows.map((row, index) => `${index + 1}. ${row.text}`).join("\n") + "\nResponda com o numero: sua resposta. Ex.: 1: sua resposta.");
    return rows.map((row, index) => ({ ...row, ordinal: index + 1 }));
  }
  function resolveQuestion(reference) {
    if (!/^\d+$/.test(reference)) return reference;
    if (ui) {
      const known = ui.resolveQuestion(reference);
      if (known) return known;
      ui.questions(pendingQuestions());
      return ui.resolveQuestion(reference);
    }
    return pendingQuestions()[Number(reference) - 1]?.id;
  }
  function saveAnswer(raw) {
    const match = raw.match(/^([A-Za-z0-9_.-]{1,120}):\s*(.+)$/);
    if (!match) {
      write("Escolha 1 para vagas, 2 para candidaturas, 3 para perguntas ou 4 para ajuda. Para responder: numero: sua resposta.");
      return;
    }
    try {
      const result = acceptCandidateAnswer(db, {
        messageId: `terminal:${randomUUID()}`,
        questionId: resolveQuestion(match[1]),
        answer: match[2],
      });
      write(result.accepted
        ? "Resposta salva. O bot retomara a vaga durante o horario de trabalho."
        : result.reason === "invalid_email"
          ? "Resposta nao aceita. Informe um e-mail valido."
          : result.reason === "expected_yes_no"
            ? "Resposta nao aceita. Responda sim ou nao."
            : "Resposta nao aceita. Confira o numero, o formato solicitado e se a pergunta continua pendente.",
      result.accepted ? "success" : "error");
    } catch {
      write("Nao consegui salvar a resposta. Tente novamente.", "error");
    }
  }
  function perform(raw) {
    if (["0", "sair", "encerrar"].includes(raw.toLowerCase())) {
      stop(); return;
    }
    if (["3", "perguntas", "responder"].includes(raw.toLowerCase())) {
      showQuestions(); return;
    }
    const command = menuCommands[raw] || raw;
    if (onCommand) {
      try {
        const result = onCommand(command);
        if (result && typeof result.then === "function")
          return result.then((value) => {
            if (typeof value === "string") write(value);
            else if (!closing) saveAnswer(raw);
          }).catch(() => write("Nao consegui concluir esta acao. Tente novamente.", "error"));
        if (typeof result === "string") { write(result); return; }
      } catch {
        write("Nao consegui consultar o acompanhamento. Tente novamente.", "error");
        return;
      }
    }
    saveAnswer(raw);
  }
  function finished() {
    running = false;
    activeLine = undefined;
    if (queue.length && !closing) pump();
    else {
      for (const resolve of idleWaiters.splice(0)) resolve();
      if (!closing && terminal) rl.prompt();
    }
  }
  function pump() {
    if (running || closing || !queue.length) return;
    running = true;
    activeLine = queue.shift();
    const release = ui?.suspend();
    let result;
    try { result = perform(activeLine); }
    catch { write("Nao consegui concluir esta acao. Tente novamente.", "error"); }
    if (result && typeof result.then === "function") {
      result.finally(() => { release?.(); finished(); });
    } else { release?.(); finished(); }
  }
  const line = (raw) => {
    const value = raw.trim();
    if (!value || closing) { if (!closing && terminal && !running) rl.prompt(); return; }
    if (running && (activeLine === value || queue.at(-1) === value)) return;
    if (queue.length >= 20) { write("Aguarde a acao atual terminar antes de enviar novos comandos."); return; }
    queue.push(value);
    pump();
  };
  function stop() {
    if (closing) return;
    closing = true;
    queue.length = 0;
    detachUI?.();
    onStop();
    rl.close();
  }
  rl.on("line", line);
  rl.on("SIGINT", stop);
  rl.on("close", () => {
    detachUI?.();
    if (!closing) { closing = true; queue.length = 0; onStop(); }
  });
  if (terminal) { rl.setPrompt("Comando > "); rl.prompt(); }
  return {
    showQuestions,
    notify: write,
    whenIdle: () => !running && !queue.length ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve)),
    close() {
      closing = true;
      queue.length = 0;
      detachUI?.();
      rl.off("line", line);
      rl.close();
    },
  };
}
