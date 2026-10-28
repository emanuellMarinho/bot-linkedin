import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { botConfigInput } from "./config.js";
import { extractResume } from "../resume/index.js";
import { skills } from "../config.js";
import { SetupCancelled } from "../terminal/prompts.js";

function removeQuotes(value) {
  const text = value.trim();
  return /^(["']).*\1$/.test(text) ? text.slice(1, -1) : text;
}

export async function runSetup({
  filename,
  prompt,
  output = console.log,
  env = process.env,
  advanced = false,
}) {
  const directory = path.dirname(path.resolve(filename));
  const existed = fs.existsSync(filename);
  const initial = existed
    ? JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, ""))
    : {};
  let config = botConfigInput.parse(initial);
  config = structuredClone(config);
  config.profile ||= {};
  config.credentials ||= {};
  const say = (message) => output(message);
  async function ask(id, label, defaultValue = "", validate, extra = {}) {
    while (true) {
      const answer =
        String(
          await prompt.ask(label, { id, defaultValue, validate, ...extra }),
        ).trim() || String(defaultValue);
      const result = validate ? await validate(answer) : true;
      if (result === true || result === undefined) return answer;
      say(
        typeof result === "string"
          ? result
          : "Valor inválido. Tente novamente.",
      );
    }
  }
  async function secret(id, label, field, envName) {
    const old = config.credentials[field] || "";
    const current = Boolean(old || env[envName]);
    const answer = await ask(
      id,
      `${label}${current ? " (Enter mantém a chave atual)" : ""}`,
      "",
      (value) =>
        value || current
          ? true
          : "Informe a chave para habilitar esta integração.",
      { secret: true, required: !current },
    );
    if (answer) config.credentials[field] = answer;
  }
  const yes = (id, label, defaultValue) =>
    prompt.confirm(label, { id, defaultValue });
  say("\nVAGA RADAR — CONFIGURAÇÃO PELO TERMINAL");
  say(
    "Suas respostas serão salvas em um JSON privado. As chaves digitadas ficam ocultas. Ctrl+C cancela sem alterar a configuração.",
  );
  config.profile.name = await ask(
    "profile.name",
    "Seu nome profissional",
    config.profile.name || "",
    (v) =>
      (v.length >= 2 && v.length <= 150) || "Informe seu nome profissional.",
  );
  config.applicant.email = await ask(
    "applicant.email",
    "E-mail para candidaturas",
    config.applicant.email || "",
    (v) => z.email().safeParse(v).success || "Informe um e-mail válido.",
  );
  let resume, sourcePath;
  const previousResume = config.applicant.resumePath
    ? path.resolve(directory, config.applicant.resumePath)
    : "";
  sourcePath = await ask(
    "applicant.resumePath",
    "Caminho do currículo PDF ou TXT (pode arrastar o arquivo para o terminal)",
    previousResume,
    async (value) => {
      try {
        sourcePath = path.resolve(directory, removeQuotes(value));
        resume = await extractResume(sourcePath);
        return true;
      } catch {
        return "Não consegui ler esse currículo. Use PDF com texto ou TXT de até 2 MB e confira o caminho.";
      }
    },
  );
  sourcePath = path.resolve(directory, removeQuotes(sourcePath));
  config.profile.summary = await ask(
    "profile.summary",
    "Resumo profissional (Enter mantém; pode deixar vazio)",
    config.profile.summary || "",
    (v) => v.length <= 10000 || "Use até 10.000 caracteres.",
  );
  const skillNames = await ask(
    "profile.skills",
    "Habilidades que você confirma possuir, separadas por vírgula",
    config.profile.skills
      ?.filter((s) => s.verified)
      .map((s) => s.name)
      .join(", ") || "",
    (v) =>
      v.split(",").filter((s) => s.trim()).length <= 100 ||
      "Use até 100 habilidades.",
  );
  const selected = [
    ...new Set(
      skillNames
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (
    !existed ||
    selected.join(", ") !==
      (config.profile.skills || [])
        .filter((s) => s.verified)
        .map((s) => s.name)
        .join(", ")
  ) {
    const criteria =
      config.profile.skills ||
      skills.map((name) => ({ name, verified: false }));
    config.profile.skills = criteria.map((s) => ({
      ...s,
      verified: selected.some(
        (name) => name.toLowerCase() === s.name.toLowerCase(),
      ),
    }));
    for (const name of selected)
      if (
        !config.profile.skills.some(
          (s) => s.name.toLowerCase() === name.toLowerCase(),
        )
      )
        config.profile.skills.push({ name, verified: true });
  }
  config.profile.seniority = await ask(
    "profile.seniority",
    "Senioridade (1 Júnior, 2 Pleno, 3 Sênior)",
    { junior: "1", mid: "2", senior: "3" }[config.profile.seniority] || "2",
    (v) => /^[123]$/.test(v) || "Escolha 1, 2 ou 3.",
  );
  config.profile.seniority = { 1: "junior", 2: "mid", 3: "senior" }[
    config.profile.seniority
  ];
  config.whatsapp.to = (
    await ask(
      "whatsapp.to",
      "Seu número do WhatsApp com país e DDD",
      config.whatsapp.to || "",
      (v) =>
        /^\d{10,15}$/.test(v.replace(/\D/g, "")) ||
        "Informe país, DDD e número, por exemplo +55 11 99999-9999.",
    )
  ).replace(/\D/g, "");

  config.workWindow.enabled = true;
  config.workWindow.startHour = Number(
    await ask(
      "workWindow.startHour",
      "Hora de início (0 a 23)",
      String(config.workWindow.startHour),
      (v) =>
        (/^\d+$/.test(v) && Number(v) <= 23) ||
        "Informe uma hora entre 0 e 23.",
    ),
  );
  config.workWindow.hours = Number(
    await ask(
      "workWindow.hours",
      "Quantas horas por dia",
      String(config.workWindow.hours),
      (v) =>
        (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 24) ||
        "Informe de 1 a 24 horas.",
    ),
  );
  config.preferences.intervalHours = Number(
    await ask(
      "preferences.intervalHours",
      "Intervalo entre buscas em horas (1,2,3,4,6,8,12,24)",
      String(config.preferences.intervalHours || 1),
      (v) =>
        ["1", "2", "3", "4", "6", "8", "12", "24"].includes(v) ||
        "Escolha um dos intervalos indicados.",
    ),
  );
  if (config.sources === undefined) {
    const useExamples = await yes(
      "sources.useExamples",
      "Começar com os quadros públicos VTEX, CI&T e Ashby?",
      true,
    );
    config.sources = useExamples
      ? [
          {
            provider: "greenhouse",
            board: "vtex",
            company: "VTEX",
            enabled: true,
          },
          {
            provider: "lever",
            board: "ciandt",
            company: "CI&T",
            enabled: true,
          },
          {
            provider: "ashby",
            board: "ashby",
            company: "Ashby",
            enabled: true,
          },
        ]
      : [];
  }

  config.ai.enabled = await yes(
    "ai.enabled",
    "Usar GPT para interpretar vagas e levantar dúvidas?",
    config.ai.enabled,
  );
  if (config.ai.enabled) {
    await secret(
      "ai.openaiApiKey",
      "Chave da API OpenAI",
      "openaiApiKey",
      config.ai.apiKeyEnv,
    );
    config.ai.model = await ask(
      "ai.model",
      "Modelo GPT",
      config.ai.model,
      (v) =>
        /^[a-zA-Z0-9_.:-]{1,100}$/.test(v) ||
        "Informe um identificador de modelo válido.",
    );
  }
  if (advanced) {
    config.whatsapp.enabled = await yes(
      "whatsapp.enabled",
      "Configurar agora a API oficial do WhatsApp Business?",
      config.whatsapp.enabled,
    );
    if (config.whatsapp.enabled) {
      say(
        "O número pessoal é o destino das perguntas. Para enviar/receber pela API, use o número Business e a app Meta já cadastrados.",
      );
      config.whatsapp.phoneNumberId = await ask(
        "whatsapp.phoneNumberId",
        "Phone Number ID da Meta",
        config.whatsapp.phoneNumberId,
        (v) =>
          /^\d{5,30}$/.test(v) || "Informe o ID numérico do número Business.",
      );
      await secret(
        "whatsapp.whatsappAccessToken",
        "Token de acesso do WhatsApp Business",
        "whatsappAccessToken",
        config.whatsapp.accessTokenEnv,
      );
      await secret(
        "whatsapp.metaAppSecret",
        "App Secret da Meta (valida respostas)",
        "metaAppSecret",
        "VAGA_META_APP_SECRET",
      );
      if (
        !config.credentials.whatsappVerifyToken &&
        !env.VAGA_WHATSAPP_VERIFY_TOKEN
      )
        config.credentials.whatsappVerifyToken =
          randomBytes(32).toString("hex");
      config.whatsapp.templateName = await ask(
        "whatsapp.templateName",
        "Nome do template aprovado (dois parâmetros)",
        config.whatsapp.templateName,
        (v) =>
          /^[a-z0-9_]{1,100}$/.test(v) ||
          "Use o nome do template cadastrado na Meta.",
      );
      config.whatsapp.webhookUrl = await ask(
        "whatsapp.webhookUrl",
        "URL pública HTTPS do webhook (Enter deixa para depois)",
        config.whatsapp.webhookUrl || "",
        (v) => {
          if (!v) return true;
          try {
            const u = new URL(v);
            return (
              (u.protocol === "https:" &&
                u.pathname.endsWith("/webhook") &&
                !u.username &&
                !u.password) ||
              "Use uma URL HTTPS terminada em /webhook."
            );
          } catch {
            return "Use uma URL HTTPS terminada em /webhook.";
          }
        },
      );
      config.whatsapp.autoStartWebhook = Boolean(config.whatsapp.webhookUrl);
      if (!config.whatsapp.webhookUrl && !initial.whatsapp?.enabled) {
        config.whatsapp.enabled = false;
        say(
          "Credenciais do WhatsApp serão guardadas. Canal desativado até configurar um webhook HTTPS público.",
        );
      } else
        say(
          "O receptor local será iniciado junto do bot. A URL HTTPS e o template precisam estar conectados/aprovados na Meta.",
        );
    } else config.whatsapp.autoStartWebhook = false;

    const autoApply = await yes(
      "autoApply.enabled",
      "Você possui uma integração Lever autorizada pela empresa para enviar candidaturas?",
      config.autoApply.enabled,
    );
    config.autoApply.enabled = Boolean(autoApply);
    if (autoApply) {
      const board = await ask(
        "autoApply.board",
        "Identificador do quadro Lever autorizado",
        config.autoApply.sources[0]?.board || "",
        (v) =>
          /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(v) ||
          "Informe o identificador do quadro.",
      );
      config.autoApply.sources = [
        {
          provider: "lever",
          board,
          apiKeyEnv: config.autoApply.sources[0]?.apiKeyEnv || "VAGA_LEVER_KEY",
          authorizationConfirmed: true,
        },
      ];
      await secret(
        "autoApply.leverApiKey",
        "Chave da integração Lever da empresa",
        "leverApiKey",
        config.autoApply.sources[0].apiKeyEnv,
      );
    }
  } else if (!config.whatsapp.enabled) {
    say(
      "Número pessoal salvo como destino. WhatsApp não conectado: falta um serviço remetente autenticado. Nenhum QR code ou cadastro Business será solicitado neste assistente.",
    );
  }

  config.setup = { completed: true, version: 1 };
  config = botConfigInput.parse(config);
  // Validação completa antes de gravar: cancelamento ou erro preservam o JSON anterior.
  const dataDir = path.resolve(directory, config.dataDir);
  const extension = resume.format === "pdf" ? ".pdf" : ".txt";
  const destination = path.join(
    dataDir,
    "resumes",
    `original-${resume.sha256}${extension}`,
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  let copied = false;
  if (path.resolve(sourcePath) !== destination && !fs.existsSync(destination)) {
    fs.copyFileSync(sourcePath, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
    copied = true;
  }
  config.applicant.resumePath = path.relative(directory, destination);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = filename + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, filename);
    fs.chmodSync(filename, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {}
    if (copied)
      try {
        fs.unlinkSync(destination);
      } catch {}
    throw error;
  }
  say("\nConfiguração salva. Currículo copiado para a pasta privada do bot.");
  say(
    "As chaves ficam no JSON privado, sem aparecer no terminal. Não compartilhe esse arquivo.",
  );
  say(
    `Rotina: ${config.workWindow.startHour}h, ${config.workWindow.hours} horas/dia, fuso ${config.workWindow.timeZone}.`,
  );
  say("O terminal continuará aberto. Ctrl+C encerra o bot.");
  return config;
}

export { SetupCancelled };
