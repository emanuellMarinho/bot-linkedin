import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { prepareApplication } from "../modules/assistant.js";
import { submitLeverApplication } from "../submissions/lever.js";
import { extractResume, createAtsResume } from "../resume/index.js";
import { planResume } from "../ai/openai.js";
import {
  askQuestion,
  applyQuestionAnswers,
  notifyQuestions,
} from "./questions.js";
import { normalize, now } from "../utils.js";

export function privateJson(filename, data) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = filename + "." + crypto.randomUUID() + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, filename);
}

export function recoverInterruptedSubmissions(db) {
  db.prepare(
    "UPDATE submission_attempts SET status='ambiguous',error_code='INTERRUPTED',updated_at=? WHERE status='sending'",
  ).run(now());
  db.prepare(
    "UPDATE bot_questions SET notification_status='ambiguous',notification_error='INTERRUPTED' WHERE notification_status='sending'",
  ).run();
}

function recordReceipt(store, attemptId, applicationId, receipt) {
  if (
    receipt?.provider !== "lever" ||
    receipt.verified !== true ||
    !receipt.applicationId
  )
    throw new Error("Sem comprovante verificável");
  store.db.transaction(() => {
    const attempt = store.db
      .prepare("SELECT * FROM submission_attempts WHERE id=?")
      .get(attemptId);
    if (
      attempt.status !== "sending" ||
      attempt.provider !== receipt.provider ||
      attempt.board !== receipt.board ||
      attempt.posting_id !== receipt.postingId
    )
      throw new Error("Comprovante incompatível");
    const application = store.getApplication(applicationId);
    if (application.status !== "started")
      throw new Error("Status incompatível");
    const at = now();
    store.db
      .prepare(
        "UPDATE submission_attempts SET status='submitted',provider_application_id=?,error_code=NULL,updated_at=? WHERE id=?",
      )
      .run(receipt.applicationId, at, attemptId);
    store.db
      .prepare(
        "UPDATE applications SET status='sent',sent_at=?,updated_at=? WHERE id=?",
      )
      .run(at, at, applicationId);
    store.db
      .prepare("UPDATE jobs SET status='sent' WHERE id=?")
      .run(application.job_id);
    store.db
      .prepare(
        "INSERT INTO application_events(application_id,from_status,to_status,note,created_at) VALUES (?,'started','sent',?,?)",
      )
      .run(
        applicationId,
        "Envio confirmado pela API autorizada do Lever; recibo registrado no banco",
        at,
      );
  })();
}

