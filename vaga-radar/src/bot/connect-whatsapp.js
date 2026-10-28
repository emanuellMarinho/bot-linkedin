import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Explicit migration for an existing configuration. Preserve every other field
// and never copy credentials into console output.
export async function connectPersonalWhatsApp(filename, { prompt } = {}) {
  const raw = JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, ""));
  let to = raw.whatsapp?.to || "";
  if (!/^\d{8,15}$/.test(to)) {
    if (!prompt) throw Object.assign(new Error("Informe um número pelo assistente --setup."), { code: "RECIPIENT_REQUIRED" });
    to = (await prompt.ask("Seu número pessoal com país e DDD", {
      validate: (value) => /^\d{8,15}$/.test(value.replace(/\D/g, "")) || "Informe país, DDD e número.",
      required: true,
    })).replace(/\D/g, "");
    if (!/^\d{8,15}$/.test(to)) throw new Error("Número inválido");
  }
  raw.whatsapp = { ...raw.whatsapp, enabled: true, transport: "personal", to, autoStartWebhook: false };
  raw.notifications = { channel: "whatsapp", requireConnection: true };
  if (raw.sms) raw.sms.enabled = false;
  const temporary = path.resolve(filename) + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filename);
    fs.chmodSync(filename, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function selectTerminalNotifications(filename) {
  const raw = JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, ""));
  raw.notifications = { channel: "terminal", requireConnection: true };
  raw.whatsapp = { ...raw.whatsapp, enabled: false, autoStartWebhook: false };
  if (raw.sms) raw.sms.enabled = false;
  const temporary = path.resolve(filename) + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filename);
    fs.chmodSync(filename, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
