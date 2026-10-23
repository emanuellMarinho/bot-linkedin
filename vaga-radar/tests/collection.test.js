import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { harness, fixtures } from "./helpers.js";
import { normalizePosting } from "../src/providers/index.js";

test("coleta autorizada de fixture → persistência → classificação → preparação → confirmação manual", async (t) => {
  const provider = async (source) => ({
    jobs: fixtures.ashby.jobs.map((j) => normalizePosting("ashby", j, source)),
    errors: [],
  });
  const h = harness({ provider });
  t.after(() => h.close());
  const client = request(h.app);
  await client
    .post("/api/sources")
    .send({ provider: "ashby", board: "fixture", company: "Empresa fixture" })
    .expect(201);
  const first = await client.post("/api/collection/run").expect(200);
  assert.equal(first.body.inserted, 1);
  const second = await client.post("/api/collection/run").expect(200);
  assert.equal(second.body.inserted, 0);
  assert.equal(second.body.duplicates, 1);
  const jobs = (await client.get("/api/jobs")).body.items;
  assert.equal(jobs.length, 1);
  assert.ok(jobs[0].matching.reasons.length);
  const a = (await client.post(`/api/jobs/${jobs[0].id}/prepare`).expect(200))
    .body;
  await client
    .patch(`/api/applications/${a.id}`)
    .send({ status: "started" })
    .expect(200);
  await client
    .patch(`/api/applications/${a.id}`)
    .send({ status: "sent", confirmedSent: true })
    .expect(200);
  assert.equal((await client.get("/api/applications")).body[0].status, "sent");
  assert.equal((await client.get("/api/collection/history")).body.length, 2);
});
test("lock evita execuções simultâneas e libera após término", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const h = harness({
    provider: async () => {
      await gate;
      return { jobs: [], errors: [] };
    },
  });
  t.after(() => h.close());
  h.db
    .prepare("INSERT INTO sources(provider,board,company) VALUES (?,?,?)")
    .run("lever", "fixture", "Fixture");
  const running = h.collector.run();
  assert.equal(h.collector.busy, true);
  await assert.rejects(h.collector.run(), /já está/);
  release();
  await running;
  assert.equal(h.collector.busy, false);
});
test("erros das fontes são persistidos sem inventar resultados", async (t) => {
  const h = harness({
    provider: async () => {
      throw new Error("lever: HTTP 403 em api.lever.co");
    },
  });
  t.after(() => h.close());
  h.db
    .prepare("INSERT INTO sources(provider,board,company) VALUES (?,?,?)")
    .run("lever", "fixture", "Fixture");
  const result = await h.collector.run();
  assert.equal(result.status, "partial");
  assert.equal(result.inserted, 0);
  assert.match(result.errors, /HTTP 403/);
  assert.match(
    h.db.prepare("SELECT last_error FROM sources").get().last_error,
    /HTTP 403/,
  );
});

test("agendamento executa o coletor e respeita pausa, frequência e cancelamento em andamento", async (t) => {
  let tick,
    options,
    expression,
    stopped = 0,
    destroyed = 0,
    calls = 0;
  const h = harness({
    scheduler: {
      schedule(expr, callback, opts) {
        expression = expr;
        tick = callback;
        options = opts;
        return {
          stop() {
            stopped++;
          },
          destroy() {
            destroyed++;
          },
        };
      },
    },
    provider: async () => {
      calls++;
      return { jobs: [], errors: [] };
    },
  });
  t.after(() => h.close());
  h.db
    .prepare("INSERT INTO sources(provider,board,company) VALUES (?,?,?)")
    .run("lever", "fixture", "Fixture");
  h.collector.schedule();
  assert.equal(expression, "0 */4 * * *");
  assert.equal(options.noOverlap, true);
  await tick();
  assert.equal(calls, 1);
  assert.equal(
    h.db.prepare("SELECT status FROM collection_runs").get().status,
    "completed",
  );
  const settings = h.store.getSettings();
  settings.intervalHours = 2;
  h.store.saveSettings(settings);
  h.collector.schedule();
  assert.equal(expression, "0 */2 * * *");
  settings.collectionEnabled = false;
  h.store.saveSettings(settings);
  h.collector.schedule();
  assert.equal(stopped, 2);
  assert.equal(destroyed, 2);
});

test("pausar durante requisição cancela a fonte sem persistir resultados parciais", async (t) => {
  let entered;
  const started = new Promise((resolve) => (entered = resolve));
  const h = harness({
    provider: async (source, { signal }) => {
      entered();
      await new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  t.after(() => h.close());
  h.db
    .prepare("INSERT INTO sources(provider,board,company) VALUES (?,?,?)")
    .run("lever", "fixture", "Fixture");
  const running = h.collector.run();
  await started;
  const settings = h.store.getSettings();
  settings.collectionEnabled = false;
  h.store.saveSettings(settings);
  h.collector.schedule();
  const result = await running;
  assert.equal(result.status, "paused");
  assert.equal(h.collector.busy, false);
  assert.equal(result.inserted, 0);
});