export async function runBotCycle(
  store,
  collector,
  config,
  {
    collectOnly = false,
    skipCollection = false,
    submit = submitLeverApplication,
    aiPlanner = planResume,
    questionSender,
    env = process.env,
    clock = Date.now,
    signal,
  } = {},
) {
  config = applyQuestionAnswers(store, config);
  const settings = store.getSettings();
  const collected = !settings.collectionEnabled
    ? { status: "paused", received: 0, inserted: 0, errors: "[]" }
    : skipCollection
      ? { status: "answer_received", received: 0, inserted: 0, errors: "[]" }
      : await collector.run();
  const report = {
    at: now(),
    collection: {
      status: collected.status,
      received: collected.received,
      inserted: collected.inserted,
      errors: JSON.parse(collected.errors),
    },
    prepared: 0,
    submitted: 0,
    pending: [],
    skipped: 0,
  };
  const finish = async () => {
    report.whatsapp =
      collectOnly || signal?.aborted
        ? { sent: 0, pending: 0 }
        : await notifyQuestions(store.db, config.whatsapp, {
            env,
            ...(questionSender ? { sender: questionSender } : {}),
          });
    privateJson(
      path.join(config.dataDir, "reports", "questions.json"),
      store.db
        .prepare(
          "SELECT id,job_id,topic,text,answer,notification_status FROM bot_questions ORDER BY created_at",
        )
        .all(),
    );
    privateJson(path.join(config.dataDir, "reports", "latest.json"), report);
    return report;
  };
  if (collectOnly || !settings.collectionEnabled || signal?.aborted)
    return finish();
  store.rescoreAll();
  const profile = store.getProfile();
  const verified = new Set(
    profile.skills.filter((s) => s.verified).map((s) => normalize(s.name)),
  );
  let cv = null;
  if (config.applicant.resumePath) {
    try {
      cv = await extractResume(config.applicant.resumePath);
    } catch {
      report.resumeError = "RESUME_UNREADABLE";
    }
  }
  let attemptsThisRun = 0,
    lastSubmit = 0;
  const jobs = store.db
    .prepare(
      "SELECT id FROM jobs WHERE status IN ('new','saved','reviewing','prepared','started') ORDER BY score DESC,id",
    )
    .all()
    .map((row) => store.getJob(row.id));
  for (const job of jobs) {
    if (signal?.aborted) break;
    const m = job.matching;
    if (
      job.provenance === "demo" ||
      m.exclusions.length ||
      job.score < settings.minScore
    ) {
      report.skipped++;
      continue;
    }
    const pending = (reason) => report.pending.push({ jobId: job.id, reason });
    const existing = store.db
      .prepare("SELECT * FROM submission_attempts WHERE job_id=?")
      .get(job.id);
    if (existing) {
      pending(`PREVIOUS_${existing.status.toUpperCase()}`);
      continue;
    }
    if (job.status === "started") {
      pending("MANUALLY_STARTED");
      continue;
    }
    if (!cv) {
      pending("RESUME_REQUIRED");
      continue;
    }
    if (!profile.name.trim())
      askQuestion(store.db, {
        id: "PROFILE_NAME",
        topic: "name",
        text: "Qual nome completo deve constar na candidatura? Responda com seu nome profissional.",
      });
    if (!config.applicant.email)
      askQuestion(store.db, {
        id: "APPLICANT_EMAIL",
        topic: "email",
        text: "Qual e-mail de contato você deseja informar nas candidaturas?",
      });
    let plan = { skillOrder: [], questions: [], provider: "disabled" };
    if (config.ai.enabled) {
      const cacheHash = crypto
        .createHash("sha256")
        .update(
          JSON.stringify([
            cv.sha256,
            job.description,
            profile.skills,
            config.ai.model,
          ]),
        )
        .digest("hex");
      const cached = path.join(
        config.dataDir,
        "plans",
        `job-${job.id}-${cacheHash}.json`,
      );
      try {
        if (fs.existsSync(cached))
          plan = JSON.parse(fs.readFileSync(cached, "utf8"));
        else {
          plan = await aiPlanner(
            {
              resumeText: cv.text,
              job,
              verifiedSkills: profile.skills
                .filter((s) => s.verified)
                .map((s) => s.name),
            },
            {
              enabled: true,
              apiKey: env[config.ai.apiKeyEnv],
              model: config.ai.model,
            },
          );
          privateJson(cached, plan);
        }
      } catch (error) {
        pending(
          /^AI_[A-Z_]+$/.test(error.code || "") ? error.code : "AI_UNAVAILABLE",
        );
      }
    }
    for (const question of plan.questions)
      askQuestion(store.db, {
        id: `JOB_${job.id}_${question.id}`,
        jobId: job.id,
        topic: question.topic,
        text: question.text.slice(0, 700),
      });
    const application = prepareApplication(store, job.id);
    let tailored;
    try {
      tailored = await createAtsResume({
        source: cv,
        job,
        profile,
        outputDir: path.join(config.dataDir, "tailored"),
        plan: { skillOrder: plan.skillOrder },
      });
    } catch {
      pending("ATS_RESUME_FAILED");
      continue;
    }
    report.prepared++;
    const answered = store.db
      .prepare(
        "SELECT topic,answer FROM bot_questions WHERE job_id=? AND answer IS NOT NULL",
      )
      .all(job.id);
    const packet = {
      jobId: job.id,
      title: job.title,
      company: job.company,
      url: job.applicationUrl,
      score: job.score,
      preparation: application.preparation,
      resumePdf: tailored.pdfPath,
      resumeText: tailored.textPath,
      declaredAnswers: answered,
      sent: false,
    };
    privateJson(
      path.join(config.dataDir, "outbox", `job-${job.id}.json`),
      packet,
    );
    if (!config.autoApply.enabled) {
      pending("AUTO_APPLY_DISABLED");
      continue;
    }
    const required = job.requiredSkills ?? m.inferred.requiredSkills;
    for (const skill of required.filter((s) => !verified.has(normalize(s))))
      askQuestion(store.db, {
        id: `SKILL_${crypto.createHash("sha256").update(normalize(skill)).digest("hex").slice(0, 10)}`,
        topic: "skill",
        text: `A vaga exige ${skill}. Você confirma que possui experiência nessa tecnologia? Responda sim ou não.`,
        metadata: { skillName: skill },
      });
    const outstanding = store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM bot_questions WHERE answer IS NULL AND (job_id=? OR (job_id IS NULL AND topic IN ('name','email')))",
      )
      .get(job.id).n;
    if (outstanding) {
      pending("AWAITING_CANDIDATE_ANSWERS");
      continue;
    }
    const source = job.sources.find(
      (s) =>
        s.provider === "lever" &&
        config.autoApply.sources.some(
          (c) => c.provider === "lever" && c.board === s.board,
        ),
    );
    if (!source) {
      pending("NO_AUTHORIZED_CONNECTOR");
      continue;
    }
    const connection = config.autoApply.sources.find(
      (c) => c.board === source.board,
    );
    if (!connection.authorizationConfirmed) {
      pending("PLATFORM_AUTHORIZATION_REQUIRED");
      continue;
    }
    const apiKey = env[connection.apiKeyEnv];
    if (!apiKey) {
      pending("PROVIDER_CREDENTIAL_REQUIRED");
      continue;
    }
    if (!config.applicant.email || !profile.name.trim()) {
      pending("CONTACT_REQUIRED");
      continue;
    }
    if (
      m.eligible !== true ||
      !settings.seniorities.includes(job.seniority || m.inferred.seniority)
    ) {
      pending("ELIGIBILITY_UNCONFIRMED");
      continue;
    }
    // Uma data ausente permanece desconhecida; datas conhecidas antigas não são aceitas.
    if (
      job.publishedAt &&
      (Date.parse(job.publishedAt) < clock() - settings.secondaryDays * 864e5 ||
        Date.parse(job.publishedAt) > clock())
    ) {
      pending("OUTSIDE_RECENCY_WINDOW");
      continue;
    }
    if (!required.length || required.some((s) => !verified.has(normalize(s)))) {
      pending("REQUIREMENTS_UNCONFIRMED");
      continue;
    }
    if (signal?.aborted) break;
    const count = store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM submission_attempts WHERE created_at>=? AND status IN ('sending','submitted','ambiguous')",
      )
      .get(new Date(clock() - 864e5).toISOString()).n;
    if (
      attemptsThisRun >= config.autoApply.maxPerRun ||
      count >= config.autoApply.maxPerDay
    ) {
      pending("APPLICATION_LIMIT");
      continue;
    }
    const resume = fs.readFileSync(tailored.pdfPath);
    if (resume.length > 2 * 1024 * 1024) {
      pending("RESUME_TOO_LARGE");
      continue;
    }
    const resumeFilename = `bot-${tailored.sha256}.pdf`,
      resumeDir = path.join(config.dataDir, "resumes");
    fs.mkdirSync(resumeDir, { recursive: true, mode: 0o700 });
    fs.copyFileSync(tailored.pdfPath, path.join(resumeDir, resumeFilename));
    fs.chmodSync(path.join(resumeDir, resumeFilename), 0o600);
    store.db
      .prepare(
        "INSERT INTO resumes(name,filename,mime,created_at) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM resumes WHERE filename=?)",
      )
      .run(
        "Currículo ATS por vaga.pdf",
        resumeFilename,
        "application/pdf",
        now(),
        resumeFilename,
      );
    const resumeId = store.db
      .prepare("SELECT id FROM resumes WHERE filename=?")
      .get(resumeFilename).id;
    let attemptId;
    store.db.transaction(() => {
      attemptId = Number(
        store.db
          .prepare(
            "INSERT INTO submission_attempts(job_id,provider,board,posting_id,status,created_at,updated_at) VALUES (?,?,?,?,'sending',?,?)",
          )
          .run(job.id, "lever", source.board, source.originalId, now(), now())
          .lastInsertRowid,
      );
      store.updateApplication(application.id, { status: "started", resumeId });
    })();
    attemptsThisRun++;
    // Margem abaixo do limite documentado de duas requisições por segundo.
    if (lastSubmit) await delay(Math.max(0, 600 - (Date.now() - lastSubmit)));
    lastSubmit = Date.now();
    if (signal?.aborted) {
      store.db
        .prepare(
          "UPDATE submission_attempts SET status='failed',error_code='CANCELLED',updated_at=? WHERE id=?",
        )
        .run(now(), attemptId);
      break;
    }
    try {
      const receipt = await submit({
        board: source.board,
        postingId: source.originalId,
        apiKey,
        fullName: profile.name,
        email: config.applicant.email,
        resume,
        resumeName: "curriculo-ats.pdf",
        comments: profile.summary || undefined,
      });
      recordReceipt(store, attemptId, application.id, receipt);
      report.submitted++;
      privateJson(path.join(config.dataDir, "outbox", `job-${job.id}.json`), {
        ...packet,
        sent: true,
        provider: "lever",
        applicationId: receipt.applicationId,
      });
    } catch (error) {
      const code =
        typeof error.code === "string" && /^[A-Z_]+$/.test(error.code)
          ? error.code
          : "AMBIGUOUS";
      const status =
        code === "RATE_LIMIT"
          ? "rate_limited"
          : [
                "VALIDATION",
                "AUTHORIZATION",
                "REJECTED",
                "MISSING_CREDENTIAL",
              ].includes(code)
            ? "failed"
            : "ambiguous";
      store.db
        .prepare(
          "UPDATE submission_attempts SET status=?,error_code=?,retry_at=?,updated_at=? WHERE id=?",
        )
        .run(status, code, error.retryAt || null, now(), attemptId);
      pending(code);
    }
  }
  return finish();
}
