import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import { PDFParse } from "pdf-parse";
import { z } from "zod";
import { normalize } from "../utils.js";
import { technologies } from "../modules/matching.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 300000;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export class ResumeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ResumeError";
    this.code = code;
  }
}

function requireText(text) {
  if (typeof text !== "string" || !/[\p{L}\p{N}]/u.test(text))
    throw new ResumeError(
      "UNREADABLE_RESUME",
      "Currículo sem texto extraível. Para PDF digitalizado como imagem, forneça uma versão com texto ou TXT; OCR não está disponível.",
    );
  if (text.length > MAX_TEXT || text.includes("\u0000"))
    throw new ResumeError(
      "INVALID_RESUME",
      "Texto do currículo inválido ou acima do limite de 300.000 caracteres.",
    );
}

/** Local-file input only: never fetch URLs or log resume contents. */
export async function extractResume(filePath) {
  const extension = path.extname(String(filePath)).toLowerCase();
  if (!filePath || ![".pdf", ".txt"].includes(extension))
    throw new ResumeError(
      "INVALID_RESUME",
      "Use um currículo PDF com texto ou TXT UTF-8, de até 2 MB.",
    );
  let buffer;
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES)
        throw new ResumeError(
          "INVALID_RESUME",
          "Currículo deve ser arquivo não vazio de até 2 MB.",
        );
      // A bounded read still enforces the limit if another process grows a file.
      const storage = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < storage.length) {
        const read = await handle.read(
          storage,
          length,
          storage.length - length,
          length,
        );
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > MAX_BYTES)
        throw new ResumeError("INVALID_RESUME", "Currículo excede 2 MB.");
      buffer = storage.subarray(0, length);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ResumeError) throw error;
    throw new ResumeError(
      "RESUME_UNAVAILABLE",
      "Não foi possível ler o arquivo de currículo local.",
    );
  }

  let text;
  if (extension === ".txt") {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new ResumeError(
        "INVALID_RESUME",
        "O arquivo TXT deve usar codificação UTF-8.",
      );
    }
  } else {
    if (buffer.subarray(0, 5).toString() !== "%PDF-")
      throw new ResumeError(
        "INVALID_RESUME",
        "O arquivo não contém um PDF válido.",
      );
    let parser;
    try {
      parser = new PDFParse({ data: new Uint8Array(buffer), verbosity: 0 });
      const result = await parser.getText({ pageJoiner: "" });
      text = result.text;
    } catch {
      throw new ResumeError(
        "UNREADABLE_RESUME",
        "Não foi possível extrair texto do PDF. Verifique se ele está protegido, corrompido ou digitalizado e forneça PDF com texto ou TXT.",
      );
    } finally {
      await parser?.destroy().catch(() => {});
    }
  }
  requireText(text);
  return { text, format: extension.slice(1), sha256: hash(buffer) };
}

function mentions(text, skill) {
  const normalized = normalize(text);
  const escaped = normalize(skill).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(normalized) ||
    technologies(text).some((name) => normalize(name) === normalize(skill))
  );
}

function relevantSkills(source, job, profile) {
  const jobText = [
    job.title,
    job.description,
    ...(job.requiredSkills || []),
    ...(job.desiredSkills || []),
    ...(job.matching?.inferred?.requiredSkills || []),
    ...(job.matching?.inferred?.desiredSkills || []),
  ]
    .filter(Boolean)
    .join("\n");
  const names = (profile?.skills || [])
    .filter(
      (skill) =>
        skill.verified === true &&
        typeof skill.name === "string" &&
        skill.name.trim() &&
        !/[\r\n\u0000-\u001f]/.test(skill.name),
    )
    .map((skill) => skill.name.trim());
  return [...new Set(names)].filter(
    (name) => mentions(source.text, name) && mentions(jobText, name),
  );
}

function selectFont(text) {
  const candidates =
    process.platform === "win32"
      ? [path.join(process.env.WINDIR || "C:\\Windows", "Fonts", "arial.ttf")]
      : [
          "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
          "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
          "/System/Library/Fonts/Supplemental/Arial.ttf",
        ];
  const found = candidates.find((filename) => existsSync(filename));
  if (found) return found;
  if (
    /[^\u0009\u000a\u000d\u0020-\u007e\u00a0-\u00ff\u2013\u2014\u2018\u2019\u201c\u201d\u2022]/.test(
      text,
    )
  )
    throw new ResumeError(
      "FONT_UNAVAILABLE",
      "Instale uma fonte Unicode (Arial ou DejaVu Sans) para preservar todos os caracteres no PDF.",
    );
  return "Helvetica";
}

