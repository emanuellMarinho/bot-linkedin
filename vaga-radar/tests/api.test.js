import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import fs from "node:fs";
import path from "node:path";
import { harness, manualJob, fixtures } from "./helpers.js";
import { openDatabase } from "../src/database/index.js";
import { createStore } from "../src/database/store.js";
import { normalizePosting } from "../src/providers/index.js";

test("API: fluxo completo importar → visualizar → preparar → confirmar → acompanhar", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const client = request(h.app);
  assert.equal((await client.get("/api/health")).body.database, true);
  const profile = h.store.getProfile();
  delete profile.resumes;
  profile.name = "Pessoa de teste";
  profile.summary = "Resumo fornecido pela pessoa.";
  profile.skills.find((s) => s.name === "JavaScript").verified = true;
  await client.put("/api/profile").send(profile).expect(200);
  const imported = await client
      .post("/api/jobs/import")
      .send(manualJob())
      .expect(201),
    id = imported.body.job.id;
  await client.get(`/api/jobs/${id}`).expect(200);
  const prepared = await client.post(`/api/jobs/${id}/prepare`).expect(200);
  assert.equal(prepared.body.status, "prepared");
  assert.deepEqual(prepared.body.preparation.strengths, ["JavaScript"]);
  assert.ok(!prepared.body.preparation.summary.includes("experiência em Node"));
  const appId = prepared.body.id;
  await client
    .patch(`/api/applications/${appId}`)
    .send({ status: "sent", confirmedSent: true })
    .expect(409);
  await client
    .patch(`/api/applications/${appId}`)
    .send({ status: "started" })
    .expect(200);
  await client
    .patch(`/api/applications/${appId}`)
    .send({ status: "sent" })
    .expect(400);
  const sent = await client
    .patch(`/api/applications/${appId}`)
    .send({ status: "sent", confirmedSent: true })
    .expect(200);
  assert.ok(sent.body.sent_at);
  assert.equal(sent.body.events.at(-1).to_status, "sent");
  await client
    .patch(`/api/applications/${appId}`)
    .send({ status: "interview" })
    .expect(200);
  const stats = (await client.get("/api/dashboard")).body;
  assert.equal(stats.sent, 1);
  assert.equal(stats.interviews, 1);
});
test("deduplicação por URL, fonte e correspondência entre fontes preserva referências e status", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const client = request(h.app);
  const first = (
    await client.post("/api/jobs/import").send(manualJob()).expect(201)
  ).body.job;
  await client
    .patch(`/api/jobs/${first.id}`)
    .send({ status: "saved" })
    .expect(200);
  const duplicate = (
    await client
      .post("/api/jobs/import")
      .send(manualJob({ url: "https://example.org/jobs/1?utm_source=alert" }))
      .expect(200)
  ).body;
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.job.status, "saved");
  const posting = normalizePosting("greenhouse", fixtures.greenhouse.jobs[0], {
    company: "Empresa de teste",
    board: "fixture",
  });
  posting.location = "Brasil";
  const cross = h.store.upsertJob(posting);
  assert.equal(cross.inserted, false);
  assert.equal(cross.job.sources.length, 2);
  const same = h.store.upsertJob(posting);
  assert.equal(same.job.id, first.id);
});
test("filtros de tecnologia, país, data, senioridade e concorrência conhecida", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const client = request(h.app);
  await client
    .post("/api/jobs/import")
    .send(
      manualJob({
        applicantCount: 5,
        applicantEvidence: "Contagem verificada na fixture",
        publishedAt: new Date().toISOString(),
        publicationEvidence: "Data da fixture",
      }),
    )
    .expect(201);
  await client
    .post("/api/jobs/import")
    .send(
      manualJob({
        title: "Software Engineer Senior",
        url: "https://example.org/jobs/2",
        company: "Outra empresa",
        location: "US only",
        description: "Requirements\nJava\nRemote US only",
        seniority: "senior",
      }),
    )
    .expect(201);
  const filtered = (
    await client.get(
      "/api/jobs?technology=Node.js&modality=remote&seniority=mid&hours=24&competition=0-10&eligibleOnly=true",
    )
  ).body;
  assert.equal(filtered.total, 1);
  assert.equal(
    (await client.get("/api/jobs?company=Outra&competition=unknown")).body
      .total,
    1,
  );
  await client.get("/api/jobs?minScore=banana").expect(400);
});
test("persistência de banco, migrations repetíveis e histórico após reabrir", async (t) => {
  const h = harness({ persistent: true });
  const directory = h.dataDir;
  const filename = path.join(directory, "radar.sqlite");
  const client = request(h.app);
  const imported = (await client.post("/api/jobs/import").send(manualJob()))
    .body;
  await client.post(`/api/jobs/${imported.job.id}/prepare`).expect(200);
  const profile = h.store.getProfile();
  delete profile.resumes;
  profile.skills = [];
  h.store.saveProfile(profile);
  h.collector.stop();
  h.db.close();
  const db = openDatabase(filename);
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const store = createStore(db);
  assert.equal(store.getJob(imported.job.id).status, "prepared");
  assert.ok(store.getApplication(1).events.length >= 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM migrations").get().n, 3);
  assert.equal(
    store.getProfile().skills.length,
    0,
    "Lista removida pelo usuário não deve ser recriada no reinício",
  );
});
test("segurança: valida URLs, SSRF, XSS, JSON, origem, host e SQL sem expor currículos", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const client = request(h.app);
  for (const url of [
    "javascript:alert(1)",
    "http://127.0.0.1/private",
    "http://localhost/private",
    "http://[::1]/private",
    "http://169.254.169.254/latest",
    "https://user:secret@example.org/",
  ])
    await client.post("/api/jobs/import").send(manualJob({ url })).expect(400);
  await client
    .post("/api/jobs/import")
    .set("Origin", "https://evil.example")
    .send(manualJob())
    .expect(403);
  await client.get("/api/profile").set("Host", "evil.example").expect(403);
  await client
    .post("/api/jobs/import")
    .type("form")
    .send({ title: "x" })
    .expect(415);
  await client
    .post("/api/jobs/import")
    .send(manualJob({ applicantCount: 5 }))
    .expect(400);
  const result = await client
    .post("/api/jobs/import")
    .send(
      manualJob({
        title: "Developer'; DROP TABLE jobs; --",
        description: "<script>alert(1)</script><p>JavaScript</p>",
      }),
    )
    .expect(201);
  assert.equal(result.body.job.description, "JavaScript");
  assert.equal((await client.get("/api/jobs")).body.total, 1);
  const upload = await client
    .post("/api/resumes")
    .attach("file", Buffer.from("%PDF-1.4\nTest fixture"), "curriculo.pdf")
    .expect(201);
  const filename = h.db
    .prepare("SELECT filename FROM resumes WHERE id=?")
    .get(upload.body.id).filename;
  await client.get("/resumes/" + filename).expect(404);
  await client.get("/data/resumes/" + filename).expect(404);
  await client.get(`/api/resumes/${upload.body.id}/download`).expect(200);
  await client
    .post("/api/resumes")
    .attach("file", Buffer.from("<script>evil</script>"), "cv.html")
    .expect(400);
  const settings = h.store.getSettings();
  settings.weights.technical = 99;
  await client.put("/api/settings").send(settings).expect(400);
});
test("fontes, nomenclaturas e preferências persistem; recalcular pontuação funciona", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const client = request(h.app);
  const source = await client
    .post("/api/sources")
    .send({ provider: "greenhouse", board: "fixture", company: "Fixture" })
    .expect(201);
  await client
    .patch(`/api/sources/${source.body.id}`)
    .send({ enabled: false })
    .expect(200);
  await client
    .post("/api/sources")
    .send({ provider: "greenhouse", board: "../internal", company: "Bad" })
    .expect(400);
  const prefs = h.store.getSettings();
  prefs.collectionEnabled = false;
  prefs.keywordGroups.Custom = ["Integração Web"];
  await client.put("/api/settings").send(prefs).expect(200);
  assert.equal(
    (await client.get("/api/settings")).body.keywordGroups.Custom[0],
    "Integração Web",
  );
  await client.post("/api/collection/run").expect(409);
  const job = (await client.post("/api/jobs/import").send(manualJob())).body
    .job;
  await client.post(`/api/jobs/${job.id}/score`).expect(200);
});

test("IDs distintos no mesmo quadro não colapsam; URL LinkedIn com slug deduplica pelo ID", async (t) => {
  const h = harness();
  t.after(() => h.close());
  const client = request(h.app);
  const post = normalizePosting("greenhouse", fixtures.greenhouse.jobs[0], {
    company: "Fixture",
    board: "fixture",
  });
  const a = h.store.upsertJob(post);
  const b = h.store.upsertJob({
    ...post,
    originalId: "102",
    url: "https://boards.greenhouse.io/fixture/jobs/102",
  });
  assert.notEqual(a.job.id, b.job.id);
  assert.equal(b.inserted, true);
  const first = (
    await client
      .post("/api/jobs/import")
      .send(
        manualJob({
          location: null,
          url: "https://br.linkedin.com/jobs/view/desenvolvedor-123456?trk=alerta",
        }),
      )
      .expect(201)
  ).body;
  const second = (
    await client
      .post("/api/jobs/import")
      .send(
        manualJob({
          location: null,
          url: "https://www.linkedin.com/jobs/view/123456",
        }),
      )
      .expect(200)
  ).body;
  assert.equal(first.job.id, second.job.id);
  assert.equal(second.job.originalId, "123456");
});
