import { canonicalUrl, fingerprint, now, HttpError } from "../utils.js";
import { scoreJob } from "../modules/matching.js";
import { transitions } from "../config.js";

export function createStore(db) {
  const getSettings = () => {
    const value = JSON.parse(
      db.prepare("SELECT value FROM settings WHERE key=?").get("preferences")
        .value,
    );
    value.keywordGroups = {};
    for (const row of db
      .prepare("SELECT group_name,term FROM job_keywords ORDER BY id")
      .all())
      (value.keywordGroups[row.group_name] ||= []).push(row.term);
    return value;
  };
  const getProfile = () => ({
    ...JSON.parse(
      db.prepare("SELECT data FROM candidate_profile WHERE id=1").get().data,
    ),
    skills: db
      .prepare("SELECT name,verified FROM candidate_skills")
      .all()
      .map((s) => ({ ...s, verified: Boolean(s.verified) })),
    resumes: db
      .prepare("SELECT id,name,mime,created_at FROM resumes ORDER BY id DESC")
      .all(),
  });
  const hydrate = (row) =>
    row && {
      ...JSON.parse(row.data),
      id: row.id,
      score: row.score,
      status: row.status,
      collectedAt: row.collected_at,
      matching: JSON.parse(row.matching),
      sources: db
        .prepare(
          "SELECT provider,board,original_id AS originalId,original_url AS url,collected_at AS collectedAt FROM job_sources WHERE job_id=?",
        )
        .all(row.id),
    };
  const getJob = (id) => {
    const job = hydrate(db.prepare("SELECT * FROM jobs WHERE id=?").get(id));
    if (!job) throw new HttpError(404, "Vaga não encontrada");
    return job;
  };
  const notification = (type, message, jobId = null) => {
    if (getSettings().notificationsEnabled)
      db.prepare(
        "INSERT INTO notifications(type,message,job_id,created_at) VALUES (?,?,?,?)",
      ).run(type, message, jobId, now());
  };
  const rescore = (id) => {
    const job = getJob(id),
      matching = scoreJob(job, getProfile(), getSettings());
    db.prepare("UPDATE jobs SET score=?,matching=? WHERE id=?").run(
      matching.score,
      JSON.stringify(matching),
      id,
    );
    return getJob(id);
  };
  const rescoreAll = () =>
    db.transaction(() => {
      for (const { id } of db.prepare("SELECT id FROM jobs").all()) rescore(id);
    })();
  const saveProfile = (profile) =>
    db.transaction(() => {
      const { skills, ...rest } = profile;
      db.prepare("UPDATE candidate_profile SET data=? WHERE id=1").run(
        JSON.stringify(rest),
      );
      db.prepare("DELETE FROM candidate_skills").run();
      for (const s of skills)
        db.prepare("INSERT INTO candidate_skills VALUES (?,?)").run(
          s.name,
          Number(s.verified),
        );
      rescoreAll();
      return getProfile();
    })();
  const saveSettings = (settings) =>
    db.transaction(() => {
      db.prepare("UPDATE settings SET value=? WHERE key=?").run(
        JSON.stringify(settings),
        "preferences",
      );
      db.prepare("DELETE FROM job_keywords").run();
      for (const [group, terms] of Object.entries(settings.keywordGroups))
        for (const term of new Set(terms))
          db.prepare(
            "INSERT INTO job_keywords(group_name,term) VALUES (?,?)",
          ).run(group, term);
      rescoreAll();
      return getSettings();
    })();
  const upsertJob = (job) =>
    db.transaction(() => {
      const canonical = canonicalUrl(job.url),
        fp = fingerprint(job);
      let existing = job.originalId
        ? db
            .prepare(
              "SELECT j.* FROM jobs j JOIN job_sources s ON s.job_id=j.id WHERE s.provider=? AND s.board=? AND s.original_id=?",
            )
            .get(job.provider, job.board || "", job.originalId)
        : null;
      existing ||= db
        .prepare("SELECT * FROM jobs WHERE canonical_url=?")
        .get(canonical);
      // A igualdade de empresa/cargo só deduplica com localização conhecida; IDs distintos do mesmo quadro são vagas distintas.
      if (!existing && job.location)
        existing = db
          .prepare(
            "SELECT j.* FROM jobs j WHERE fingerprint=? AND NOT EXISTS (SELECT 1 FROM job_sources s WHERE s.job_id=j.id AND s.provider=? AND s.board=? AND s.original_id IS NOT NULL AND s.original_id!=?)",
          )
          .get(fp, job.provider, job.board || "", job.originalId || "");
      let id,
        inserted = false;
      if (existing) {
        id = existing.id;
        const old = JSON.parse(existing.data);
        if (
          old.provider === job.provider &&
          old.board === job.board &&
          old.provenance !== "user"
        ) {
          const updated = { ...old, ...job };
          db.prepare(
            "UPDATE jobs SET company=?,title=?,location=?,published_at=?,data=? WHERE id=?",
          ).run(
            updated.company,
            updated.title,
            updated.location,
            updated.publishedAt,
            JSON.stringify(updated),
            id,
          );
        }
      } else {
        const matching = scoreJob(job, getProfile(), getSettings());
        id = Number(
          db
            .prepare(
              "INSERT INTO jobs(company,title,canonical_url,fingerprint,location,published_at,collected_at,score,data,matching) VALUES (?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              job.company,
              job.title,
              canonical,
              fp,
              job.location,
              job.publishedAt,
              now(),
              matching.score,
              JSON.stringify(job),
              JSON.stringify(matching),
            ).lastInsertRowid,
        );
        inserted = true;
        if (
          matching.score >= getSettings().minScore &&
          !matching.exclusions.length
        )
          notification(
            "match",
            `Nova vaga compatível: ${job.title} • ${job.company}`,
            id,
          );
      }
      db.prepare(
        "INSERT OR IGNORE INTO job_sources(job_id,provider,board,original_id,original_url,collected_at) VALUES (?,?,?,?,?,?)",
      ).run(
        id,
        job.provider,
        job.board || "",
        job.originalId || null,
        canonical,
        now(),
      );
      if (!inserted) rescore(id);
      return { job: getJob(id), inserted };
    })();
  const getApplication = (id) => {
    const row = db.prepare("SELECT * FROM applications WHERE id=?").get(id);
    if (!row) throw new HttpError(404, "Candidatura não encontrada");
    return {
      ...row,
      preparation: row.preparation ? JSON.parse(row.preparation) : null,
      job: getJob(row.job_id),
      events: db
        .prepare(
          "SELECT * FROM application_events WHERE application_id=? ORDER BY id",
        )
        .all(id),
    };
  };
  const ensureApplication = (jobId) => {
    getJob(jobId);
    let row = db
      .prepare("SELECT id FROM applications WHERE job_id=?")
      .get(jobId);
    if (!row) {
      const status = getJob(jobId).status;
      const id = Number(
        db
          .prepare(
            "INSERT INTO applications(job_id,status,updated_at) VALUES (?,?,?)",
          )
          .run(jobId, status, now()).lastInsertRowid,
      );
      db.prepare(
        "INSERT INTO application_events(application_id,to_status,note,created_at) VALUES (?,?,?,?)",
      ).run(id, status, "Acompanhamento criado pelo usuário", now());
      row = { id };
    }
    return getApplication(row.id);
  };
  const updateApplication = (id, changes) =>
    db.transaction(() => {
      const app = getApplication(id),
        next = changes.status || app.status;
      if (next !== app.status && !transitions[app.status].includes(next))
        throw new HttpError(409, "Transição de status não permitida");
      if (
        next === "sent" &&
        app.status !== "sent" &&
        changes.confirmedSent !== true
      )
        throw new HttpError(
          400,
          "Confirme explicitamente que você enviou a candidatura na plataforma",
        );
      if (
        changes.resumeId != null &&
        !db.prepare("SELECT id FROM resumes WHERE id=?").get(changes.resumeId)
      )
        throw new HttpError(400, "Currículo não encontrado");
      db.prepare(
        "UPDATE applications SET status=?,notes=?,resume_id=?,sent_at=?,updated_at=? WHERE id=?",
      ).run(
        next,
        changes.notes ?? app.notes,
        changes.resumeId === undefined ? app.resume_id : changes.resumeId,
        next === "sent" ? app.sent_at || now() : app.sent_at,
        now(),
        id,
      );
      db.prepare("UPDATE jobs SET status=? WHERE id=?").run(next, app.job_id);
      if (
        next !== app.status ||
        changes.notes !== undefined ||
        changes.resumeId !== undefined
      )
        db.prepare(
          "INSERT INTO application_events(application_id,from_status,to_status,note,created_at) VALUES (?,?,?,?,?)",
        ).run(
          id,
          app.status,
          next,
          next === "sent"
            ? "Envio confirmado explicitamente pelo usuário"
            : "Atualização manual do acompanhamento",
          now(),
        );
      if (next !== app.status)
        notification(
          "status",
          `Status atualizado: ${app.job.title} → ${next}`,
          app.job_id,
        );
      return getApplication(id);
    })();
  return {
    db,
    getSettings,
    getProfile,
    saveProfile,
    saveSettings,
    getJob,
    hydrate,
    upsertJob,
    rescore,
    rescoreAll,
    notification,
    getApplication,
    ensureApplication,
    updateApplication,
  };
}
