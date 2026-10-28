import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSetup } from "../src/bot/setup.js";
import { readBotConfig } from "../src/bot/config.js";
import {
  SetupCancelled,
  createTerminalPrompt,
} from "../src/terminal/prompts.js";
import { PassThrough, Writable } from "node:stream";

// Every name, number and key in this file is a synthetic local test fixture.
// The wizard must not contact messaging, GPT or recruitment services.
const secretFixtures = {
  openaiApiKey: "TEST_NOT_A_REAL_OPENAI_KEY_abcdefghijklmnopqrstuvwxyz",
  whatsappAccessToken:
    "TEST_NOT_A_REAL_WHATSAPP_TOKEN_abcdefghijklmnopqrstuvwxyz",
  whatsappVerifyToken:
    "TEST_NOT_A_REAL_VERIFY_TOKEN_abcdefghijklmnopqrstuvwxyz",
  metaAppSecret: "TEST_NOT_A_REAL_META_SECRET_abcdefghijklmnopqrstuvwxyz",
};
const cvText =
  "Pessoa Fictícia do Assistente\nfixture@example.org\n\n" +
  "Empresa Fictícia — Desenvolvedor, 2020–2023.\n" +
  "Experiência declarada em JavaScript, Node.js e SQL.\n";

function terminalStreams() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const chunks = [];
  const output = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  output.isTTY = true;
  output.columns = 80;
  return { input, output, chunks };
}

test("terminal real oculta caracteres de chave e volta a exibir perguntas normais", async () => {
  const { input, output, chunks } = terminalStreams();
  const prompt = createTerminalPrompt({ input, output });
  try {
    const secret = "TEST_TYPED_SECRET_NOT_REAL";
    const pending = prompt.ask("Token de teste", { secret: true });
    input.write(secret + "\r");
    assert.equal(await pending, secret);
    const visible = prompt.ask("Nome profissional");
    input.write("Pessoa de teste\r");
    assert.equal(await visible, "Pessoa de teste");
    const screen = chunks.join("");
    assert.ok(screen.includes("Token de teste"));
    assert.ok(!screen.includes(secret));
    assert.ok(screen.includes("Nome profissional"));
    assert.ok(screen.includes("Pessoa de teste"));
  } finally {
    prompt.close();
    input.destroy();
    output.destroy();
  }
});

test("Ctrl+C durante pergunta do terminal cancela sem esperar nova entrada", async () => {
  const { input, output } = terminalStreams();
  const prompt = createTerminalPrompt({ input, output });
  try {
    const pending = prompt.ask("Pergunta de teste");
    input.write("\u0003");
    await assert.rejects(pending, SetupCancelled);
  } finally {
    prompt.close();
    input.destroy();
    output.destroy();
  }
});

function workspace(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vaga-setup-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "bot.config.json");
  const resume = path.join(directory, "Curriculo de demonstracao.txt");
  fs.writeFileSync(resume, cvText);
  return { directory, filename, resume };
}

function scriptedPrompt(answers = {}, confirmations = {}) {
  const calls = [];
  return {
    calls,
    async ask(label, options = {}) {
      calls.push({ kind: "ask", label, ...options });
      const value = Object.hasOwn(answers, options.id)
        ? answers[options.id]
        : options.secret
          ? ""
          : (options.defaultValue ?? "");
      if (value instanceof Error) throw value;
      return String(typeof value === "function" ? await value(options) : value);
    },
    async confirm(label, options = {}) {
      calls.push({ kind: "confirm", label, ...options });
      const value = Object.hasOwn(confirmations, options.id)
        ? confirmations[options.id]
        : (options.defaultValue ?? false);
      if (value instanceof Error) throw value;
      return Boolean(value);
    },
    close() {},
  };
}

function firstRunAnswers(resume) {
  return {
    "profile.name": "Pessoa Fictícia do Assistente",
    "applicant.email": "fixture@example.org",
    // Dragging a Windows filename into a terminal commonly includes quotes.
    "applicant.resumePath": `"${resume}"`,
    "profile.summary": "Resumo profissional fornecido pelo candidato fictício.",
    "profile.skills": "JavaScript, Node.js, SQL",
    "profile.seniority": "2",
    "whatsapp.to": "+55 (11) 99999-0000",
    "ai.openaiApiKey": secretFixtures.openaiApiKey,
    "ai.model": "gpt-4.1-mini",
    "whatsapp.phoneNumberId": "123456789012345",
    "whatsapp.whatsappAccessToken": secretFixtures.whatsappAccessToken,
    "whatsapp.templateName": "vaga_radar_duvida",
    "whatsapp.metaAppSecret": secretFixtures.metaAppSecret,
    "whatsapp.whatsappVerifyToken": secretFixtures.whatsappVerifyToken,
    "whatsapp.webhookUrl": "https://example.org/webhook",
    "workWindow.startHour": "9",
    "workWindow.hours": "12",
    "preferences.intervalHours": "2",
  };
}

