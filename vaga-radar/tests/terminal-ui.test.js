import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { createTerminalUI, wrapTerminalText } from "../src/terminal/ui.js";
import { startTerminalAnswers } from "../src/terminal/answers.js";
import { askQuestion } from "../src/bot/questions.js";
import { harness } from "./helpers.js";

function capture({ tty = false, columns = 60 } = {}) {
  const chunks = [];
  const output = new Writable({ write(chunk, encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  output.isTTY = tty;
  output.columns = columns;
  return { output, chunks, text: () => chunks.join("") };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("layout cabe em 60 colunas e apresenta etapas, resultado e proximas acoes sem ANSI", () => {
  const h = capture();
  const ui = createTerminalUI({ output: h.output, env: {} });
  ui.header("VAGA RADAR", "Seu assistente de candidaturas");
  ui.step(2, 5, "Conectar seu celular", "Conclua esta etapa para continuar.");
  ui.status("Canal", "Aguardando sua escolha");
  ui.info("x".repeat(125));
  ui.summary({ collection: { received: 12 }, prepared: 3, submitted: 1, pending: [{ id: 4 }], next: "Responda a pergunta pendente" });
  ui.menu();
  assert.ok(h.text().split("\n").every((line) => line.length <= 60));
  assert.ok(!h.text().includes("\u001b"));
  assert.match(h.text(), /ETAPA 2\/5/);
  assert.match(h.text(), /Candidaturas enviadas: 1/);
  assert.match(h.text(), /Pendencias: 1/);
  assert.match(h.text(), /3\s+Responder perguntas/);
  assert.deepEqual(wrapTerminalText("texto\u001b[31m vermelho\u001b[0m\u202e", 30), ["texto vermelho"]);
});

test("renderizador funciona com callback e NO_COLOR mesmo em terminal Windows", () => {
  const lines = [];
  const ui = createTerminalUI({ output: (line) => lines.push(line), width: 40 });
  ui.header("VAGA RADAR", "Configuracao");
  ui.success("Dados confirmados");
  assert.ok(lines.join("\n").split("\n").every((line) => line.length <= 40));
  const h = capture({ tty: true });
  const reader = new EventEmitter();
  reader.line = "";
  reader.input = new EventEmitter();
  reader.prompt = () => {};
  const plain = createTerminalUI({ output: h.output, env: { NO_COLOR: "1" } });
  plain.attachReader(reader);
  plain.info("Busca concluida");
  assert.ok(!h.text().includes("\u001b"));
});

test("etapas exclusivas aguardam a anterior e eventos externos nao interrompem QR ou prompt", async () => {
  const h = capture();
  const ui = createTerminalUI({ output: h.output });
  const gate = deferred();
  const order = [];
  const first = ui.withExclusive(async () => {
    order.push("first-start");
    ui.step(1, 2, "Parear celular");
    ui.raw("QR-LINHA-1\nQR-LINHA-2");
    await gate.promise;
    ui.success("Celular conectado");
    order.push("first-end");
  });
  await tick();
  ui.info("Evento de busca em segundo plano");
  const second = ui.withExclusive(async () => { order.push("second-start"); ui.step(2, 2, "Buscar vagas"); });
  await tick();
  assert.deepEqual(order, ["first-start"]);
  assert.match(h.text(), /QR-LINHA-1\nQR-LINHA-2/);
  assert.ok(!h.text().includes("Evento de busca"));
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
  assert.ok(h.text().indexOf("Celular conectado") < h.text().indexOf("Evento de busca"));
  const release = ui.suspend();
  ui.info("Mensagem aguardando formulario");
  assert.ok(!h.text().includes("Mensagem aguardando"));
  release(); release();
  assert.match(h.text(), /Mensagem aguardando formulario/);
  await assert.rejects(ui.withExclusive(async () => { throw new Error("fixture"); }));
  await ui.withExclusive(async () => {
    const releasePrompt = ui.suspend();
    ui.info("Mesmo dono aguarda a resposta digitada");
    assert.ok(!h.text().includes("Mesmo dono"));
    releasePrompt();
  });
  assert.match(h.text(), /Mesmo dono aguarda a resposta digitada/);
  ui.success("Interface continua utilizavel");
  assert.match(h.text(), /Interface continua utilizavel/);
});

test("eventos sao preservados enquanto uma resposta esta sendo digitada", async () => {
  const h = capture();
  const ui = createTerminalUI({ output: h.output });
  const reader = new EventEmitter();
  reader.input = new EventEmitter();
  reader.line = "minha resposta pela metade";
  let prompts = 0;
  reader.prompt = () => prompts++;
  const detach = ui.attachReader(reader);
  ui.success("Nova vaga encontrada");
  assert.equal(h.text(), "");
  reader.line = "";
  reader.emit("line", "minha resposta completa");
  await tick();
  assert.match(h.text(), /Nova vaga encontrada/);
  assert.equal(prompts, 1);
  detach();
  assert.equal(reader.listenerCount("line"), 0);
});

function streams() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const h = capture({ tty: true });
  return { ...h, input };
}

test("menu numerico permite responder perguntas sem copiar IDs e mantem aliases estaveis", async (t) => {
  const h = harness(); t.after(() => h.close());
  askQuestion(h.db, { id: "LONG_GLOBAL_EMAIL", topic: "email", text: "Qual seu e-mail?" });
  askQuestion(h.db, { id: "LONG_JOB_SKILL", topic: "skill", text: "Possui SQL?" });
  const s = streams();
  const ui = createTerminalUI({ output: s.output, env: { NO_COLOR: "1" } });
  const reader = startTerminalAnswers(h.db, { input: s.input, output: s.output, ui });
  try {
    s.input.write("3\r");
    assert.match(s.text(), /1\. Qual seu e-mail/);
    s.input.write("1: invalido\r");
    assert.equal(h.db.prepare("SELECT answer FROM bot_questions WHERE id='LONG_GLOBAL_EMAIL'").get().answer, null);
    s.input.write("1: fixture@example.org\r");
    s.input.write("3\r");
    assert.match(s.text(), /2\. Possui SQL/);
    s.input.write("2: sim\r");
    assert.equal(h.db.prepare("SELECT answer FROM bot_questions WHERE id='LONG_GLOBAL_EMAIL'").get().answer, "fixture@example.org");
    assert.equal(h.db.prepare("SELECT answer FROM bot_questions WHERE id='LONG_JOB_SKILL'").get().answer, "sim");
    assert.match(s.text(), /Comando > /);
  } finally { reader.close(); s.input.destroy(); s.output.destroy(); }
});

test("acoes async do menu executam uma de cada vez e Enter duplicado nao duplica acao", async (t) => {
  const h = harness(); t.after(() => h.close());
  const s = streams(), first = deferred();
  const calls = [], events = [];
  const ui = createTerminalUI({ output: s.output });
  const reader = startTerminalAnswers(h.db, {
    input: s.input, output: s.output, ui,
    onCommand: (command) => {
      calls.push(command); events.push(`start:${command}`);
      if (command === "vagas") return first.promise.then(() => { events.push("end:vagas"); return "Primeira acao concluida"; });
      events.push(`end:${command}`);
      return "Segunda acao concluida";
    },
  });
  try {
    s.input.write("1\r1\r\r2\r");
    assert.deepEqual(calls, ["vagas"]);
    first.resolve();
    await reader.whenIdle();
    assert.deepEqual(calls, ["vagas", "candidaturas"]);
    assert.deepEqual(events, ["start:vagas", "end:vagas", "start:candidaturas", "end:candidaturas"]);
    assert.ok(s.text().indexOf("Primeira acao concluida") < s.text().indexOf("Segunda acao concluida"));
  } finally { reader.close(); s.input.destroy(); s.output.destroy(); }
});

test("falha numa acao async informa erro e libera a proxima; encerrar cancela a fila", async (t) => {
  const h = harness(); t.after(() => h.close());
  const s = streams();
  let stopped = 0;
  const calls = [];
  const reader = startTerminalAnswers(h.db, {
    input: s.input, output: s.output, onStop: () => stopped++,
    onCommand: (command) => { calls.push(command); return command === "vagas" ? Promise.reject(new Error("PRIVATE_ERROR_NOT_PRINTED")) : "Candidaturas consultadas"; },
  });
  try {
    s.input.write("1\r2\r");
    await reader.whenIdle();
    assert.deepEqual(calls, ["vagas", "candidaturas"]);
    assert.match(s.text(), /Nao consegui concluir esta acao/);
    assert.ok(!s.text().includes("PRIVATE_ERROR_NOT_PRINTED"));
    s.input.write("0\r");
    assert.equal(stopped, 1);
  } finally { reader.close(); s.input.destroy(); s.output.destroy(); }
});
