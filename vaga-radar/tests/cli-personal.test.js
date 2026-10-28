import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "vaga-cli-personal-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "bot.config.json");
  fs.writeFileSync(filename, JSON.stringify({
    sources: [], preferences: { collectionEnabled: false },
    workWindow: { enabled: false },
    whatsapp: { enabled: false, to: "5511999990000" },
    credentials: { openaiApiKey: "SYNTHETIC_KEY_NEVER_DISPLAY" },
  }));
  const run = (...args) => spawnSync(process.execPath, ["src/bot.js", "--config", filename, ...args], {
    cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 30000,
  });
  return { directory, filename, run };
}

test("CLI migra configuração antiga para QR e mantém dados/chaves; collect-only não conecta", (t) => {
  const h = fixture(t);
  const result = h.run("--connect-whatsapp", "--once", "--collect-only");
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(fs.readFileSync(h.filename, "utf8"));
  assert.equal(saved.whatsapp.enabled, true);
  assert.equal(saved.whatsapp.transport, "personal");
  assert.equal(saved.whatsapp.autoStartWebhook, false);
  assert.equal(saved.credentials.openaiApiKey, "SYNTHETIC_KEY_NEVER_DISPLAY");
  assert.ok(!fs.existsSync(path.join(h.directory, "data", "whatsapp-session")));
  assert.ok(!`${result.stdout}${result.stderr}`.includes(saved.credentials.openaiApiKey));
});

test("diagnóstico com WhatsApp desativado explica ação necessária sem enviar", (t) => {
  const h = fixture(t);
  const result = h.run("--check-whatsapp");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--connect-whatsapp/);
  assert.ok(!fs.existsSync(path.join(h.directory, "data", "whatsapp-session")));
});

test("CLI rejeita diagnóstico misturado com buscas sem alterar a configuração", (t) => {
  const h = fixture(t);
  const original = fs.readFileSync(h.filename, "utf8");
  const result = h.run("--check-whatsapp", "--once");
  assert.equal(result.status, 2);
  assert.equal(fs.readFileSync(h.filename, "utf8"), original);
});
