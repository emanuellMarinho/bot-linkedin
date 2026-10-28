import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSmsSetup } from "../src/bot/sms-setup.js";
import { SetupCancelled } from "../src/terminal/prompts.js";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vaga-sms-setup-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "bot.config.json");
  const original = {
    dataDir: "./dados",
    applicant: { email: "fixture@example.org", resumePath: "./curriculo.txt" },
    preferences: { minScore: 81 },
    whatsapp: { enabled: true, to: "5511999990000", transport: "personal" },
    credentials: { openaiApiKey: "FIXTURE_EXISTING_NOT_REAL_KEY" },
  };
  fs.writeFileSync(filename, JSON.stringify(original, null, 2));
  const calls = [];
  const answers = {
    "sms.to": "+55 (11) 99999-0000",
    "sms.from": "+1 (415) 555-0100",
    "sms.twilioAccountSid": "AC" + "b".repeat(32),
    "sms.twilioAuthToken": "FIXTURE_TWILIO_TOKEN_NOT_REAL",
  };
  const prompt = {
    async ask(label, options) {
      calls.push({ label, ...options });
      return typeof answers[options.id] === "function" ? answers[options.id]() : answers[options.id] ?? options.defaultValue;
    },
    async confirm(label, options) { calls.push({ label, ...options }); return true; },
  };
  return { directory, filename, original, calls, answers, prompt };
}

test("alternativa SMS configura na sessão atual e preserva perfil/currículo/credenciais anteriores", async (t) => {
  const h = fixture(t);
  const output = [];
  const result = await runSmsSetup({ filename: h.filename, prompt: h.prompt, env: {}, output: (line) => output.push(line) });
  const saved = JSON.parse(fs.readFileSync(h.filename, "utf8"));
  assert.equal(result.notifications.channel, "sms");
  assert.equal(result.sms.enabled, true);
  assert.equal(result.whatsapp.enabled, false);
  assert.equal(saved.sms.to, "+5511999990000");
  assert.equal(saved.sms.from, "+14155550100");
  assert.deepEqual(saved.applicant, h.original.applicant);
  assert.deepEqual(saved.preferences, h.original.preferences);
  assert.equal(saved.dataDir, h.original.dataDir);
  assert.equal(saved.credentials.openaiApiKey, h.original.credentials.openaiApiKey);
  assert.ok(h.calls.filter((call) => call.secret).length === 2);
  for (const value of Object.values(saved.credentials)) assert.ok(!output.join("\n").includes(value));
  assert.match(output.join("\n"), /pode cobrar/);
  assert.match(output.join("\n"), /Aguarde a verificação/);
});

test("cancelar a troca para SMS não altera a configuração anterior", async (t) => {
  const h = fixture(t);
  const previous = fs.readFileSync(h.filename, "utf8");
  h.prompt.confirm = async () => false;
  await assert.rejects(runSmsSetup({ filename: h.filename, prompt: h.prompt, output() {} }), SetupCancelled);
  assert.equal(fs.readFileSync(h.filename, "utf8"), previous);
  assert.deepEqual(fs.readdirSync(h.directory), ["bot.config.json"]);
});

test("SID inválido é corrigido antes da pergunta seguinte", async (t) => {
  const h = fixture(t);
  let attempts = 0;
  h.answers["sms.twilioAccountSid"] = () => attempts++ === 0 ? "invalido" : "AC" + "c".repeat(32);
  await runSmsSetup({ filename: h.filename, prompt: h.prompt, output() {} });
  const sidCalls = h.calls.map((call) => call.id).filter((id) => id.startsWith("sms.twilio"));
  assert.deepEqual(sidCalls, ["sms.twilioAccountSid", "sms.twilioAccountSid", "sms.twilioAuthToken"]);
});