async function pdfBytes(text) {
  const font = selectFont(text);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const document = new PDFDocument({
      size: "A4",
      margin: 50,
      compress: true,
      info: {
        Title: "Currículo profissional",
        Creator: "Vaga Radar",
        CreationDate: new Date("2000-01-01T00:00:00Z"),
        ModDate: new Date("2000-01-01T00:00:00Z"),
      },
    });
    document.on("data", (chunk) => chunks.push(chunk));
    document.on("error", () =>
      reject(
        new ResumeError(
          "PDF_GENERATION_FAILED",
          "Não foi possível gerar o currículo PDF.",
        ),
      ),
    );
    document.on("end", () => resolve(Buffer.concat(chunks)));
    try {
      // A real searchable PDF: one column, embedded text/font, no screenshot,
      // graphics, tables, external URLs or invented professional claims.
      document
        .font(font)
        .fontSize(10.5)
        .text(text, { lineGap: 3, paragraphGap: 6 });
      document.end();
    } catch {
      document.destroy();
      reject(
        new ResumeError(
          "PDF_GENERATION_FAILED",
          "Não foi possível gerar o currículo PDF preservando seu texto.",
        ),
      );
    }
  });
}

async function savePrivate(filename, bytes) {
  try {
    await fs.writeFile(filename, bytes, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = await fs.lstat(filename);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !Buffer.from(await fs.readFile(filename)).equals(Buffer.from(bytes))
    )
      throw new ResumeError(
        "OUTPUT_CONFLICT",
        "Já existe um arquivo diferente no destino do currículo; nenhum arquivo foi sobrescrito.",
      );
    await fs.chmod(filename, 0o600);
  }
}

/**
 * Tailoring is factual reformatting, not invented experience or an ATS score.
 * An optional model plan may only order already verified/source-evidenced skill
 * names. The complete original source text is kept intact in both outputs.
 */
export async function createAtsResume({
  source,
  job,
  profile,
  outputDir,
  plan,
} = {}) {
  requireText(source?.text);
  if (
    !job ||
    typeof job.title !== "string" ||
    !job.title.trim() ||
    typeof outputDir !== "string" ||
    !outputDir.trim()
  )
    throw new ResumeError(
      "INVALID_INPUT",
      "Informe a vaga e um diretório privado para os currículos adaptados.",
    );
  let skills = relevantSkills(source, job, profile);
  if (plan !== undefined && plan !== null) {
    const parsed = z
      .object({ skillOrder: z.array(z.string().min(1)).max(100) })
      .strict()
      .safeParse(plan);
    if (
      !parsed.success ||
      new Set(plan.skillOrder?.map(normalize)).size !== plan.skillOrder?.length
    )
      throw new ResumeError(
        "INVALID_PLAN",
        "O plano só pode ordenar habilidades existentes, sem fatos ou textos novos.",
      );
    const known = new Map(skills.map((name) => [normalize(name), name]));
    if (parsed.data.skillOrder.some((name) => !known.has(normalize(name))))
      throw new ResumeError(
        "INVALID_PLAN",
        "O plano incluiu habilidade não confirmada e evidenciada no currículo e na vaga.",
      );
    skills = [
      ...parsed.data.skillOrder.map((name) => known.get(normalize(name))),
      ...skills.filter(
        (name) =>
          !parsed.data.skillOrder.some(
            (ordered) => normalize(ordered) === normalize(name),
          ),
      ),
    ];
  }
  const line = (value) =>
    String(value || "")
      .replace(/[\r\n\t\u0000-\u001f]/g, " ")
      .trim();
  const objective = `Objetivo: candidatura à vaga ${line(job.title)}${job.company ? ` na ${line(job.company)}` : ""}.`;
  const highlight = skills.length
    ? `Competências evidenciadas no currículo e relevantes à vaga: ${skills.join(", ")}.\n\n`
    : "";
  const text = `${objective}\n\n${highlight}${source.text}`;
  const pdf = await pdfBytes(text);
  if (pdf.length > MAX_BYTES)
    throw new ResumeError(
      "OUTPUT_TOO_LARGE",
      "O PDF adaptado excede 2 MB; reduza o conteúdo ou tamanho do currículo original.",
    );
  const version = hash(
    JSON.stringify({
      text,
      job: {
        id: job.id ?? null,
        provider: job.provider ?? null,
        board: job.board ?? null,
        originalId: job.originalId ?? null,
        url: job.url ?? null,
      },
    }),
  ).slice(0, 32);
  const directory = path.resolve(outputDir);
  if (directory.split(/[\\/]/).some((part) => part.toLowerCase() === "public"))
    throw new ResumeError(
      "INVALID_OUTPUT",
      "Currículos devem ficar em diretório privado, fora de public.",
    );
  const pdfPath = path.join(directory, `curriculo-ats-${version}.pdf`);
  const textPath = path.join(directory, `curriculo-ats-${version}.txt`);
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    await savePrivate(pdfPath, pdf);
    await savePrivate(textPath, Buffer.from(text, "utf8"));
  } catch (error) {
    if (error instanceof ResumeError) throw error;
    throw new ResumeError(
      "OUTPUT_UNAVAILABLE",
      "Não foi possível gravar os currículos em armazenamento privado.",
    );
  }
  return { pdfPath, textPath, sha256: hash(pdf) };
}
