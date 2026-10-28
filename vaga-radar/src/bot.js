import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export async function main(args = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        help: { type: "boolean", short: "h" },
        config: { type: "string" },
        once: { type: "boolean" },
        watch: { type: "boolean" },
        "collect-only": { type: "boolean" },
        "whatsapp-webhook": { type: "boolean" },
        setup: { type: "boolean" },
        "advanced-setup": { type: "boolean" },
        "connect-whatsapp": { type: "boolean" },
        "reset-whatsapp": { type: "boolean" },
        "check-whatsapp": { type: "boolean" },
        "test-whatsapp": { type: "boolean" },
        doctor: { type: "boolean" },
      },
    }));
  } catch {
    console.error("Argumentos inválidos. Use --help.");
    return 2;
  }
  if (values.help) {
    console.log(
      "Vaga Radar Bot — assistente no terminal\nUso: VagaRadar.exe [--setup] [--config arquivo.json] [--once | --watch] [--collect-only]\n--connect-whatsapp ativa WhatsApp pessoal e mostra QR code.\n--reset-whatsapp remove somente a sessão local para conectar novamente.\n--check-whatsapp verifica a conexão sem mensagens; --test-whatsapp confirma envio e resposta pelo celular.\n--setup altera dados/chaves; --advanced-setup configura API Cloud/Lever da empresa.\nDigite vagas, candidaturas, vaga ID ou ajuda no terminal ou na conversa com você mesmo.\nBusca contínua durante a janela diária, respeitando limites das fontes. Mantenha o terminal aberto. Ctrl+C encerra.\nCandidaturas: formulários Lever compatíveis ou API autorizada. Envio só é registrado após confirmação da plataforma.\nNo Node: npm start ou npm run bot -- --setup",
    );
    return 0;
  }
  if (values.doctor) {
    const { runDoctor } = await import("./bot/doctor.js");
    return await runDoctor() ? 0 : 2;
  }
  if (values.once && values.watch) {
    console.error("Escolha --once ou --watch.");
    return 2;
  }
  const base = process.env.VAGA_RADAR_PORTABLE_DIR || process.cwd();
  const filename = path.resolve(
    values.config || path.join(base, "bot.config.json"),
  );
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const diagnostic = values["check-whatsapp"] || values["test-whatsapp"];
  if ((values["check-whatsapp"] && values["test-whatsapp"]) ||
      (diagnostic && (values.once || values.watch || values["collect-only"] || values["whatsapp-webhook"]))) {
    console.error("Execute o diagnóstico WhatsApp separadamente dos ciclos de busca.");
    return 2;
  }
  if (diagnostic && !fs.existsSync(filename)) {
    console.error("Configure primeiro com --setup para informar o seu número.");
    return 2;
  }
  const earlyDotenv = await import("dotenv");
  earlyDotenv.config({ path: path.join(path.dirname(filename), ".env"), quiet: true });
  let setupNeeded =
    values.setup || values["advanced-setup"] || !fs.existsSync(filename);
  if (
    interactive &&
    !diagnostic &&
    !values["connect-whatsapp"] &&
    !values["reset-whatsapp"] &&
    !values.once &&
    !values["whatsapp-webhook"] &&
    fs.existsSync(filename)
  ) {
    try {
      const raw = JSON.parse(
        fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, ""),
      );
      if (!raw.setup?.completed && !raw.applicant?.resumePath)
        setupNeeded = true;
    } catch {
      /* O erro de arquivo será apresentado na validação. */
    }
  }
  if ((values.setup || values["advanced-setup"]) && !interactive) {
    console.error(
      "O assistente precisa de um terminal interativo. Abra o .exe ou execute --setup no seu terminal.",
    );
    return 2;
  }
  if (setupNeeded && interactive) {
    const { createTerminalPrompt } = await import("./terminal/prompts.js");
    const { runSetup } = await import("./bot/setup.js");
    const prompt = createTerminalPrompt();
    try {
      await runSetup({
        filename,
        prompt,
        advanced: Boolean(values["advanced-setup"]),
      });
    } catch (error) {
      console.error(
        error.code === "SETUP_CANCELLED"
          ? "Configuração cancelada. Arquivos anteriores preservados."
          : "Não foi possível salvar a configuração. Confira os dados e as permissões da pasta.",
      );
      return error.code === "SETUP_CANCELLED" ? 130 : 2;
    } finally {
      prompt.close();
    }
  }
  if (!fs.existsSync(filename)) {
    const template = fileURLToPath(
      new URL("../bot.example.json", import.meta.url),
    );
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filename, fs.readFileSync(template), {
      flag: "wx",
      mode: 0o600,
    });
    console.error(
      "Configuração inicial criada. Preencha seu perfil, currículo e fontes no arquivo bot.config.json; execute novamente. Nenhum envio foi feito.",
    );
    return 2;
  }
  if (!values.once && !values["whatsapp-webhook"] && !diagnostic) values.watch = true;
  const [
    { readBotConfig, applyBotConfig },
    { acquireBotLock },
    { openDatabase },
    { createStore },
    { createCollector },
    { runBotCycle, recoverInterruptedSubmissions },
    dotenv,
    { applyLocalCredentials },
  ] = await Promise.all([
    import("./bot/config.js"),
    import("./bot/lock.js"),
    import("./database/index.js"),
    import("./database/store.js"),
    import("./services/collector.js"),
    import("./bot/worker.js"),
    import("dotenv"),
    import("./bot/credentials.js"),
  ]);
  dotenv.config({
    path: path.join(path.dirname(filename), ".env"),
    quiet: true,
  });
  if (values["whatsapp-webhook"]) {
    try {
      const { startWhatsAppServer } = await import("./whatsapp-server.js");
      const config = readBotConfig(filename);
      applyLocalCredentials(config);
      await startWhatsAppServer({ dataDir: config.dataDir, whatsapp: config.whatsapp });
      return 0;
    } catch {
      console.error(
        "Webhook não iniciado. Configure os segredos locais, o remetente e uma porta disponível.",
      );
      return 2;
    }
  }
  const { inWorkWindow } = await import("./bot/schedule.js");
  const controller = new AbortController();
  let db,
    collector,
    release,
    stopping = false,
    timer,
    wake;
  let webhook;
  let personal;
  let terminalAnswers;
  const stop = () => {
    stopping = true;
    controller.abort();
    collector?.stop();
    clearTimeout(timer);
    wake?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    let config = readBotConfig(filename);
    applyLocalCredentials(config);
    release = acquireBotLock(config.dataDir);
    if (values["connect-whatsapp"] || values["reset-whatsapp"]) {
      const { connectPersonalWhatsApp } = await import("./bot/connect-whatsapp.js");
      let prompt;
      if (interactive) {
        const { createTerminalPrompt } = await import("./terminal/prompts.js");
        prompt = createTerminalPrompt();
      }
      try { await connectPersonalWhatsApp(filename, { prompt }); }
      finally { prompt?.close(); }
      config = readBotConfig(filename);
      applyLocalCredentials(config);
      if (values["reset-whatsapp"]) {
        const { resetPersonalWhatsAppSession } = await import("./messaging/personal.js");
        resetPersonalWhatsAppSession({ dataDir: config.dataDir });
      }
    }
    const connectionConfig = JSON.stringify([config.whatsapp, config.credentials?.whatsappAccessToken, config.credentials?.whatsappVerifyToken, config.credentials?.metaAppSecret, config.search]);
    db = openDatabase(path.join(config.dataDir, "radar.sqlite"));
    recoverInterruptedSubmissions(db);
    const store = createStore(db),
      logger = {
        warn() {
          console.error("Uma fonte falhou; consulte reports/latest.json.");
        },
      };
    collector = createCollector(store, { logger, autoScheduleEnabled: false, continuous: config.search.continuous });
    const { formatTracking } = await import("./bot/tracking.js");
    const { acceptWhatsAppAnswer, recordWhatsAppStatus } = await import("./bot/questions.js");
    if (config.whatsapp.enabled && config.whatsapp.transport === "personal" && !values["collect-only"]) {
      const { startPersonalWhatsApp } = await import("./messaging/personal.js");
      personal = await startPersonalWhatsApp({
        dataDir: config.dataDir, to: config.whatsapp.to, signal: controller.signal,
        onAnswer: (input) => acceptWhatsAppAnswer(db, input),
        onStatus: (input) => recordWhatsAppStatus(db, input),
        onCommand: (command) => formatTracking(db, command),
      });
    }
    if (config.whatsapp.enabled && config.whatsapp.transport === "cloud" && config.whatsapp.autoStartWebhook) {
      const { startWhatsAppServer } = await import("./whatsapp-server.js");
      webhook = await startWhatsAppServer({ dataDir: config.dataDir, whatsapp: config.whatsapp });
    }
    if (diagnostic) {
      const { inspectWhatsAppConfig, checkWhatsAppConnection } = await import("./messaging/diagnostics.js");
      const inspected = inspectWhatsAppConfig(config.whatsapp);
      if (!inspected.ready) {
        for (const issue of inspected.issues) console.error(issue.message);
        console.error("Use --connect-whatsapp para conectar sua conta pessoal por QR code.");
        return 2;
      }
      if (personal) {
        console.log("Aguardando conexão WhatsApp. Leia o QR code se for solicitado. Ctrl+C cancela.");
        if (!await personal.waitUntilReady({ signal: controller.signal })) return 2;
      } else {
        const checked = await checkWhatsAppConnection(config.whatsapp, { signal: controller.signal });
        if (!checked.ready) {
          for (const issue of checked.issues) console.error(issue.message);
          return 2;
        }
      }
      if (values["check-whatsapp"]) {
        console.log("Conexão autenticada. Para confirmar envio e recebimento, execute --test-whatsapp.");
        return 0;
      }
      const { verifyWhatsAppRoundTrip } = await import("./messaging/verify.js");
      const result = await verifyWhatsAppRoundTrip(db, config.whatsapp, {
        signal: controller.signal, ...(personal ? { sender: personal.sendQuestion } : {}),
      });
      return result.ok ? 0 : 2;
    }
    if (interactive) {
      console.log(
        "\nVaga Radar em execução. Mantenha esta janela aberta. Ctrl+C encerra com segurança.",
      );
      console.log(
        `Rotina: ${config.workWindow.startHour}h, ${config.workWindow.hours} horas/dia (${config.workWindow.timeZone}).`,
      );
      console.log(
        `GPT: ${config.ai.enabled ? "configurado" : "desativado"} | WhatsApp: ${config.whatsapp.enabled ? (personal ? "pessoal; confira o QR/conexão acima" : "Cloud; depende de webhook/template Meta") : "desativado"}`,
      );
      const { startTerminalAnswers } = await import("./terminal/answers.js");
      terminalAnswers = startTerminalAnswers(db, { onStop: stop, onCommand: (command) => formatTracking(db, command) });
    }
    const shownQuestions = new Set();
    let lastRun = 0,
      lastConfig = 0,
      lastAnswers = 0,
      outsideReported = false;
    do {
      const current = readBotConfig(filename);
      if (current.dataDir !== config.dataDir)
        throw new Error("Encerre o bot antes de alterar dataDir");
      if (JSON.stringify([current.whatsapp, current.credentials?.whatsappAccessToken, current.credentials?.whatsappVerifyToken, current.credentials?.metaAppSecret, current.search]) !== connectionConfig)
        throw Object.assign(new Error("Reinicie para aplicar alterações do WhatsApp ou da busca."), { code: "RESTART_REQUIRED" });
      config = current;
      applyLocalCredentials(config);
      const modified = fs.statSync(filename).mtimeMs;
      if (modified !== lastConfig) {
        applyBotConfig(store, config);
        lastConfig = modified;
      }
      const prefs = store.getSettings();
      const within = inWorkWindow(config.workWindow);
      const answerCount = db
        .prepare("SELECT COUNT(*) AS n FROM whatsapp_inbound_messages")
        .get().n;
      const answered = answerCount !== lastAnswers;
      lastAnswers = answerCount;
      if (!within && !outsideReported) {
        console.log(
          interactive
            ? `Fora do horário de trabalho. Aguardando ${config.workWindow.startHour}h (${config.workWindow.timeZone}). A janela deve continuar aberta.`
            : JSON.stringify({
                state: "outside_work_window",
                startHour: config.workWindow.startHour,
                hours: config.workWindow.hours,
                timeZone: config.workWindow.timeZone,
              }),
        );

        outsideReported = true;
      }
      if (!within && !values.watch) return 0;
      if (
        within &&
        ((config.search.continuous && Date.parse(collector.nextCheckAt || 0) <= Date.now()) || !lastRun ||
          answered ||
          Date.now() - lastRun >= prefs.intervalHours * 36e5)
      ) {
        outsideReported = false;
        const result = await runBotCycle(store, collector, config, {
          collectOnly: Boolean(values["collect-only"]),
          skipCollection: Boolean(lastRun && answered),
          signal: controller.signal,
          ...(personal ? { questionSender: personal.sendQuestion } : {}),
        });
        if (!answered || !lastRun) lastRun = Date.now();
        console.log(
          interactive
            ? `Ciclo concluído: ${result.collection.received} recebidas, ${result.prepared} preparadas, ${result.submitted} enviadas, ${result.pending.length} pendências. ${config.search.continuous ? "Busca contínua ativa." : `Próxima busca em até ${prefs.intervalHours}h.`} Ctrl+C para encerrar.`
            : JSON.stringify({
                collection: result.collection.status,
                received: result.collection.received,
                prepared: result.prepared,
                submitted: result.submitted,
                pending: result.pending.length,
              }),
        );
        if (!values.watch)
          return ["partial", "failed"].includes(result.collection.status)
            ? 1
            : 0;
      }
      if (within && !values["collect-only"] && !controller.signal.aborted) {
        const { notifyQuestions } = await import("./bot/questions.js");
        await notifyQuestions(db, config.whatsapp, {
          signal: controller.signal, ...(personal ? { sender: personal.sendQuestion } : {}),
        });
      }
      if (interactive) {
        const pending = db
          .prepare(
            "SELECT id,text FROM bot_questions WHERE answer IS NULL AND topic!='whatsapp_test' ORDER BY created_at LIMIT 5",
          )
          .all();
        for (const question of pending)
          if (!shownQuestions.has(question.id)) {
            shownQuestions.add(question.id);
            console.log(
              `Dúvida ${question.id}: ${question.text.replace(/[\u0000-\u001f\u007f]/g, " ")}`,
            );
            console.log(`Responda aqui com ${question.id}: sua resposta`);
          }
      }
      if (!stopping)
        await new Promise((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, 10000);
        });
    } while (!stopping);
    return 0;
  } catch (error) {
    if (error.name === "ZodError" || error instanceof SyntaxError)
      console.error(
        "Configuração inválida. Confira o formato e os campos de bot.config.json.",
      );
    else if (error.code === "ENOENT")
      console.error(
        "Arquivo local não encontrado. Confira os caminhos da configuração.",
      );
    else if (error.code === "RESTART_REQUIRED" || error.code === "RECIPIENT_REQUIRED")
      console.error(error.message);
    else
      console.error(
        "Não foi possível executar o bot. Confira a configuração, as permissões locais e se já existe um bot ativo.",
      );
    return 2;
  } finally {
    terminalAnswers?.close();
    collector?.stop();
    if (personal) await personal.close();
    if (webhook) await webhook.close();
    db?.close();
    release?.();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

export async function runCLI(args = process.argv.slice(2)) {
  const code = await main(args);
  if (
    code !== 0 &&
    code !== 130 &&
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    !args.includes("--help") &&
    !args.includes("-h") &&
    !args.includes("--once")
  ) {
    const { createInterface } = await import("node:readline/promises");
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      await terminal.question("Pressione Enter para fechar esta janela...");
    } finally {
      terminal.close();
    }
  }
  return code;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await runCLI();
