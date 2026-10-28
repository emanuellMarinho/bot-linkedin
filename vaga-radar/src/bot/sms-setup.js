import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readBotConfig } from "./config.js";
import { createTerminalUI } from "../terminal/ui.js";
import { SetupCancelled } from "../terminal/prompts.js";

const phone = (value) => /^[+\d\s().-]+$/.test(value) && /^[1-9]\d{7,14}$/.test(value.replace(/\D/g, ""));
const normalizePhone = (value) => "+" + value.replace(/\D/g, "");

/** Configure the alternative channel in the current session, without asking
 * for the candidate's profile or curriculum again. No SMS is sent here. */
export async function runSmsSetup({
  filename,
  config,
  prompt,
  env = process.env,
  output = console.log,
}) {
  const current = config || readBotConfig(filename);
  const raw = JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, ""));
  const sms = { ...current.sms };
  const credentials = { ...raw.credentials };
  const ui = createTerminalUI({ output });
  ui.header("VAGA RADAR", "Configurar SMS");
  ui.info("Use uma conta Twilio própria e um número remetente habilitado para SMS. O serviço pode cobrar pelas mensagens.");
  ui.info("Vamos preencher os dados e, depois, testar envio e resposta.");
  async function ask(id, label, defaultValue, validate, secret = false) {
    while (true) {
      const answer = String(await prompt.ask(label, { id, defaultValue: secret ? "" : defaultValue, secret })).trim() || (secret ? "" : String(defaultValue || ""));
      const result = validate(answer);
      if (result === true) return answer;
      ui.error(result);
    }
  }
  sms.to = normalizePhone(await ask(
    "sms.to", "Seu número para receber SMS, com país e DDD", sms.to || current.whatsapp.to || "",
    (value) => phone(value) || "Informe país, DDD e número, por exemplo +55 11 99999-9999.",
  ));
  sms.from = normalizePhone(await ask(
    "sms.from", "Número Twilio remetente com país e DDD", sms.from || "",
    (value) => phone(value) || "Informe o número SMS que pertence à sua conta Twilio.",
  ));
  async function secret(id, label, field, binding, validate) {
    const present = Boolean(credentials[field] || env[binding]);
    const value = await ask(id, label + (present ? " (Enter mantém a chave atual)" : ""), "", (answer) => {
      if (!answer) return present || "Informe a credencial para continuar.";
      return validate ? validate(answer) : answer.length <= 8192 || "A credencial é longa demais.";
    }, true);
    if (value) credentials[field] = value;
  }
  await secret("sms.twilioAccountSid", "Account SID da Twilio", "twilioAccountSid", sms.accountSidEnv,
    (value) => /^AC[a-fA-F0-9]{32}$/.test(value) || "O Account SID começa com AC e tem 32 caracteres hexadecimais depois do prefixo.");
  await secret("sms.twilioAuthToken", "Auth Token da Twilio", "twilioAuthToken", sms.authTokenEnv);
  ui.status("SMS para", sms.to);
  ui.status("Número remetente", sms.from);
  ui.info("As chaves digitadas ficam no JSON privado. A conexão ainda será verificada.");
  if (!await prompt.confirm("Salvar o canal SMS e testar a conexão?", { id: "sms.confirm", defaultValue: true }))
    throw new SetupCancelled();
  const updated = {
    ...raw,
    sms: { ...sms, enabled: true },
    notifications: { channel: "sms", requireConnection: true },
    whatsapp: { ...raw.whatsapp, enabled: false, autoStartWebhook: false },
    credentials,
  };
  const temporary = path.resolve(filename) + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(updated, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, filename);
    fs.chmodSync(filename, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  ui.success("Canal SMS salvo. Aguarde a verificação da conexão.");
  return readBotConfig(filename);
}
