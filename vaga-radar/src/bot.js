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
      },
    }));
  } catch {
    console.error("Argumentos inválidos. Use --help.");
    return 2;
  }
  if (values.help) {
    console.log(
      "Vaga Radar Bot — sem painel e sem servidor HTTP\nUso: VagaRadar.exe [--config arquivo.json] [--once | --watch] [--collect-only] [--whatsapp-webhook]\nNo Node: npm run bot -- --config bot.config.json --once\nO bot lê seu perfil local, consulta fontes e prepara candidaturas.\nEnvio via Lever exige autorização da integração da empresa e API key; login de candidato não substitui essa autorização.\nNunca envia pelo LinkedIn nem marca sucesso sem recibo verificável.",
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
  const [
    { readBotConfig, applyBotConfig },
    { acquireBotLock },
    { openDatabase },
    { createStore },
    { createCollector },
    { runBotCycle, recoverInterruptedSubmissions },
    dotenv,
  ] = await Promise.all([
    import("./bot/config.js"),
    import("./bot/lock.js"),
    import("./database/index.js"),
    import("./database/store.js"),
    import("./services/collector.js"),
    import("./bot/worker.js"),
    import("dotenv"),
  ]);
  dotenv.config({
    path: path.join(path.dirname(filename), ".env"),
    quiet: true,
  });
  if (values["whatsapp-webhook"]) {
    const { startWhatsAppServer } = await import("./whatsapp-server.js");
    const config = readBotConfig(filename);
    startWhatsAppServer({ dataDir: config.dataDir });
    return 0;
  }
  const { inWorkWindow } = await import("./bot/schedule.js");
  const controller = new AbortController();
  let db,
    collector,
    release,
    stopping = false,
    timer,
    wake;
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
    let lastRun = 0,
      lastConfig = 0,
      lastAnswers = 0,
      outsideReported = false;
    do {
      const current = readBotConfig(filename);
      if (current.dataDir !== config.dataDir)
        throw new Error("Encerre o bot antes de alterar dataDir");
      config = current;
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
          JSON.stringify({
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
          JSON.stringify({
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
    db?.close();
    release?.();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = await main();
