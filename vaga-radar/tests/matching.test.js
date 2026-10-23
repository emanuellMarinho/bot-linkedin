import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, canonicalUrl } from "../src/utils.js";
import { infer, scoreJob, technologies } from "../src/modules/matching.js";
import { defaultSettings, skills } from "../src/config.js";
import { normalizedJob } from "./helpers.js";
const profile = { skills: skills.map((name) => ({ name, verified: false })) };

test("normalização de acentos, grafias e URLs sem apagar parâmetros funcionais", () => {
  assert.equal(
    normalize("  DESENVOLVEDOR FULL-STACK  "),
    normalize("desenvolvedor fullstack"),
  );
  assert.equal(normalize("Integrações"), "integracoes");
  assert.equal(
    canonicalUrl("https://example.org/job/1/?utm_source=mail&id=1#x"),
    "https://example.org/job/1?id=1",
  );
});
test("extração diferencia obrigatórias, desejáveis e menções e evita Java dentro de JavaScript", () => {
  const derived = infer(normalizedJob());
  assert.deepEqual(derived.requiredSkills, ["JavaScript", "Node.js", "SQL"]);
  assert.deepEqual(derived.desiredSkills, ["Docker"]);
  assert.ok(!technologies("JavaScript TypeScript").includes("Java"));
});
test("vaga compatível recente recebe alta pontuação e justificativas", () => {
  const now = Date.now();
  const result = scoreJob(
    normalizedJob({
      publishedAt: new Date(now - 3600000).toISOString(),
      contractType: "CLT",
    }),
    profile,
    defaultSettings,
    now,
  );
  assert.equal(result.score, 100);
  assert.equal(result.eligible, true);
  assert.equal(result.competition, null);
  assert.ok(result.keywordMatch);
  assert.ok(result.reasons.length >= 4);
});
test("remoto internacional com restrição EUA é incompatível, global sem restrição é elegível", () => {
  const restricted = scoreJob(
    normalizedJob({
      location: "Remote — US only",
      description: "Requirements\nJavaScript. Must reside in United States.",
    }),
    profile,
    defaultSettings,
  );
  assert.equal(restricted.eligible, false);
  assert.ok(restricted.score <= 25);
  assert.ok(restricted.exclusions.length);
  const global = scoreJob(
    normalizedJob({
      location: "Global remote",
      description: "Requirements\nJavaScript",
    }),
    profile,
    defaultSettings,
  );
  assert.equal(global.eligible, true);
});
test("remoto de país desconhecido permanece sem elegibilidade comprovada", () => {
  const result = scoreJob(
    normalizedJob({ location: "Remote", description: "Requirements\nNode.js" }),
    profile,
    defaultSettings,
  );
  assert.equal(result.eligible, null);
  assert.equal(result.parts.location, 0);
});
test("sênior desconhecido e suporte são identificados, FullTime não vira CLT e datas não são inventadas", () => {
  const result = scoreJob(
    normalizedJob({
      title: "Senior Software Engineer",
      description: "Requirements\nJava, Kotlin, Rust. FullTime",
      seniority: null,
      contractType: null,
      publishedAt: null,
    }),
    profile,
    defaultSettings,
  );
  assert.equal(result.parts.contract, 0);
  assert.equal(result.parts.recency, 0);
  assert.ok(result.gaps.includes("Java"));
  assert.ok(result.score <= 25);
  const support = scoreJob(
    normalizedJob({ title: "Analista de Suporte Técnico" }),
    profile,
    defaultSettings,
  );
  assert.ok(support.exclusions.includes("Área fora de desenvolvimento"));
});
test("contagem conhecida tem faixas independentes de recência", () => {
  for (const [count, band] of [
    [0, "0-10"],
    [11, "11-25"],
    [26, "26-50"],
    [51, "51+"],
  ])
    assert.equal(
      scoreJob(
        normalizedJob({ applicantCount: count }),
        profile,
        defaultSettings,
      ).competition,
      band,
    );
});
