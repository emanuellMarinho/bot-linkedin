import express from "express";
import helmet from "helmet";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ZodError, z } from "zod";
import {
  jobInput,
  sourceInput,
  profileInput,
  settingsInput,
  applicationPatch,
  parseId,
} from "./validation.js";
import { plain, now, HttpError } from "./utils.js";
import { prepareApplication } from "./modules/assistant.js";
import { parseAlert } from "./modules/email.js";
import { transitions } from "./config.js";

export function createApp(
  store,
  collector,
  { dataDir, logger = console } = {},
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: null,
        },
      },
    }),
  );
  app.use((req, res, next) => {
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(req.hostname))
      return next(new HttpError(403, "Host não autorizado; aplicação local"));
    const origin = req.headers.origin;
    if (origin && origin !== `${req.protocol}://${req.headers.host}`)
      return next(new HttpError(403, "Origem não autorizada"));
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return next(new HttpError(403, "Requisição externa bloqueada"));
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 2 * 1024 * 1024,
      files: 1,
      fields: 5,
      fieldSize: 2 * 1024 * 1024,
    },
  });
  const requireJson = (req, res, next) =>
    req.is("application/json")
      ? next()
      : next(new HttpError(415, "Use application/json"));
  app.get("/api/health", (req, res) =>
    res.json({
      status: "ok",
      database: store.db.prepare("SELECT 1 AS ok").get().ok === 1,
      collectionRunning: collector.busy,
    }),
  );
  app.get("/api/settings", (req, res) => res.json(store.getSettings()));
  app.put("/api/settings", requireJson, (req, res) => {
    const result = store.saveSettings(settingsInput.parse(req.body));
    collector.schedule();
    res.json(result);
  });
  app.get("/api/profile", (req, res) => res.json(store.getProfile()));
  app.put("/api/profile", requireJson, (req, res) =>
    res.json(store.saveProfile(profileInput.parse(req.body))),
  );
  app.get("/api/jobs", (req, res) => {
    const q = z
      .object({
        q: z.string().max(200).optional(),
        title: z.string().max(200).optional(),
        company: z.string().max(200).optional(),
        technology: z.string().max(100).optional(),
        seniority: z.enum(["junior", "mid", "senior"]).optional(),
        modality: z.enum(["remote", "hybrid", "onsite"]).optional(),
        source: z.string().max(50).optional(),
        contract: z.string().max(80).optional(),
        status: z.string().max(50).optional(),
        minScore: z.coerce.number().min(0).max(100).optional(),
        hours: z.coerce.number().min(1).max(1440).optional(),
        competition: z
          .enum(["0-10", "11-25", "26-50", "51+", "unknown"])
          .optional(),
        sort: z.enum(["score", "date", "competition"]).default("score"),
        eligibleOnly: z.enum(["true", "false"]).optional(),
        relevance: z.enum(["relevant", "all", "excluded"]).optional(),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .strict()
      .parse(req.query);
    let jobs = store.db.prepare("SELECT * FROM jobs").all().map(store.hydrate);
    const contains = (value, term) =>
      !term ||
      String(value ?? "")
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .includes(
          term
            .normalize("NFD")
            .replace(/\p{Diacritic}/gu, "")
            .toLowerCase(),
        );
    jobs = jobs.filter((job) => {
      const inferred = job.matching.inferred;
      const technologies = [
        ...(job.requiredSkills || inferred.requiredSkills),
        ...(job.desiredSkills || inferred.desiredSkills),
        ...inferred.mentionedSkills,
      ];
      return (
        contains(`${job.title} ${job.company} ${job.description}`, q.q) &&
        contains(job.title, q.title) &&
        contains(job.company, q.company) &&
        contains(technologies.join(" "), q.technology) &&
        (!q.seniority ||
          (job.seniority || inferred.seniority) === q.seniority) &&
        (!q.modality || (job.modality || inferred.modality) === q.modality) &&
        (!q.source || job.sources.some((s) => s.provider === q.source)) &&
        contains(job.contractType || inferred.contractType, q.contract) &&
        (!q.status || job.status === q.status) &&
        (q.minScore === undefined || job.score >= q.minScore) &&
        (!q.hours ||
          (job.publishedAt &&
            Date.parse(job.publishedAt) >= Date.now() - q.hours * 36e5)) &&
        (!q.competition ||
          (q.competition === "unknown"
            ? job.matching.competition === null
            : job.matching.competition === q.competition)) &&
        (q.eligibleOnly !== "true" ||
          (job.matching.eligible === true &&
            !job.matching.exclusions.length)) &&
        (!q.relevance ||
          q.relevance === "all" ||
          (q.relevance === "relevant"
            ? !job.matching.exclusions.length
            : job.matching.exclusions.length))
      );
    });
    jobs.sort(
      q.sort === "date"
        ? (a, b) =>
            (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0)
        : q.sort === "competition"
          ? (a, b) =>
              (a.applicantCount ?? Infinity) - (b.applicantCount ?? Infinity) ||
              b.score - a.score
          : (a, b) =>
              b.score - a.score ||
              Number(Boolean(b.matching.lowCompetition)) -
                Number(Boolean(a.matching.lowCompetition)) ||
              (Date.parse(b.publishedAt) || 0) -
                (Date.parse(a.publishedAt) || 0),
    );
    res.json({
      total: jobs.length,
      page: q.page,
      limit: q.limit,
      items: jobs.slice((q.page - 1) * q.limit, q.page * q.limit),
    });
  });
  app.get("/api/jobs/:id", (req, res) => {
    const job = store.getJob(parseId(req.params.id));
    const row = store.db
      .prepare("SELECT id FROM applications WHERE job_id=?")
      .get(job.id);
    res.json({
      ...job,
      application: row ? store.getApplication(row.id) : null,
    });
  });
  app.post("/api/jobs/import", requireJson, (req, res) => {
    const input = jobInput.parse(req.body);
    const hostname = new URL(input.url).hostname;
    const linkedin =
      hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
    const originalId = linkedin
      ? new URL(input.url).pathname.match(
          /^\/jobs\/view\/(?:.*-)?(\d+)\/?$/,
        )?.[1] || null
      : null;
    const job = {
      ...input,
      description: plain(input.description),
      applicationUrl: input.applicationUrl || input.url,
      provider: linkedin ? "linkedin-manual" : "manual",
      board: "",
      originalId,
      provenance: "user",
    };
    const result = store.upsertJob(job);
    res.status(result.inserted ? 201 : 200).json(result);
  });
  app.patch("/api/jobs/:id", requireJson, (req, res) => {
    const id = parseId(req.params.id);
    store.getJob(id);
    const { status } = z
      .object({ status: z.enum(["saved", "discarded", "new", "reviewing"]) })
      .strict()
      .parse(req.body);
    const application = store.ensureApplication(id);
    res.json(store.updateApplication(application.id, { status }));
  });
  app.post("/api/jobs/:id/score", (req, res) =>
    res.json(store.rescore(parseId(req.params.id))),
  );
  app.post("/api/jobs/:id/prepare", (req, res) =>
    res.json(prepareApplication(store, parseId(req.params.id))),
  );
  app.post("/api/alerts/parse", upload.single("file"), async (req, res) => {
    const text = req.file
      ? req.file.buffer.toString("utf8")
      : z
          .string()
          .min(1)
          .max(2 * 1024 * 1024)
          .parse(req.body.text);
    res.json(await parseAlert(text, Boolean(req.file)));
  });
  app.get("/api/applications", (req, res) =>
    res.json(
      store.db
        .prepare("SELECT id FROM applications ORDER BY updated_at DESC")
        .all()
        .map((row) => store.getApplication(row.id)),
    ),
  );
  app.post("/api/applications", requireJson, (req, res) => {
    const input = z
      .object({ jobId: z.number().int().positive() })
      .strict()
      .parse(req.body);
    res.status(201).json(store.ensureApplication(input.jobId));
  });
  app.patch("/api/applications/:id", requireJson, (req, res) =>
    res.json(
      store.updateApplication(
        parseId(req.params.id),
        applicationPatch.parse(req.body),
      ),
    ),
  );
  app.get("/api/transitions", (req, res) => res.json(transitions));
  app.get("/api/sources", (req, res) =>
    res.json(
      store.db
        .prepare("SELECT * FROM sources ORDER BY id")
        .all()
        .map((s) => ({ ...s, enabled: Boolean(s.enabled) })),
    ),
  );
  app.post("/api/sources", requireJson, (req, res) => {
    const source = sourceInput.parse(req.body);
    const result = store.db
      .prepare(
        "INSERT INTO sources(provider,board,company,enabled) VALUES (?,?,?,?)",
      )
      .run(
        source.provider,
        source.board,
        source.company,
        Number(source.enabled),
      );
    res.status(201).json({ id: Number(result.lastInsertRowid), ...source });
  });
  app.patch("/api/sources/:id", requireJson, (req, res) => {
    const id = parseId(req.params.id),
      source = sourceInput.pick({ enabled: true }).parse(req.body);
    const result = store.db
      .prepare("UPDATE sources SET enabled=? WHERE id=?")
      .run(Number(source.enabled), id);
    if (!result.changes) throw new HttpError(404, "Fonte não encontrada");
    res.json({ id, ...source });
  });
  app.post("/api/collection/run", async (req, res) => {
    if (!store.getSettings().collectionEnabled)
      throw new HttpError(409, "Coleta pausada; retome nas configurações");
    res.json(await collector.run());
  });
  app.get("/api/collection/history", (req, res) =>
    res.json(
      store.db
        .prepare("SELECT * FROM collection_runs ORDER BY id DESC LIMIT 50")
        .all()
        .map((r) => ({ ...r, errors: JSON.parse(r.errors) })),
    ),
  );
  app.get("/api/notifications", (req, res) =>
    res.json(
      store.db
        .prepare("SELECT * FROM notifications ORDER BY id DESC LIMIT 100")
        .all(),
    ),
  );
  app.post("/api/notifications/read", (req, res) => {
    store.db.prepare("UPDATE notifications SET read=1 WHERE read=0").run();
    res.json({ ok: true });
  });
  app.get("/api/dashboard", (req, res) => {
    const jobs = store.db
      .prepare("SELECT * FROM jobs")
      .all()
      .map(store.hydrate);
    const apps = store.db
      .prepare(
        "SELECT status,COUNT(*) AS total FROM applications GROUP BY status",
      )
      .all();
    res.json({
      total: jobs.length,
      new: jobs.filter((j) => j.status === "new").length,
      highMatch: jobs.filter(
        (j) =>
          j.score >= store.getSettings().minScore &&
          !j.matching.exclusions.length,
      ).length,
      remote: jobs.filter(
        (j) => (j.modality || j.matching.inferred.modality) === "remote",
      ).length,
      awaiting: jobs.filter((j) =>
        ["saved", "reviewing", "prepared", "started"].includes(j.status),
      ).length,
      sent: store.db
        .prepare(
          "SELECT COUNT(*) AS total FROM applications WHERE sent_at IS NOT NULL",
        )
        .get().total,
      interviews: apps.find((a) => a.status === "interview")?.total || 0,
      applications: apps,
      recent: jobs.filter(
        (j) =>
          j.publishedAt &&
          Date.parse(j.publishedAt) >=
            Date.now() - store.getSettings().primaryHours * 36e5,
      ).length,
      sources: store.db.prepare("SELECT * FROM sources ORDER BY id").all(),
      lastRun:
        store.db
          .prepare("SELECT * FROM collection_runs ORDER BY id DESC LIMIT 1")
          .get() || null,
    });
  });
  app.post("/api/resumes", upload.single("file"), (req, res) => {
    if (!req.file)
      throw new HttpError(400, "Selecione um currículo PDF ou TXT (até 2 MB)");
    const pdf = req.file.buffer.subarray(0, 5).toString() === "%PDF-";
    const txt =
      req.file.originalname.toLowerCase().endsWith(".txt") &&
      !req.file.buffer.includes(0);
    if (!pdf && !txt)
      throw new HttpError(400, "Formato inválido: use PDF ou texto UTF-8");
    const directory = path.join(dataDir, "resumes");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = `${crypto.randomUUID()}.${pdf ? "pdf" : "txt"}`;
    fs.writeFileSync(path.join(directory, filename), req.file.buffer, {
      mode: 0o600,
    });
    let id;
    try {
      id = Number(
        store.db
          .prepare(
            "INSERT INTO resumes(name,filename,mime,created_at) VALUES (?,?,?,?)",
          )
          .run(
            path.basename(req.file.originalname).slice(0, 200),
            filename,
            pdf ? "application/pdf" : "text/plain",
            now(),
          ).lastInsertRowid,
      );
    } catch (error) {
      fs.unlinkSync(path.join(directory, filename));
      throw error;
    }
    res.status(201).json({ id, name: req.file.originalname });
  });
  app.get("/api/resumes/:id/download", (req, res) => {
    const resume = store.db
      .prepare("SELECT * FROM resumes WHERE id=?")
      .get(parseId(req.params.id));
    if (!resume) throw new HttpError(404, "Currículo não encontrado");
    res
      .type(resume.mime)
      .download(path.join(dataDir, "resumes", resume.filename), resume.name);
  });
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "Endpoint não encontrado" }),
  );
  app.use(
    express.static(fileURLToPath(new URL("../public", import.meta.url)), {
      index: "index.html",
    }),
  );
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof ZodError)
      return res
        .status(400)
        .json({
          error: "Dados inválidos",
          details: error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
        });
    if (error instanceof multer.MulterError)
      return res
        .status(400)
        .json({ error: "Arquivo inválido ou maior que 2 MB" });
    if (error.code?.startsWith("SQLITE_CONSTRAINT"))
      return res
        .status(409)
        .json({ error: "Registro duplicado ou referência inválida" });
    if (
      error.type === "entity.parse.failed" ||
      error.type === "entity.too.large"
    )
      return res
        .status(error.type === "entity.too.large" ? 413 : 400)
        .json({ error: "Requisição inválida" });
    if (error.status)
      return res.status(error.status).json({ error: error.message });
    logger.error({ type: error.name, code: error.code }, "Erro interno");
    res
      .status(500)
      .json({
        error: "Erro interno; consulte os logs técnicos sem dados pessoais",
      });
  });
  return app;
}
