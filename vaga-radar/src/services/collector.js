import cron from "node-cron";
import { setImmediate } from "node:timers/promises";
import { fetchJobs } from "../providers/index.js";
import { now, HttpError } from "../utils.js";

export function createCollector(
  store,
  {
    provider = fetchJobs,
    logger = console,
    scheduler = cron,
    autoScheduleEnabled = true,
  } = {},
) {
  let busy = false,
    task,
    controller;
  async function run() {
    if (busy) throw new HttpError(409, "Uma coleta já está em execução");
    busy = true;
    controller = new AbortController();
    const started = Date.now();
    const id = Number(
      store.db
        .prepare(
          "INSERT INTO collection_runs(started_at,status) VALUES (?,'running')",
        )
        .run(now()).lastInsertRowid,
    );
    let received = 0,
      inserted = 0,
      duplicates = 0;
    const errors = [];
    try {
      const sources = store.db
        .prepare("SELECT * FROM sources WHERE enabled=1 ORDER BY id")
        .all();
      for (const source of sources) {
        const active = store.db
          .prepare("SELECT enabled FROM sources WHERE id=?")
          .get(source.id);
        if (!store.getSettings().collectionEnabled || controller.signal.aborted)
          break;
        if (!active?.enabled) continue;
        try {
          const result = await provider(source, { signal: controller.signal });
          if (controller.signal.aborted) break;
          received += result.jobs.length;
          const sourceErrors = [...result.errors];
          for (const job of result.jobs) {
            if (controller.signal.aborted) break;
            try {
              store.upsertJob(job).inserted ? inserted++ : duplicates++;
            } catch (error) {
              sourceErrors.push(
                `Persistência de registro: ${error.code || "dados inválidos"}`,
              );
            }
            // O painel e o botão de pausa continuam respondendo em quadros grandes.
            await setImmediate();
          }
          const errorText = sourceErrors.length
            ? sourceErrors.slice(0, 20).join("; ")
            : null;
          store.db
            .prepare(
              "UPDATE sources SET last_checked=?,last_success=?,last_error=? WHERE id=?",
            )
            .run(now(), now(), errorText, source.id);
          if (errorText)
            errors.push({
              sourceId: source.id,
              provider: source.provider,
              message: errorText,
            });
        } catch (error) {
          // Sem body, cabeçalhos ou URLs fornecidas pelo usuário nos logs.
          if (controller.signal.aborted) break;
          const message = error.message.startsWith(source.provider + ":")
            ? error.message
            : `Falha de consulta (${error.cause?.code || error.code || error.name}); verifique a política de rede e o quadro configurado`;
          errors.push({
            sourceId: source.id,
            provider: source.provider,
            message,
          });
          store.db
            .prepare(
              "UPDATE sources SET last_checked=?,last_error=? WHERE id=?",
            )
            .run(now(), message, source.id);
          store.notification(
            "error",
            `Falha em ${source.provider}/${source.board}: ${message}`,
          );
          logger.warn(
            { sourceId: source.id, provider: source.provider },
            "Falha de coleta",
          );
        }
      }
      store.db
        .prepare(
          "UPDATE collection_runs SET finished_at=?,duration_ms=?,received=?,inserted=?,duplicates=?,errors=?,status=? WHERE id=?",
        )
        .run(
          now(),
          Date.now() - started,
          received,
          inserted,
          duplicates,
          JSON.stringify(errors),
          controller.signal.aborted
            ? "paused"
            : errors.length
              ? "partial"
              : sources.length
                ? "completed"
                : "no_sources",
          id,
        );
      return store.db
        .prepare("SELECT * FROM collection_runs WHERE id=?")
        .get(id);
    } catch (error) {
      store.db
        .prepare(
          "UPDATE collection_runs SET finished_at=?,duration_ms=?,status='failed',errors=? WHERE id=?",
        )
        .run(
          now(),
          Date.now() - started,
          JSON.stringify([{ message: "Erro interno de coleta" }]),
          id,
        );
      throw error;
    } finally {
      busy = false;
    }
  }
  function schedule() {
    task?.stop();
    task?.destroy();
    task = undefined;
    const settings = store.getSettings();
    if (!settings.collectionEnabled) {
      controller?.abort();
      return;
    }
    if (!autoScheduleEnabled) return;
    task = scheduler.schedule(
      `0 */${settings.intervalHours} * * *`,
      () => run().catch(() => logger.warn("Coleta programada não executada")),
      { timezone: "UTC", noOverlap: true },
    );
  }
  return {
    run,
    schedule,
    stop: () => {
      task?.stop();
      task?.destroy();
      task = undefined;
      controller?.abort();
    },
    get busy() {
      return busy;
    },
  };
}
