import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { botConfigInput } from "./config.js";
import { extractResume } from "../resume/index.js";
import { skills } from "../config.js";
import { SetupCancelled } from "../terminal/prompts.js";
import { createTerminalUI } from "../terminal/ui.js";

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
  config.notifications ||= { channel: "whatsapp", requireConnection: true };
  config.sms ||= { enabled: false, accountSidEnv: "VAGA_TWILIO_ACCOUNT_SID", authTokenEnv: "VAGA_TWILIO_AUTH_TOKEN", from: "", to: "", pollIntervalSeconds: 15 };
  const ui = createTerminalUI({ output });
  const say = (message) => ui.info(message);
  const step = (index, title, detail) => ui.step(index, 7, title, detail);
  async function ask(id, label, defaultValue = "", validate, extra = {}) {
    while (true) {
      const answer =
        String(
          await prompt.ask(label, { id, defaultValue, ...extra }),
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
  async function secret(id, label, field, envName, validate) {
    const old = config.credentials[field] || "";
    const current = Boolean(old || env[envName]);
    const answer = await ask(
      id,
      `${label}${current ? " (Enter mantém a chave atual)" : ""}`,
      "",
      (value) => {
        if (!value) return current || "Informe a chave para habilitar esta integração.";
        return validate ? validate(value) : true;
      },
      { secret: true, required: !current },
    );
    if (answer) config.credentials[field] = answer;
  }
  const yes = (id, label, defaultValue) =>
    prompt.confirm(label, { id, defaultValue });
  ui.header("VAGA RADAR", "Configuração guiada");
  say("Vamos configurar uma etapa por vez. Enter mantém o valor mostrado; Ctrl+C cancela sem salvar.");
  step(1, "Seu perfil", "Use apenas informações profissionais reais.");
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
  step(2, "Currículo", "A leitura do arquivo precisa terminar antes de continuar.");
  let resume, sourcePath;
  const previousResume = config.applicant.resumePath
    ? path.resolve(directory, config.applicant.resumePath)
    : "";
  sourcePath = await ask(
    "applicant.resumePath",
    "Arraste o currículo PDF/TXT para esta janela ou informe o caminho",
    previousResume,
    async (value) => {
      try {
        ui.info("Lendo o currículo... aguarde.");
        sourcePath = path.resolve(directory, removeQuotes(value));
        resume = await extractResume(sourcePath);
        return true;
      } catch {
        return "Não consegui ler esse currículo. Use PDF com texto ou TXT de até 2 MB e confira o caminho.";
      }
    },
  );
  sourcePath = path.resolve(directory, removeQuotes(sourcePath));
  ui.success(`Currículo legível: ${path.basename(sourcePath)} (${resume.text.length.toLocaleString("pt-BR")} caracteres de texto).`);
  say("O original será preservado. Uma cópia privada será criada somente ao salvar a configuração.");
  if (!await yes("resume.confirm", "Continuar com este currículo?", true))
    throw new SetupCancelled();

  step(3, "Rotina de busca", "A busca é contínua dentro do horário escolhido.");

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
  config.search.continuous = true;
  say("Busca contínua durante o horário configurado, respeitando os limites das fontes.");
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

  step(4, "Como receber perguntas", "Escolha um canal. A conexão será verificada antes de iniciar as buscas.");
  say("1. WhatsApp pessoal: conexão por QR code.");
  say("2. SMS: exige conta Twilio, token e número remetente habilitado para SMS.");
  say("3. Somente terminal: responda aqui, sem conectar um serviço externo.");
  const currentChannel = existed ? config.notifications.channel || (config.sms.enabled ? "sms" : "whatsapp") : "whatsapp";
  const selectedChannel = await ask(
    "notifications.channel", "Canal de perguntas (1, 2 ou 3)",
    { whatsapp: "1", sms: "2", terminal: "3" }[currentChannel] || "1",
    (value) => /^[123]$/.test(value) || "Escolha 1, 2 ou 3.",
  );
  config.notifications = { channel: { 1: "whatsapp", 2: "sms", 3: "terminal" }[selectedChannel], requireConnection: true };
  if (config.notifications.channel !== "terminal") {
    const number = await ask(
      "whatsapp.to", "Seu número com país e DDD",
      config.notifications.channel === "sms" ? config.sms.to || config.whatsapp.to || "" : config.whatsapp.to || "",
      (value) => (/^[+\d\s().-]+$/.test(value) && /^[1-9]\d{7,14}$/.test(value.replace(/\D/g, ""))) || "Informe país, DDD e número, por exemplo +55 11 99999-9999.",
    );
    config.whatsapp.to = number.replace(/\D/g, "");
    if (config.notifications.channel === "sms") config.sms.to = "+" + config.whatsapp.to;
  }
  config.sms.enabled = config.notifications.channel === "sms";
  if (config.notifications.channel === "sms") {
    config.whatsapp.enabled = false;
    config.whatsapp.autoStartWebhook = false;
    say("SMS não conecta apenas com o telefone. Use uma conta Twilio própria; o serviço pode cobrar pelas mensagens.");
    await secret("sms.twilioAccountSid", "Account SID da Twilio", "twilioAccountSid", config.sms.accountSidEnv, (value) => /^AC[a-fA-F0-9]{32}$/.test(value) || "O Account SID começa com AC e tem 32 caracteres hexadecimais depois do prefixo.");
    await secret("sms.twilioAuthToken", "Auth Token da Twilio", "twilioAuthToken", config.sms.authTokenEnv);
    config.sms.from = "+" + (await ask(
      "sms.from", "Número Twilio remetente com país e DDD", config.sms.from,
      (value) => /^\+?[1-9]\d{7,14}$/.test(value.replace(/[\s()-]/g, "")) || "Informe o número remetente SMS da sua conta Twilio.",
    )).replace(/\D/g, "");
    ui.success("Dados de SMS preenchidos. O envio e a resposta ainda serão testados.");
  } else if (config.notifications.channel === "terminal") {
    config.whatsapp.enabled = false;
    config.whatsapp.autoStartWebhook = false;
    ui.success("Perguntas serão apresentadas no próprio terminal.");
  }

  step(5, "GPT opcional", "Pode continuar sem uma API de inteligência artificial.");

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
  step(6, "Candidaturas", "Escolha se o bot poderá enviar os formulários compatíveis.");
  if (advanced) {
    config.whatsapp.enabled = await yes(
      "whatsapp.enabled",
      "Configurar agora a API oficial do WhatsApp Business?",
      config.whatsapp.enabled,
    );
    if (config.whatsapp.enabled) {
      config.notifications.channel = "whatsapp";
      config.sms.enabled = false;
      config.whatsapp.transport = "cloud";
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
      config.autoApply.mode = "api";
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
  } else {
    if (config.notifications.channel === "whatsapp" && (!initial.whatsapp?.enabled || config.whatsapp.transport === "personal")) {
      config.whatsapp.transport = "personal";
      config.whatsapp.enabled = true;
      config.whatsapp.autoStartWebhook = false;
    }
    if (config.notifications.channel === "whatsapp") say(
      config.whatsapp.transport === "personal"
        ? "WhatsApp pessoal selecionado. Na próxima etapa, leia o QR code e aguarde a confirmação da conexão."
        : "Integração WhatsApp Cloud existente preservada.",
    );
    config.autoApply.enabled = await yes(
      "autoApply.enabled",
      "Enviar candidaturas automaticamente nos formulários Lever compatíveis? Dados importantes ausentes serão perguntados pelo canal escolhido.",
      initial.autoApply?.enabled ?? true,
    );
    if (config.autoApply.enabled && !initial.autoApply?.enabled)
      config.autoApply.mode = "browser";

  }

  step(7, "Revisar e salvar", "Confira as escolhas antes de iniciar a conexão e a rotina.");
  ui.status("Nome", config.profile.name);
  ui.status("E-mail", config.applicant.email);
  ui.status("Currículo", path.basename(sourcePath));
  ui.status("Rotina", `${config.workWindow.startHour}h, ${config.workWindow.hours} horas/dia — ${config.workWindow.timeZone}`);
  ui.status("Perguntas", { whatsapp: "WhatsApp", sms: "SMS", terminal: "Terminal" }[config.notifications.channel]);
  ui.status("GPT", config.ai.enabled ? "Ativado" : "Desativado");
  ui.status("Candidaturas", config.autoApply.enabled ? "Envio automático nos conectores compatíveis" : "Preparar para revisão");
  say("As chaves ficam no JSON local privado. Nenhuma chave aparece neste resumo.");
  if (!await yes("setup.confirm", "Salvar esta configuração e continuar?", true))
    throw new SetupCancelled();

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
  ui.success("Configuração salva e currículo copiado para a pasta privada.");
  say(
    "As chaves ficam no JSON privado, sem aparecer no terminal. Não compartilhe esse arquivo.",
  );
  say(
    `Rotina: ${config.workWindow.startHour}h, ${config.workWindow.hours} horas/dia, fuso ${config.workWindow.timeZone}.`,
  );
  say("A seguir, o aplicativo verificará o canal escolhido. As buscas só começam quando essa etapa terminar.");
  return config;
}

export { SetupCancelled };
