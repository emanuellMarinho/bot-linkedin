import path from "node:path";
import pino from "pino";
import { config } from "./config.js";
import { openDatabase } from "./database/index.js";
import { createStore } from "./database/store.js";
import { createCollector } from "./services/collector.js";
import { createApp } from "./app.js";

if (!["127.0.0.1", "localhost", "::1"].includes(config.host))
  throw new Error(
    "Exposição remota desativada. Configure autenticação e proteção antes de uma implantação remota.",
  );
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
  throw new Error("PORT inválida");
process.umask(0o077);
const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const db = openDatabase(path.join(config.dataDir, "radar.sqlite"));
// Recuperação é exclusiva da inicialização do servidor, nunca de scripts que apenas abrem o banco.
db.prepare(
  "UPDATE collection_runs SET status='interrupted',finished_at=? WHERE status='running'",
).run(new Date().toISOString());
const store = createStore(db),
  collector = createCollector(store, {
    logger,
    autoScheduleEnabled: config.scheduler,
  });
const app = createApp(store, collector, { dataDir: config.dataDir, logger });
const server = app.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port }, "Vaga Radar iniciado");
  if (config.scheduler) collector.schedule();
});
server.on("error", (error) => {
  logger.error({ code: error.code }, "Falha ao iniciar servidor");
  collector.stop();
  db.close();
  process.exitCode = 1;
});
function shutdown() {
  collector.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 25000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
