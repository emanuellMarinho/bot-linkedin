import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { prepareApplication } from "../modules/assistant.js";
import { submitLeverApplication } from "../submissions/lever.js";
import { submitLeverBrowserApplication } from "../submissions/lever-browser.js";
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
    !(receipt.applicationId || (receipt.method === "browser" && receipt.confirmation?.sha256 && receipt.confirmation?.url))
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
      .run(receipt.applicationId || null, at, attemptId);
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
        receipt.method === "browser" ? "Envio confirmado pela página de candidatura Lever; evidência registrada no pacote local" : "Envio confirmado pela API autorizada do Lever; recibo registrado no banco",
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
    browserSubmit = submitLeverBrowserApplication,
    aiPlanner = planResume,
    questionSender,
    notify = notifyQuestions,
    notificationConfig = config.whatsapp,
    onProgress,
    env = process.env,
    clock = Date.now,
    signal,
  } = {},
) {
  const progress = async (stage, message, job = null, status = "running", reason) => {
    if (signal?.aborted) return false;
    if (onProgress) await onProgress({
      stage, status, message, ...(reason ? { reason } : {}),
      ...(job ? { jobId: job.id, title: job.title, company: job.company } : {}),
    });
    return !signal?.aborted;
  };
  config = applyQuestionAnswers(store, config);
  const candidatePhone = String(
    (notificationConfig?.transport === "sms"
      ? notificationConfig.to
      : config.notifications?.channel === "sms"
        ? config.sms?.to
        : config.whatsapp.to) || "",
  ).replace(/\D/g, "");
  const settings = store.getSettings();
  if (settings.collectionEnabled && !skipCollection && !signal?.aborted)
    await progress("collection", "Buscando vagas nas fontes configuradas.");
  const collected = signal?.aborted
    ? { status: "cancelled", received: 0, inserted: 0, errors: "[]" }
    : !settings.collectionEnabled
    ? { status: "paused", received: 0, inserted: 0, errors: "[]" }
    : skipCollection
      ? { status: "answer_received", received: 0, inserted: 0, errors: "[]" }
      : await collector.run({ signal });
  const collectionMessages = {
    paused: "A busca está pausada nas preferências.",
    waiting: "Aguardando o limite técnico das fontes para consultar novamente.",
    no_sources: "Nenhuma fonte de vagas está ativa.",
    answer_received: "Resposta recebida. Retomando as candidaturas afetadas.",
    partial: "Busca concluída com falha em uma das fontes. As demais oportunidades estão disponíveis.",
  };
  await progress("collection", collectionMessages[collected.status] || "Busca concluída. Preparando as oportunidades compatíveis.", null, "done");
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
    if (!collectOnly && !signal?.aborted) {
      if (await progress("notifications", "Enviando as dúvidas pendentes pelo canal escolhido.")) {
        report.notifications = await notify(store.db, notificationConfig, {
          env, signal, clock,
          ...(questionSender ? { sender: questionSender } : {}),
        });
        await progress("notifications", "Verificação das mensagens concluída.", null, "done");
      }
    }
    report.notifications ||= { sent: 0, pending: 0 };
    // Compatibility for reports consumed by earlier releases.
    report.whatsapp = report.notifications;
    privateJson(
      path.join(config.dataDir, "reports", "questions.json"),
      store.db
        .prepare(
          "SELECT id,job_id,topic,text,answer,notification_status,notification_error,notification_id FROM bot_questions ORDER BY created_at",
        )
        .all(),
    );
    privateJson(path.join(config.dataDir, "reports", "latest.json"), report);
    await progress("complete", "Rodada concluída. O acompanhamento está atualizado.", null, "done");
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
      if (!await progress("resume", "Validando o currículo local.")) return finish();
      cv = await extractResume(config.applicant.resumePath);
      await progress("resume", "Currículo validado.", null, "done");
    } catch {
      report.resumeError = "RESUME_UNREADABLE";
    }
  }
  if (signal?.aborted) return finish();
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
    store.db.prepare("DELETE FROM settings WHERE key=?").run(`bot_pending:${job.id}`);
    const pending = async (reason) => {
      report.pending.push({ jobId: job.id, reason });
      store.db.prepare("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`bot_pending:${job.id}`, JSON.stringify({reason,at:now()}));
      await progress("waiting", "Esta candidatura aguarda uma informação ou ação; as outras vagas continuam.", job, "waiting", reason);
    };
    const existing = store.db
      .prepare("SELECT * FROM submission_attempts WHERE job_id=?")
      .get(job.id);
    if (existing) {
      await pending(`PREVIOUS_${existing.status.toUpperCase()}`);
      continue;
    }
    if (job.status === "started") {
      await pending("MANUALLY_STARTED");
      continue;
    }
    if (!cv) {
      await pending("RESUME_REQUIRED");
      continue;
    }
    if (!await progress("job", "Verificando os dados desta oportunidade.", job)) break;
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
    if (!profile.name.trim() || !config.applicant.email) {
      await pending("AWAITING_CANDIDATE_ANSWERS");
      continue;
    }
    let plan = { skillOrder: [], questions: [], provider: "disabled" };
    if (config.ai.enabled) {
      if (!await progress("analysis", "Analisando a vaga com os dados confirmados do currículo.", job)) break;
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
              signal,
            },
          );
          privateJson(cached, plan);
        }
      } catch (error) {
        await pending(
          /^AI_[A-Z_]+$/.test(error.code || "") ? error.code : "AI_UNAVAILABLE",
        );
      }
    }
    if (signal?.aborted) break;
    for (const question of plan.questions)
      askQuestion(store.db, {
        id: `JOB_${job.id}_${question.id}`,
        jobId: job.id,
        topic: question.topic,
        text: question.text.slice(0, 700),
      });
    if (!await progress("preparation", "Preparando o currículo ATS desta vaga.", job)) break;
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
      await pending("ATS_RESUME_FAILED");
      continue;
    }
    report.prepared++;
    if (!await progress("preparation", "Currículo ATS preparado.", job, "done")) break;
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
      await pending("AUTO_APPLY_DISABLED");
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
      await pending("AWAITING_CANDIDATE_ANSWERS");
      continue;
    }
    const browserMode = config.autoApply.mode === "browser";
    const source = job.sources.find(
      (s) =>
        s.provider === "lever" &&
        (browserMode || config.autoApply.sources.some(
          (c) => c.provider === "lever" && c.board === s.board,
        )),
    );
    if (!source) {
      await pending("NO_AUTHORIZED_CONNECTOR");
      continue;
    }
    const connection = config.autoApply.sources.find(
      (c) => c.board === source.board,
    );
    if (!browserMode && !connection.authorizationConfirmed) {
      await pending("PLATFORM_AUTHORIZATION_REQUIRED");
      continue;
    }
    const apiKey = connection ? env[connection.apiKeyEnv] : undefined;
    if (!browserMode && !apiKey) {
      await pending("PROVIDER_CREDENTIAL_REQUIRED");
      continue;
    }
    if (!config.applicant.email || !profile.name.trim()) {
      await pending("CONTACT_REQUIRED");
      continue;
    }
    if (
      m.eligible !== true ||
      !settings.seniorities.includes(job.seniority || m.inferred.seniority)
    ) {
      await pending("ELIGIBILITY_UNCONFIRMED");
      continue;
    }
    // Uma data ausente permanece desconhecida; datas conhecidas antigas não são aceitas.
    if (
      job.publishedAt &&
      (Date.parse(job.publishedAt) < clock() - settings.secondaryDays * 864e5 ||
        Date.parse(job.publishedAt) > clock())
    ) {
      await pending("OUTSIDE_RECENCY_WINDOW");
      continue;
    }
    if (!required.length || required.some((s) => !verified.has(normalize(s)))) {
      await pending("REQUIREMENTS_UNCONFIRMED");
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
      await pending("APPLICATION_LIMIT");
      continue;
    }
    const resume = fs.readFileSync(tailored.pdfPath);
    if (resume.length > 2 * 1024 * 1024) {
      await pending("RESUME_TOO_LARGE");
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
    let browserFingerprint;
    const beginAttempt = () => store.db.transaction(() => {
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
    // Margem abaixo do limite documentado de duas requisições por segundo.
    if (lastSubmit) {
      try { await delay(Math.max(0, 600 - (Date.now() - lastSubmit)), undefined, { signal }); }
      catch (error) { if (!signal?.aborted) throw error; }
    }
    lastSubmit = Date.now();
    if (signal?.aborted) {
      if (attemptId) store.db
        .prepare(
          "UPDATE submission_attempts SET status='failed',error_code='CANCELLED',updated_at=? WHERE id=?",
        )
        .run(now(), attemptId);
      break;
    }
    if (!await progress("application", "Validando os campos e as respostas da candidatura.", job)) break;
    try {
      let receipt;
      if (browserMode) {
        const answers = Object.fromEntries(store.db.prepare("SELECT metadata,answer FROM bot_questions WHERE job_id=? AND topic='form' AND answer IS NOT NULL").all(job.id).map((row)=>[JSON.parse(row.metadata).fieldKey,row.answer]));
        browserFingerprint = crypto.createHash("sha256").update(JSON.stringify([job.description,cv.sha256,Object.fromEntries(Object.entries(profile).filter(([key])=>key!=="resumes")),config.applicant,candidatePhone,config.autoApply,answers])).digest("hex");
        const previousBlock = store.db.prepare("SELECT value FROM settings WHERE key=?").get(`browser_blocker:${job.id}`);
        if (previousBlock) {
          const blocker = JSON.parse(previousBlock.value);
          if (blocker.fingerprint === browserFingerprint) { await pending(blocker.reason); continue; }
          store.db.prepare("DELETE FROM settings WHERE key=?").run(`browser_blocker:${job.id}`);
        }
        receipt = await browserSubmit({
          board: source.board, postingId: source.originalId,
          fullName:profile.name,email:config.applicant.email,phone:candidatePhone,
          links:profile.professionalLinks,resumePath:tailored.pdfPath,answers,
        }, {signal,onBeforeSubmit:async()=>{
          if (!await progress("submission", "Enviando a candidatura e aguardando confirmação da plataforma.", job))
            throw Object.assign(new Error("Envio cancelado antes de começar."), {code:"CANCELLED"});
          beginAttempt(); attemptsThisRun++;
        }});
        if (receipt.pendingQuestions?.length) {
          for (const field of receipt.pendingQuestions) askQuestion(store.db,{
            id:`FORM_${job.id}_${field.key}`,jobId:job.id,topic:'form',
            text:`${job.company} — ${job.title}: ${field.label}${field.options?.length ? ` Opções: ${field.options.join('; ')}` : ''}${field.yesNo ? ' Responda sim ou não.' : ''}`.slice(0,700),
            metadata:{fieldKey:field.key,options:field.options || [],yesNo:!!field.yesNo},
          });
          await pending('AWAITING_FORM_ANSWERS');
          continue;
        }
      } else {
        if (!await progress("submission", "Enviando a candidatura e aguardando confirmação da plataforma.", job)) break;
        beginAttempt(); attemptsThisRun++;
        receipt = await submit({
        board: source.board,
        postingId: source.originalId,
        apiKey,
        fullName: profile.name,
        email: config.applicant.email,
        resume,
        resumeName: "curriculo-ats.pdf",
        comments: profile.summary || undefined,
      }, { signal });
      }
      recordReceipt(store, attemptId, application.id, receipt);
      report.submitted++;
      await progress("submission", "Candidatura confirmada pela plataforma.", job, "done");
      privateJson(path.join(config.dataDir, "outbox", `job-${job.id}.json`), {
        ...packet,
        sent: true,
        provider: "lever",
        ...(receipt.applicationId ? {applicationId: receipt.applicationId} : {confirmation:receipt.confirmation,method:receipt.method}),
      });
    } catch (error) {
      const code =
        typeof error.code === "string" && /^[A-Z_]+$/.test(error.code)
          ? error.code
          : "AMBIGUOUS";
      if (browserMode && !attemptId && browserFingerprint && ["CAPTCHA_REQUIRED","LOGIN_REQUIRED","UNSUPPORTED_FORM","INVALID_FORM_ANSWER","CONSENT_DECLINED"].includes(code))
        store.db.prepare("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`browser_blocker:${job.id}`,JSON.stringify({fingerprint:browserFingerprint,reason:code}));
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
      if (attemptId) store.db
        .prepare(
          "UPDATE submission_attempts SET status=?,error_code=?,retry_at=?,updated_at=? WHERE id=?",
        )
        .run(status, code, error.retryAt || null, now(), attemptId);
      await pending(code);
    }
  }
  return finish();
}
