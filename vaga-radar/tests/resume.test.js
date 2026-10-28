import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import {
  extractResume,
  createAtsResume,
  ResumeError,
} from "../src/resume/index.js";

// Clearly synthetic CVs live only in temporary test directories.
const content =
  "Pessoa Fictícia de Teste\ncontato-fixture@example.org\n\nExperiência\nEmpresa Fictícia Alfa — Desenvolvedor\n2020–2023\nDesenvolvimento com JavaScript, Node.js e SQL.\n\nFormação\nCurso de demonstração, 2019.\n";
const profile = {
  skills: [
    { name: "Node.js", verified: true },
    { name: "SQL", verified: true },
    { name: "JavaScript", verified: false },
    { name: "Kubernetes", verified: true },
    { name: "Java", verified: true },
  ],
  experiences: [
    { company: "NÃO PODE SER INVENTADA", role: "Outra informação fora do CV" },
  ],
};
const job = {
  id: 123,
  title: "Desenvolvedor Node.js",
  company: "Empresa de teste da vaga",
  description: "Requisitos: Node.js, SQL, JavaScript, Kubernetes e Java.",
};
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vaga-resume-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function makePdf(filename, text = content) {
  const doc = new PDFDocument({
    info: { CreationDate: new Date("2000-01-01T00:00:00Z") },
  });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const complete = new Promise((resolve, reject) => {
    doc.on("end", resolve);
    doc.on("error", reject);
  });
  if (text) doc.font("Helvetica").text(text);
  else doc.rect(20, 20, 60, 60).fill("black");
  doc.end();
  await complete;
  await fs.writeFile(filename, Buffer.concat(chunks));
}

test("currículo TXT é extraído localmente sem alterar o conteúdo factual", async (t) => {
  const dir = await directory(t),
    filename = path.join(dir, "fixture.txt");
  await fs.writeFile(filename, content);
  const result = await extractResume(filename);
  assert.equal(result.text, content);
  assert.equal(result.format, "txt");
  assert.equal(
    result.sha256,
    createHash("sha256").update(content).digest("hex"),
  );
});

test("PDF verdadeiro é extraído e preserva nomes, empregador e datas declaradas", async (t) => {
  const dir = await directory(t),
    filename = path.join(dir, "fixture.pdf");
  await makePdf(filename);
  const result = await extractResume(filename);
  assert.equal(result.format, "pdf");
  assert.ok(result.text.includes("Empresa Fictícia Alfa"));
  assert.ok(result.text.includes("2020–2023"));
  assert.ok(result.text.includes("2019"));
  assert.ok(
    !result.text.includes("-- 1 of"),
    "Não adiciona marcadores artificiais de página ao conteúdo",
  );
});

test("PDF sem texto, arquivo corrompido, inválido e acima de 2 MB têm erro claro", async (t) => {
  const dir = await directory(t),
    image = path.join(dir, "image-only.pdf");
  await makePdf(image, "");
  await assert.rejects(
    extractResume(image),
    (error) =>
      error instanceof ResumeError &&
      error.code === "UNREADABLE_RESUME" &&
      /texto|digitalizado/i.test(error.message),
  );
  for (const [name, bytes] of [
    ["wrong.pdf", Buffer.from("not pdf")],
    ["broken.pdf", Buffer.from("%PDF-1.4 invalid")],
    ["invalid.txt", Buffer.from([0xff, 0xfe])],
    ["too-big.txt", Buffer.alloc(2 * 1024 * 1024 + 1)],
    ["empty.txt", Buffer.alloc(0)],
    ["cv.html", Buffer.from(content)],
  ]) {
    const filename = path.join(dir, name);
    await fs.writeFile(filename, bytes);
    await assert.rejects(
      extractResume(filename),
      (error) => error instanceof ResumeError,
    );
  }
});

