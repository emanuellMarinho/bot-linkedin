import cron from "node-cron";
import { setImmediate } from "node:timers/promises";
import { fetchJobs } from "../providers/index.js";
import { HttpError } from "../utils.js";

export function createCollector(
  store,
  {
    provider = fetchJobs,
    logger = console,
    scheduler = cron,
    autoScheduleEnabled = true,
    continuous = false,
    clock = Date.now,
    minSourceIntervalMs = 30000,
  } = {},
) {
  if (!Number.isFinite(minSourceIntervalMs) || minSourceIntervalMs < 30000)
    throw new Error("A fonte precisa de pelo menos 30 segundos entre consultas");
  const cooldowns = new Map();
  const stamp = () => new Date(clock()).toISOString();
  function cooldown(source) {
    if (!cooldowns.has(source.id)) {
      const saved = store.db
        .prepare("SELECT value FROM settings WHERE key=?")
        .get(`collection_cooldown:${source.id}`);
      let state;
      try {
        state = saved ? JSON.parse(saved.value) : null;
      } catch {}
      const lastChecked = Date.parse(source.last_checked || "");
      cooldowns.set(source.id, {
        until: Number.isFinite(state?.until) && Math.abs(state.until) <= 8.64e15
          ? state.until
          : Number.isFinite(lastChecked)
            ? Math.min(8.64e15, lastChecked + minSourceIntervalMs)
            : 0,
        failures: Number.isInteger(state?.failures)
          ? Math.max(0, Math.min(state.failures, 10))
          : 0,
      });
    }
    return cooldowns.get(source.id);
  }
  function defer(source, error, reserve = false) {
    if (!continuous) return;
    const previous = cooldown(source);
    const failures = error ? Math.min(previous.failures + 1, 10) : reserve ? previous.failures : 0;
    const baseDelay = error
      ? Math.min(30 * 60000, minSourceIntervalMs * 2 ** failures)
      : minSourceIntervalMs;
    const retryAt = Date.parse(error?.retryAt || "");
    const retryMs = Number.isFinite(error?.retryAfterMs)
      ? Math.max(0, error.retryAfterMs)
      : 0;
    const state = {
      failures,
      until: Math.min(8.64e15, Math.max(clock() + baseDelay, clock() + retryMs,
        Number.isFinite(retryAt) ? retryAt : 0)),
    };
    cooldowns.set(source.id, state);
    store.db.prepare(
      "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(`collection_cooldown:${source.id}`, JSON.stringify(state));
  }
  const enabledSources = () => store.db
    .prepare("SELECT * FROM sources WHERE enabled=1 ORDER BY id").all();
  function nextHint(sources = enabledSources()) {
    const time = clock();
    const until = sources.length
      ? Math.max(time, Math.min(...sources.map((source) => cooldown(source).until)))
      : time + minSourceIntervalMs;
    return { retryAfterMs: until - time, nextCheckAt: new Date(until).toISOString() };
  }
  function idle(status, sources) {
    const hint = status === "paused"
      ? { retryAfterMs: minSourceIntervalMs, nextCheckAt: new Date(clock() + minSourceIntervalMs).toISOString() }
      : nextHint(sources);
    return { status, received: 0, inserted: 0, duplicates: 0, errors: "[]", ...hint };
  }
  let busy = false,
    task,
    controller;
  async function run() {
    if (busy) throw new HttpError(409, "Uma coleta já está em execução");
    const allSources = enabledSources();
    let sources = allSources;
    if (continuous) {
      if (!store.getSettings().collectionEnabled) return idle("paused", allSources);
      if (!allSources.length) return idle("no_sources", allSources);
      sources = allSources.filter((source) => cooldown(source).until <= clock());
      if (!sources.length) return idle("waiting", allSources);
    }
    busy = true;
    controller = new AbortController();
    const started = clock();
    const id = Number(
      store.db
        .prepare(
          "INSERT INTO collection_runs(started_at,status) VALUES (?,'running')",
        )
        .run(stamp()).lastInsertRowid,
    );
    let received = 0,
      inserted = 0,
      duplicates = 0;
    const errors = [];
    try {
      for (const source of sources) {
        const active = store.db
          .prepare("SELECT enabled FROM sources WHERE id=?")
          .get(source.id);
        if (!store.getSettings().collectionEnabled || controller.signal.aborted)
          break;
        if (!active?.enabled) continue;
        try {
          // Persist the minimum delay before the request so restarting cannot
          // turn an interrupted round into a tight retry loop.
          defer(source, undefined, true);
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
            .run(stamp(), stamp(), errorText, source.id);
          defer(source);
          if (errorText)
            errors.push({
              sourceId: source.id,
              provider: source.provider,
              message: errorText,
            });
        } catch (error) {
          // Sem body, cabeçalhos ou URLs fornecidas pelo usuário nos logs.
          if (controller.signal.aborted) break;
          defer(source, error);
          const message = typeof error.message === "string" && error.message.startsWith(source.provider + ":")
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
            .run(stamp(), message, source.id);
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
          stamp(),
          clock() - started,
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
      const result = store.db
        .prepare("SELECT * FROM collection_runs WHERE id=?")
        .get(id);
      return continuous ? { ...result, ...nextHint() } : result;
    } catch (error) {
      store.db
        .prepare(
          "UPDATE collection_runs SET finished_at=?,duration_ms=?,status='failed',errors=? WHERE id=?",
        )
        .run(
          stamp(),
          clock() - started,
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
    get nextCheckAt() {
      return continuous ? nextHint().nextCheckAt : null;
    },
  };
}