test("assistente coleta os dados, copia o currículo e salva JSON privado sem exibir segredos", async (t) => {
  const { directory, filename, resume } = workspace(t);
  const output = [];
  const prompt = scriptedPrompt(firstRunAnswers(resume), {
    "ai.enabled": true,
    "whatsapp.enabled": true,
    "autoApply.enabled": false,
    "sources.useExamples": true,
  });
  await runSetup({
    filename,
    prompt,
    output: (message) => output.push(message),
  });
  const raw = JSON.parse(fs.readFileSync(filename, "utf8"));
  const config = readBotConfig(filename);
  assert.equal(raw.setup.completed, true);
  assert.equal(raw.profile.name, "Pessoa Fictícia do Assistente");
  assert.equal(raw.applicant.email, "fixture@example.org");
  assert.equal(raw.profile.seniority, "mid");
  assert.deepEqual(
    raw.profile.skills
      .filter((skill) => skill.verified)
      .map((skill) => skill.name),
    ["JavaScript", "Node.js", "SQL"],
  );
  assert.equal(raw.whatsapp.to, "5511999990000");
  assert.equal(raw.ai.enabled, true);
  assert.equal(raw.whatsapp.enabled, true);
  assert.equal(raw.workWindow.startHour, 9);
  assert.equal(raw.workWindow.hours, 12);
  assert.equal(raw.preferences.intervalHours, 2);
  assert.equal(raw.autoApply.enabled, false);
  for (const key of ["openaiApiKey", "whatsappAccessToken", "metaAppSecret"])
    assert.equal(raw.credentials[key], secretFixtures[key]);
  assert.match(raw.credentials.whatsappVerifyToken, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(config.applicant.resumePath, "utf8"), cvText);
  assert.notEqual(
    path.resolve(config.applicant.resumePath),
    path.resolve(resume),
  );
  assert.ok(
    path
      .resolve(config.applicant.resumePath)
      .startsWith(path.resolve(directory)),
    "A cópia do currículo permanece na pasta local privada",
  );
  for (const key of Object.values(raw.credentials)) {
    assert.ok(!output.join("\n").includes(key));
    assert.ok(
      !prompt.calls.some((call) => call.defaultValue === key),
      "Segredos não devem aparecer como padrão visível do prompt",
    );
  }
  for (const id of [
    "ai.openaiApiKey",
    "whatsapp.whatsappAccessToken",
    "whatsapp.metaAppSecret",
  ]) {
    assert.equal(prompt.calls.find((call) => call.id === id)?.secret, true, id);
  }
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    assert.equal(fs.statSync(config.applicant.resumePath).mode & 0o777, 0o600);
  }
});

test("reconfigurar com Enter preserva credenciais, preferências e fontes anteriores", async (t) => {
  const { filename, resume } = workspace(t);
  const original = {
    dataDir: "./dados-existentes",
    setup: { completed: true, version: 1 },
    profile: {
      name: "Nome anteriormente informado",
      summary: "Resumo preservado sem nova experiência.",
      seniority: "mid",
      skills: [{ name: "SQL", verified: true }],
    },
    applicant: { email: "existing-fixture@example.org", resumePath: resume },
    preferences: { minScore: 78, intervalHours: 2, country: "Brasil" },
    workWindow: { startHour: 10, hours: 12, timeZone: "America/Sao_Paulo" },
    ai: { enabled: true, model: "gpt-4.1-mini" },
    whatsapp: {
      enabled: true,
      to: "5511999990000",
      phoneNumberId: "123456789012345",
      templateName: "template_existente",
    },
    credentials: secretFixtures,
    sources: [
      {
        provider: "lever",
        board: "fixture-previous",
        company: "Empresa fictícia preservada",
        enabled: false,
      },
    ],
  };
  fs.writeFileSync(filename, JSON.stringify(original));
  const output = [];
  const prompt = scriptedPrompt({}, { "sources.useExamples": false });
  await runSetup({
    filename,
    prompt,
    output: (message) => output.push(message),
  });
  const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
  assert.equal(saved.profile.name, original.profile.name);
  assert.equal(saved.profile.summary, original.profile.summary);
  assert.equal(saved.applicant.email, original.applicant.email);
  assert.equal(saved.preferences.minScore, 78);
  assert.deepEqual(saved.sources, original.sources);
  assert.deepEqual(saved.credentials, secretFixtures);
  assert.equal(saved.ai.enabled, true);
  assert.equal(saved.whatsapp.enabled, true);
  for (const key of Object.values(secretFixtures)) {
    assert.ok(!output.join("\n").includes(key));
    assert.ok(!prompt.calls.some((call) => call.defaultValue === key));
  }
});

test("cancelar o assistente não salva configuração parcial nem substitui dados existentes", async (t) => {
  const { filename } = workspace(t);
  const original = JSON.stringify({ dataDir: "./dados-preservados" }, null, 2);
  fs.writeFileSync(filename, original);
  const cancelled = new SetupCancelled();
  const prompt = scriptedPrompt({ "profile.name": cancelled });
  await assert.rejects(runSetup({ filename, prompt, output() {} }));
  assert.equal(fs.readFileSync(filename, "utf8"), original);
});

test("currículo inválido não cria configuração utilizável ou altera arquivo anterior", async (t) => {
  const { directory, filename } = workspace(t);
  const invalidResume = path.join(directory, "invalido.pdf");
  fs.writeFileSync(invalidResume, "%PDF-arquivo-corrompido");
  const answers = firstRunAnswers(invalidResume);
  let attempts = 0;
  answers["applicant.resumePath"] = () => {
    if (attempts++ > 0) throw new SetupCancelled();
    return `"${invalidResume}"`;
  };
  const prompt = scriptedPrompt(answers, {
    "ai.enabled": false,
    "whatsapp.enabled": false,
  });
  // The wizard rejects unreadable input, asks again, then honors cancellation.
  await assert.rejects(
    runSetup({ filename, prompt, output() {} }),
    SetupCancelled,
  );
  assert.equal(attempts, 2);
  assert.equal(fs.existsSync(filename), false);
  assert.equal(
    fs.readFileSync(invalidResume, "utf8"),
    "%PDF-arquivo-corrompido",
  );
});
