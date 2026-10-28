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
        "sms-setup": { type: "boolean" },
        "check-sms": { type: "boolean" },
        "test-sms": { type: "boolean" },
      },
    }));
  } catch {
    console.error("Argumentos inválidos. Use --help.");
    return 2;
  }
  if (values.help) {
    console.log(
      "Vaga Radar Bot — assistente no terminal\nMenu: 1 vagas, 2 candidaturas, 3 perguntas, 4 ajuda, 0 encerrar.\n--sms-setup configura SMS; --check-sms verifica a conta; --test-sms confirma envio e resposta.\nUso: VagaRadar.exe [--setup] [--config arquivo.json] [--once | --watch] [--collect-only]\n--connect-whatsapp ativa WhatsApp pessoal e mostra QR code.\n--reset-whatsapp remove somente a sessão local para conectar novamente.\n--check-whatsapp verifica a conexão sem mensagens; --test-whatsapp confirma envio e resposta pelo celular.\n--setup altera dados/chaves; --advanced-setup configura API Cloud/Lever da empresa.\nDigite vagas, candidaturas, vaga ID ou ajuda no terminal ou na conversa com você mesmo.\nBusca contínua durante a janela diária, respeitando limites das fontes. Mantenha o terminal aberto. Ctrl+C encerra.\nCandidaturas: formulários Lever compatíveis ou API autorizada. Envio só é registrado após confirmação da plataforma.\nNo Node: npm start ou npm run bot -- --setup",
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
  const diagnostic = values["check-whatsapp"] || values["test-whatsapp"] || values["check-sms"] || values["test-sms"];
  const smsDiagnostic = values["check-sms"] || values["test-sms"];
  if (["check-whatsapp", "test-whatsapp", "check-sms", "test-sms"].filter((key) => values[key]).length > 1) {
    console.error("Execute apenas um teste de canal por vez."); return 2;
  }
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
    !values["sms-setup"] &&
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
  if ((values.setup || values["advanced-setup"] || values["sms-setup"]) && !interactive) {
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
  const { createTerminalUI } = await import("./terminal/ui.js");
  const { createTerminalPrompt } = await import("./terminal/prompts.js");
  const ui = interactive ? createTerminalUI() : {
    header() {}, step() {}, status() {}, success() {}, summary() {}, menu() {},
    info: diagnostic ? console.log : () => {}, error: console.error, raw: console.log,
    withExclusive: (action) => action(), suspend: () => () => {},
  };
  const controller = new AbortController();
  let db, collector, release, messaging, terminalAnswers;
  let stopping = false, timer, wake;
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
    ui.header("VAGA RADAR", "Uma etapa por vez. Mantenha esta janela aberta.");
    ui.step(1, 4, "Conferir seus dados");
    let config = readBotConfig(filename);
    applyLocalCredentials(config);
    release = acquireBotLock(config.dataDir);
    const promptFactory = () => createTerminalPrompt();
    async function configureSms(current) {
      const { runSmsSetup } = await import("./bot/sms-setup.js");
      const prompt = promptFactory();
      const resumeOutput = ui.suspend();
      try {
        const updated = await runSmsSetup({ filename, config: current, prompt });
        applyLocalCredentials(updated);
        return updated;
      } finally { prompt.close(); resumeOutput(); }
    }
    if (values["sms-setup"]) config = await configureSms(config);
    if (values["connect-whatsapp"] || values["reset-whatsapp"]) {
      const { connectPersonalWhatsApp } = await import("./bot/connect-whatsapp.js");
      const prompt = interactive ? promptFactory() : undefined;
      try { await connectPersonalWhatsApp(filename, { prompt }); }
      finally { prompt?.close(); }
      config = readBotConfig(filename);
      applyLocalCredentials(config);
      if (values["reset-whatsapp"]) {
        const { resetPersonalWhatsAppSession } = await import("./messaging/personal.js");
        resetPersonalWhatsAppSession({ dataDir: config.dataDir });
      }
    }
    db = openDatabase(path.join(config.dataDir, "radar.sqlite"));
    recoverInterruptedSubmissions(db);
    const store = createStore(db);
    const { formatTracking } = await import("./bot/tracking.js");
    const { prepareMessaging, notificationConfigFor } = await import("./bot/startup.js");
    ui.success("Configuracao carregada. Seus arquivos pessoais foram preservados.");
    if (diagnostic) config = { ...config, notifications: { channel: smsDiagnostic ? "sms" : "whatsapp", requireConnection: true } };
    if (!values["collect-only"]) {
      messaging = await prepareMessaging({
        config, db, signal: controller.signal, ui, interactive: interactive && !diagnostic,
        promptFactory, configureSms,
        useTerminal: async () => {
          const { selectTerminalNotifications } = await import("./bot/connect-whatsapp.js");
          selectTerminalNotifications(filename);
          ui.info("O canal terminal foi salvo para os proximos inicios. Voce pode mudar pelo assistente --setup.");
          return readBotConfig(filename);
        },
        onCommand: (command) => formatTracking(db, command),
      });
      if (!messaging.ready) {
        if (diagnostic && !smsDiagnostic) console.error("Use --connect-whatsapp ou --setup para configurar o canal.");
        return stopping ? 0 : 2;
      }
      config = messaging.config;
    } else {
      ui.step(2, 4, "Coleta isolada", "Nenhuma mensagem ou candidatura sera enviada.");
      messaging = { ready: true, channel: "terminal", notificationConfig: notificationConfigFor(config, "terminal"),
        getState: () => ({ ready: true, state: "terminal" }), poll: async () => {}, close: async () => {} };
    }
    if (diagnostic) {
      if (values["check-whatsapp"] || values["check-sms"]) {
        ui.success("Canal autenticado. Use o teste de envio e resposta para confirmar que as mensagens chegam ao celular.");
        if (!interactive) console.log("Canal autenticado; entrega e resposta ainda nao verificadas.");
        return 0;
      }
      const { verifyWhatsAppRoundTrip } = await import("./messaging/verify.js");
      const result = await verifyWhatsAppRoundTrip(db, messaging.notificationConfig, {
        signal: controller.signal, sender: messaging.questionSender, poll: messaging.poll,
        output: (message) => interactive ? ui.info(message) : console.log(message),
      });
      return result.ok ? 0 : 2;
    }
    // A fallback is an explicit session choice; keep the persisted preference
    // for next start and detect real file changes independently.
    const connectionSignature = (value) => JSON.stringify([
      value.whatsapp, value.sms, value.notifications, value.credentials?.whatsappAccessToken,
      value.credentials?.whatsappVerifyToken, value.credentials?.metaAppSecret,
      value.credentials?.twilioAccountSid, value.credentials?.twilioAuthToken, value.search,
    ]);
    const initialSignature = connectionSignature(readBotConfig(filename));
    ui.step(3, 4, "Preparar a rotina");
    applyBotConfig(store, config);
    collector = createCollector(store, {
      logger: { warn: () => ui.error("Uma fonte esta indisponivel. As demais continuam; consulte o acompanhamento.") },
      autoScheduleEnabled: false, continuous: config.search.continuous,
    });
    ui.status("Horario", config.workWindow.enabled
      ? `${config.workWindow.startHour}h, ${config.workWindow.hours} horas por dia (${config.workWindow.timeZone})`
      : "Sem restricao de horario");
    ui.status("Avisos", messaging.channel === "sms" ? "SMS" : messaging.channel === "whatsapp" ? "WhatsApp" : "Terminal");
    ui.step(4, 4, "Pronto para trabalhar");
    ui.success("Preparacao concluida. A busca pode comecar.");
    if (interactive) {
      ui.menu();
      const { startTerminalAnswers } = await import("./terminal/answers.js");
      terminalAnswers = startTerminalAnswers(db, {
        ui, onStop: stop,
        onCommand: (command) => formatTracking(db, command),
      });
    }
    let lastRun = 0, lastConfig = fs.statSync(filename).mtimeMs, lastAnswers = 0;
    let outsideReported = false, offlineReported = false, shownQuestions = "";
    const progressLabels = {
      collection: "Buscando vagas", resume: "Lendo curriculo", job: "Analisando oportunidade",
      analysis: "Consultando GPT", preparation: "Preparando curriculo ATS", application: "Conferindo candidatura",
      submission: "Preenchendo e enviando candidatura", notifications: "Encaminhando perguntas",
    };
    let lastProgress;
    do {
      const current = readBotConfig(filename);
      if (current.dataDir !== config.dataDir || connectionSignature(current) !== initialSignature)
        throw Object.assign(new Error("Configuracao alterada. Reinicie o aplicativo para aplicar o novo canal ou a busca."), { code: "RESTART_REQUIRED" });
      config = current;
      applyLocalCredentials(config);
      const modified = fs.statSync(filename).mtimeMs;
      if (modified !== lastConfig) { applyBotConfig(store, config); lastConfig = modified; }
      const prefs = store.getSettings();
      const within = inWorkWindow(config.workWindow);
      const online = messaging.getState().ready;
      const answerCount = db.prepare("SELECT COUNT(*) AS n FROM whatsapp_inbound_messages").get().n;
      const answered = answerCount !== lastAnswers;
      lastAnswers = answerCount;
      if (!online && !offlineReported) {
        ui.error("O canal perdeu a conexao. A rotina aguarda a reconexao; perguntas e dados continuam salvos. Para usar outro canal, encerre com 0 e abra --setup.");
        offlineReported = true;
      }
      if (online && offlineReported) { ui.success("Canal reconectado. A rotina pode continuar."); offlineReported = false; }
      if (!online && !values.watch) return 2;
      if (!within && !outsideReported) {
        if (interactive) ui.info(`Fora do horario. Aguardando ${config.workWindow.startHour}h (${config.workWindow.timeZone}). O menu continua disponivel.`);
        else console.log(JSON.stringify({ state: "outside_work_window", startHour: config.workWindow.startHour, hours: config.workWindow.hours, timeZone: config.workWindow.timeZone }));
        outsideReported = true;
      }
      if (!within && !values.watch) return 0;
      const due = config.search.continuous ? Date.parse(collector.nextCheckAt || 0) <= Date.now() : Date.now() - lastRun >= prefs.intervalHours * 36e5;
      let ran = false;
      if (within && online && (!lastRun || answered || due)) {
        outsideReported = false;
        lastProgress = undefined;
        const result = await runBotCycle(store, collector, config, {
          collectOnly: Boolean(values["collect-only"]), skipCollection: Boolean(lastRun && answered),
          signal: controller.signal, questionSender: messaging.questionSender,
          notificationConfig: messaging.notificationConfig,
          onProgress: interactive ? async (event) => {
            if (controller.signal.aborted || !progressLabels[event.stage] || event.status !== "running") return;
            const message = progressLabels[event.stage];
            if (message !== lastProgress) { ui.status("Agora", message); lastProgress = message; }
          } : undefined,
        });
        ran = true;
        if (!answered || !lastRun) lastRun = Date.now();
        if (interactive) ui.summary({ ...result, next: result.collection.status === "paused"
          ? "A busca esta pausada nas preferencias. O menu continua disponivel."
          : config.search.continuous ? "Consultar as fontes assim que estiverem disponiveis." : "Aguardar o proximo horario de busca." });
        else console.log(JSON.stringify({ collection: result.collection.status, received: result.collection.received, prepared: result.prepared, submitted: result.submitted, pending: result.pending.length }));
        if (!values.watch) return ["partial", "failed"].includes(result.collection.status) ? 1 : 0;
      }
      if (online && !values["collect-only"] && !controller.signal.aborted) {
        // Polling and notifications use the same ordered loop as the job cycle.
        await messaging.poll();
        if (within && !ran) {
          const { notifyQuestions } = await import("./bot/questions.js");
          await notifyQuestions(db, messaging.notificationConfig, {
            signal: controller.signal, ...(messaging.questionSender ? { sender: messaging.questionSender } : {}),
          });
        }
      }
      if (interactive) {
        const ids = db.prepare("SELECT id FROM bot_questions WHERE answer IS NULL AND topic<>'whatsapp_test' ORDER BY created_at,id LIMIT 10").all().map((row) => row.id).join("|");
        if (ids && ids !== shownQuestions) terminalAnswers.showQuestions();
        shownQuestions = ids;
      }
      if (!stopping) await new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, 5000); });
    } while (!stopping);
    return 0;
  } catch (error) {
    if (error.code === "SETUP_CANCELLED") { ui.info("Acao cancelada. Seus dados anteriores foram preservados."); return 130; }
    if (error.name === "ZodError" || error instanceof SyntaxError) ui.error("Configuracao invalida. Abra --setup para conferir os dados.");
    else if (error.code === "ENOENT") ui.error("Arquivo local nao encontrado. Confira o caminho do curriculo na configuracao.");
    else if (["RESTART_REQUIRED", "RECIPIENT_REQUIRED"].includes(error.code)) ui.error(error.message);
    else ui.error("Nao foi possivel concluir esta etapa. Confira se o aplicativo ja esta aberto e se a pasta permite gravacao.");
    return 2;
  } finally {
    terminalAnswers?.close();
    collector?.stop();
    if (messaging) await messaging.close();
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