test("ATS gera PDF pesquisável e TXT privado com todos os fatos intactos, sem experiência inventada", async (t) => {
  const dir = await directory(t);
  const source = {
    text: content,
    format: "txt",
    sha256: "fixture-source-hash",
  };
  const result = await createAtsResume({
    source,
    job,
    profile,
    outputDir: path.join(dir, "private-output"),
  });
  const text = await fs.readFile(result.textPath, "utf8");
  assert.ok(text.endsWith(content));
  assert.ok(
    text.includes(
      `Objetivo: candidatura à vaga ${job.title} na ${job.company}.`,
    ),
  );
  assert.ok(
    text.includes(
      "Competências evidenciadas no currículo e relevantes à vaga: Node.js, SQL.",
    ),
  );
  assert.ok(!text.includes("NÃO PODE SER INVENTADA"));
  assert.ok(!text.includes("Kubernetes"));
  assert.ok(
    !text.includes(
      "Competências evidenciadas no currículo e relevantes à vaga: JavaScript",
    ),
  );
  const bytes = await fs.readFile(result.pdfPath);
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
  const parsed = await extractResume(result.pdfPath);
  for (const factual of [
    "Pessoa Fictícia de Teste",
    "Empresa Fictícia Alfa",
    "2020–2023",
    "Curso de demonstração",
    "2019",
    "JavaScript, Node.js e SQL",
  ])
    assert.ok(
      parsed.text.includes(factual),
      `Fato original deve permanecer: ${factual}`,
    );
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(result.pdfPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(result.textPath)).mode & 0o777, 0o600);
    assert.equal(
      (await fs.stat(path.dirname(result.pdfPath))).mode & 0o777,
      0o700,
    );
  }
});

test("plano só reordena habilidades confirmadas e evidenciadas; texto original nunca é reescrito", async (t) => {
  const dir = await directory(t),
    source = { text: content };
  const result = await createAtsResume({
    source,
    job,
    profile,
    outputDir: dir,
    plan: { skillOrder: ["SQL", "Node.js"] },
  });
  const text = await fs.readFile(result.textPath, "utf8");
  assert.ok(text.includes("à vaga: SQL, Node.js."));
  assert.ok(text.endsWith(content));
  for (const plan of [
    { skillOrder: ["Kubernetes"] },
    { skillOrder: ["Java"] },
    { skillOrder: ["JavaScript"] },
    { skillOrder: ["SQL", "SQL"] },
    { skillOrder: [], summary: "Inventei experiência" },
    { skillOrder: ["Empresa inventada 2026"] },
  ])
    await assert.rejects(
      createAtsResume({ source, job, profile, outputDir: dir, plan }),
      (error) => error.code === "INVALID_PLAN",
    );
});

test("nomes e versões são estáveis por conteúdo, sem sobrescrever arquivos diferentes", async (t) => {
  const dir = await directory(t),
    options = { source: { text: content }, job, profile, outputDir: dir };
  const a = await createAtsResume(options),
    b = await createAtsResume(options);
  assert.deepEqual(a, b);
  const changed = await createAtsResume({
    ...options,
    job: { ...job, title: "Outro cargo" },
  });
  assert.notEqual(changed.pdfPath, a.pdfPath);
  const otherId = await createAtsResume({
    ...options,
    job: { ...job, id: 456 },
  });
  assert.notEqual(
    otherId.pdfPath,
    a.pdfPath,
    "Vagas distintas conservam versões separadas mesmo com cargo igual",
  );
  await fs.writeFile(a.pdfPath, "existing unrelated user file");
  await assert.rejects(
    createAtsResume(options),
    (error) => error.code === "OUTPUT_CONFLICT",
  );
  assert.equal(
    await fs.readFile(a.pdfPath, "utf8"),
    "existing unrelated user file",
  );
});

test("currículos não são gravados em public nem ganham habilidades inferidas de JavaScript como Java", async (t) => {
  const dir = await directory(t);
  await assert.rejects(
    createAtsResume({
      source: { text: content },
      job,
      profile,
      outputDir: path.join(dir, "public"),
    }),
    (error) => error.code === "INVALID_OUTPUT",
  );
  const result = await createAtsResume({
    source: { text: "Experiência com JavaScript na Empresa Fictícia em 2021." },
    job: { ...job, description: "Java e JavaScript" },
    profile: { skills: [{ name: "Java", verified: true }] },
    outputDir: dir,
  });
  assert.ok(
    !(await fs.readFile(result.textPath, "utf8")).includes(
      "Competências evidenciadas",
    ),
  );
});
