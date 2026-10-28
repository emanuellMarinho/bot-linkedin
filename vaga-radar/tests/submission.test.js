import { test } from "node:test";
import assert from "node:assert/strict";
import {
  submitLeverApplication,
  SubmissionError,
} from "../src/submissions/lever.js";

// Synthetic identities are used only in fake-fetch unit tests. No HTTP POST is
// made and no real candidate application or platform account is accessed.
const fixture = (changes = {}) => ({
  board: "authorized-fixture",
  postingId: "fixture-posting-123",
  apiKey: "fixture-employer-api-key",
  fullName: "Pessoa de teste fictícia",
  email: "candidate-fixture@example.org",
  resume: Buffer.from("%PDF-1.4\nCurrículo fictício de teste"),
  resumeName: "DEMONSTRACAO.pdf",
  ...changes,
});

const clock = () => Date.parse("2026-10-27T12:00:00Z");

test("Lever: multipart correto e recibo documentado verificável sem expor chave", async () => {
  let calls = 0;
  const receipt = await submitLeverApplication(
    fixture({ comments: "Conteúdo fictício fornecido no teste" }),
    {
      clock,
      fetcher: async (url, options) => {
        calls++;
        const parsed = new URL(url);
        assert.equal(parsed.origin, "https://api.lever.co");
        assert.equal(
          parsed.pathname,
          "/v0/postings/authorized-fixture/fixture-posting-123",
        );
        assert.equal(parsed.searchParams.get("key"), fixture().apiKey);
        assert.equal(options.method, "POST");
        assert.equal(options.redirect, "error");
        assert.ok(options.signal instanceof AbortSignal);
        assert.equal(
          options.headers["Content-Type"],
          undefined,
          "Fetch define o boundary multipart",
        );
        assert.equal(options.body.get("name"), fixture().fullName);
        assert.equal(options.body.get("email"), fixture().email);
        assert.equal(options.body.get("resume").name, "DEMONSTRACAO.pdf");
        assert.equal(options.body.get("resume").type, "application/pdf");
        assert.deepEqual(
          Buffer.from(await options.body.get("resume").arrayBuffer()),
          fixture().resume,
        );
        assert.equal(
          options.body.get("comments"),
          "Conteúdo fictício fornecido no teste",
        );
        assert.equal(
          options.body.get("silent"),
          null,
          "Não suprime confirmação do provedor",
        );
        assert.equal(
          options.body.get("consent[marketing]"),
          null,
          "Não inventa consentimento",
        );
        return Response.json({
          ok: true,
          applicationId: "fixture-application-id",
        });
      },
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(receipt, {
    provider: "lever",
    applicationId: "fixture-application-id",
    board: "authorized-fixture",
    postingId: "fixture-posting-123",
    submittedAt: "2026-10-27T12:00:00.000Z",
    verified: true,
  });
  assert.ok(!JSON.stringify(receipt).includes(fixture().apiKey));
  assert.ok(!JSON.stringify(receipt).includes(fixture().email));
});

test("Lever: credencial ausente bloqueia qualquer requisição", async () => {
  for (const apiKey of [undefined, null, "", "   "]) {
    await assert.rejects(
      submitLeverApplication(fixture({ apiKey }), {
        fetcher: async () => {
          throw new Error("Não deve consultar");
        },
      }),
      (error) =>
        error instanceof SubmissionError &&
        error.code === "MISSING_CREDENTIAL" &&
        !error.canRetry,
    );
  }
});

test("Lever: valida perfil, currículo e parâmetros contra URL arbitrária/SSRF antes do POST", async () => {
  const badInputs = [
    { board: "https://127.0.0.1" },
    { board: "../internal" },
    { postingId: "post?key=other" },
    { postingId: "../other" },
    { fullName: "" },
    { email: "invalid-email" },
    { resume: "path-to-file.pdf" },
    { resume: Buffer.alloc(0) },
    { resume: Buffer.alloc(2 * 1024 * 1024 + 1) },
    { resumeName: "../resume.pdf" },
    { resumeName: "C:\\resume.pdf" },
    { resumeName: "resume.html" },
    { resume: Buffer.from("not a PDF") },
    { comments: "x".repeat(10001) },
    { apiKey: "key\nHeader: injected" },
  ];
  let called = false;
  for (const bad of badInputs)
    await assert.rejects(
      submitLeverApplication(fixture(bad), {
        fetcher: async () => {
          called = true;
        },
      }),
      (error) =>
        error instanceof SubmissionError && error.code === "VALIDATION",
    );
  assert.equal(called, false);
});

test("Lever: currículo TXT aceito, texto binário inválido recusado e campo extra não enviado", async () => {
  await submitLeverApplication(
    fixture({
      resumeName: "DEMONSTRACAO.txt",
      resume: Buffer.from("Currículo fictício UTF-8"),
    }),
    {
      fetcher: async (url, options) => {
        assert.equal(options.body.get("resume").type, "text/plain");
        return Response.json({ ok: true, applicationId: "fixture-id" });
      },
    },
  );
  for (const changes of [
    { resumeName: "demo.txt", resume: Buffer.from([0xff, 0xfe]) },
    { resumeName: "demo.txt", resume: Buffer.from("text\u0000binary") },
    { password: "not-an-authorized-integration" },
  ])
    await assert.rejects(
      submitLeverApplication(fixture(changes)),
      (error) => error.code === "VALIDATION",
    );
});

test("Lever: 429 retorna Retry-After em segundos sem repetir o POST imediatamente", async () => {
  let calls = 0;
  await assert.rejects(
    submitLeverApplication(fixture(), {
      clock,
      fetcher: async () => {
        calls++;
        return new Response("", {
          status: 429,
          headers: { "Retry-After": "120" },
        });
      },
    }),
    (error) => {
      assert.equal(error.code, "RATE_LIMIT");
      assert.equal(error.canRetry, true);
      assert.equal(error.requiresReconciliation, false);
      assert.equal(error.retryAfterMs, 120000);
      assert.equal(error.retryAt, "2026-10-27T12:02:00.000Z");
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("Lever: Retry-After aceita HTTP-date, usa espera conservadora se ausente e não encurta prazo enorme", async () => {
  for (const [header, milliseconds, retryable] of [
    ["Tue, 27 Oct 2026 12:03:00 GMT", 180000, true],
    [null, 60000, true],
    ["999999999999999999999999999999999999999999", null, false],
  ])
    await assert.rejects(
      submitLeverApplication(fixture(), {
        clock,
        fetcher: async () =>
          new Response("", {
            status: 429,
            headers: header ? { "retry-after": header } : {},
          }),
      }),
      (error) =>
        error.code === "RATE_LIMIT" &&
        error.retryAfterMs === milliseconds &&
        error.canRetry === retryable,
    );
});

test("Lever: rejeição de credencial e validação da plataforma são distintas e sem dados sensíveis", async () => {
  for (const status of [401, 403])
    await assert.rejects(
      submitLeverApplication(fixture(), {
        fetcher: async () =>
          Response.json({ ok: false, error: fixture().apiKey }, { status }),
      }),
      (error) =>
        error.code === "AUTHORIZATION" &&
        !error.canRetry &&
        !error.message.includes(fixture().apiKey),
    );
  await assert.rejects(
    submitLeverApplication(fixture(), {
      fetcher: async () =>
        Response.json(
          {
            ok: false,
            error: `${fixture().fullName} ${fixture().email} ${fixture().apiKey}`,
          },
          { status: 422 },
        ),
    }),
    (error) => {
      assert.equal(error.code, "REJECTED");
      assert.equal(error.canRetry, false);
      for (const value of [
        fixture().fullName,
        fixture().email,
        fixture().apiKey,
      ]) {
        assert.ok(!error.message.includes(value));
        assert.ok(!JSON.stringify(error).includes(value));
      }
      return true;
    },
  );
});

test("Lever: falha de rede e HTTP 5xx exigem reconciliação sem tentativa automática", async () => {
  for (const outcome of ["network", 500, 502, 503, 408, 302]) {
    let calls = 0;
    await assert.rejects(
      submitLeverApplication(fixture(), {
        fetcher: async () => {
          calls++;
          if (outcome === "network")
            throw new Error(
              `Failure at https://api.lever.co/?key=${fixture().apiKey}`,
            );
          return Response.json(
            { ok: false, error: "upstream" },
            { status: outcome },
          );
        },
      }),
      (error) =>
        error.code === "AMBIGUOUS" &&
        error.requiresReconciliation &&
        !error.canRetry &&
        !error.message.includes(fixture().apiKey),
    );
    assert.equal(calls, 1);
  }
});

test("Lever: timeout do POST não é repetido porque a plataforma pode já ter aceitado", async () => {
  let calls = 0;
  await assert.rejects(
    submitLeverApplication(fixture(), {
      timeoutMs: 5,
      fetcher: async (url, { signal }) => {
        calls++;
        return new Promise((resolve, reject) => {
          const keepAlive = setTimeout(resolve, 100);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(keepAlive);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    }),
    (error) => error.code === "AMBIGUOUS" && !error.canRetry,
  );
  assert.equal(calls, 1);
});

test("Lever: só HTTP 200 + ok:true + applicationId válido comprova envio", async () => {
  for (const response of [
    Response.json({ ok: true }),
    Response.json({ ok: true, applicationId: "" }),
    Response.json({ applicationId: "fixture-id" }),
    Response.json({ ok: true, applicationId: 123 }),
    Response.json({ ok: true, applicationId: "fixture-id" }, { status: 201 }),
    new Response("<html>Proxy page</html>", { status: 200 }),
    new Response("x".repeat(1024 * 1024 + 1), { status: 200 }),
  ])
    await assert.rejects(
      submitLeverApplication(fixture(), { fetcher: async () => response }),
      (error) => error.code === "AMBIGUOUS" && !error.canRetry,
    );
});
