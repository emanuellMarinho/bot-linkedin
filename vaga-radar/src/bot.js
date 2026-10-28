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
      },
    }));
  } catch {
    console.error("Argumentos inválidos. Use --help.");
    return 2;
  }
  if (values.help) {
    console.log(
      "Vaga Radar Bot — assistente no terminal\nUso: VagaRadar.exe [--setup] [--config arquivo.json] [--once | --watch] [--collect-only] [--whatsapp-webhook]\nAo abrir o .exe pela primeira vez, informe os dados no assistente. O JSON é salvo automaticamente e o terminal continua aberto executando o bot.\n--setup altera seus dados e chaves sem editar arquivos. Ctrl+C encerra.\nNo Node: npm start ou npm run bot -- --setup\nEnvio via Lever exige autorização da integração da empresa; não é login de candidato. Nunca envia pelo LinkedIn nem registra sucesso sem recibo verificável.",
    );
    return 0;
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
  let setupNeeded = values.setup || !fs.existsSync(filename);
  if (
    interactive &&
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
  if (values.setup && !interactive) {
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
      await runSetup({ filename, prompt });
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
  if (!values.once && !values["whatsapp-webhook"]) values.watch = true;
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
      await startWhatsAppServer({ dataDir: config.dataDir });
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
    db = openDatabase(path.join(config.dataDir, "radar.sqlite"));
    recoverInterruptedSubmissions(db);
    const store = createStore(db),
      logger = {
        warn() {
          console.error("Uma fonte falhou; consulte reports/latest.json.");
        },
      };
    collector = createCollector(store, { logger, autoScheduleEnabled: false });
    if (config.whatsapp.enabled && config.whatsapp.autoStartWebhook) {
      const { startWhatsAppServer } = await import("./whatsapp-server.js");
      webhook = await startWhatsAppServer({ dataDir: config.dataDir });
    }
    if (interactive) {
      console.log(
        "\nVaga Radar em execução. Mantenha esta janela aberta. Ctrl+C encerra com segurança.",
      );
      console.log(
        `Rotina: ${config.workWindow.startHour}h, ${config.workWindow.hours} horas/dia (${config.workWindow.timeZone}).`,
      );
      console.log(
        `GPT: ${config.ai.enabled ? "configurado" : "desativado"} | WhatsApp: ${config.whatsapp.enabled ? "configurado; depende de webhook/template Meta" : "desativado"}`,
      );
    }
    let lastRun = 0,
      lastConfig = 0,
      lastAnswers = 0,
      outsideReported = false;
    do {
      const current = readBotConfig(filename);
      if (current.dataDir !== config.dataDir)
        throw new Error("Encerre o bot antes de alterar dataDir");
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
        (!lastRun ||
          answered ||
          Date.now() - lastRun >= prefs.intervalHours * 36e5)
      ) {
        outsideReported = false;
        const result = await runBotCycle(store, collector, config, {
          collectOnly: Boolean(values["collect-only"]),
          skipCollection: Boolean(lastRun && answered),
          signal: controller.signal,
        });
        if (!answered || !lastRun) lastRun = Date.now();
        console.log(
          interactive
            ? `Ciclo concluído: ${result.collection.received} recebidas, ${result.prepared} preparadas, ${result.submitted} enviadas, ${result.pending.length} pendências. Próxima busca em até ${prefs.intervalHours}h. Ctrl+C para encerrar.`
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
    else
      console.error(
        "Não foi possível executar o bot. Confira a configuração, as permissões locais e se já existe um bot ativo.",
      );
    return 2;
  } finally {
    collector?.stop();
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
