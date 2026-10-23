import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtures } from "./helpers.js";
import { fetchJobs } from "../src/providers/index.js";
import { parseAlert } from "../src/modules/email.js";

for (const provider of ["greenhouse", "lever", "ashby"])
  test(`adaptador ${provider} consulta endpoint fixo e normaliza fixture`, async () => {
    let requested;
    const result = await fetchJobs(
      { provider, board: "fixture", company: "Empresa fixture" },
      {
        fetcher: async (url, options) => {
          requested = url;
          assert.equal(options.redirect, "error");
          return Response.json(fixtures[provider]);
        },
      },
    );
    assert.equal(result.jobs.length, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(result.jobs[0].company, "Empresa fixture");
    assert.equal(result.jobs[0].applicantCount, null);
    assert.ok(requested.startsWith("https://"));
    assert.ok(!result.jobs[0].description.includes("<li>"));
    if (provider !== "ashby") assert.equal(result.jobs[0].publishedAt, null);
    if (provider === "greenhouse") assert.ok(result.jobs[0].updatedAt);
    if (provider === "lever") assert.equal(result.jobs[0].contractType, null);
  });
test("429 tem backoff limitado e Retry-After é respeitado sem martelar a fonte", async () => {
  let calls = 0;
  const delays = [];
  await fetchJobs(
    { provider: "lever", board: "fixture" },
    {
      fetcher: async () =>
        ++calls === 1
          ? new Response("", { status: 429, headers: { "retry-after": "1" } })
          : Response.json([]),
      delay: async (ms) => delays.push(ms),
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(delays, [1000]);
  await assert.rejects(
    fetchJobs(
      { provider: "lever", board: "fixture" },
      {
        fetcher: async () =>
          new Response("", { status: 429, headers: { "retry-after": "60" } }),
      },
    ),
    /Retry-After/,
  );
});
test("redirecionamentos, payload inesperado e board malicioso são recusados", async () => {
  await assert.rejects(
    fetchJobs({ provider: "lever", board: "https://127.0.0.1" }),
    /Fonte inválida/,
  );
  await assert.rejects(
    fetchJobs(
      { provider: "lever", board: "fixture" },
      { fetcher: async () => new Response("", { status: 302 }) },
    ),
    /HTTP 302/,
  );
  await assert.rejects(
    fetchJobs(
      { provider: "ashby", board: "fixture" },
      { fetcher: async () => Response.json({ nope: true }) },
    ),
    /Formato inesperado/,
  );
});
test("registros malformados são reportados e não substituídos por vagas inventadas", async () => {
  const result = await fetchJobs(
    { provider: "lever", board: "fixture", company: "Fixture" },
    { fetcher: async () => Response.json([{}, ...fixtures.lever]) },
  );
  assert.equal(result.jobs.length, 1);
  assert.equal(result.errors.length, 1);
});
test("alertas em texto e EML extraem somente links fornecidos, sem consulta externa", async () => {
  const url = "https://www.linkedin.com/jobs/view/123456?trk=mail";
  const result = await parseAlert(`Confira ${url} e ${url}`);
  assert.deepEqual(result.links, ["https://www.linkedin.com/jobs/view/123456"]);
  const eml = await parseAlert(
    `From: teste@example.org\r\nTo: eu@example.org\r\nSubject: Alerta\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<a href="${url}">Ver vaga</a>`,
    true,
  );
  assert.equal(eml.links.length, 1);
});

test("Ashby aceita URL sem ID opcional e Greenhouse separa primeira publicação de atualização", async () => {
  const item = { ...fixtures.ashby.jobs[0] };
  delete item.id;
  const ashby = await fetchJobs(
    { provider: "ashby", board: "fixture", company: "Fixture" },
    { fetcher: async () => Response.json({ jobs: [item] }) },
  );
  assert.equal(ashby.jobs[0].originalId, null);
  assert.equal(ashby.errors.length, 0);
  const gh = {
    ...fixtures.greenhouse.jobs[0],
    first_published: "2026-10-01T10:00:00Z",
  };
  const greenhouse = await fetchJobs(
    { provider: "greenhouse", board: "fixture", company: "Fixture" },
    { fetcher: async () => Response.json({ jobs: [gh] }) },
  );
  assert.notEqual(greenhouse.jobs[0].publishedAt, greenhouse.jobs[0].updatedAt);
});
