import { z } from "zod";
import crypto from "node:crypto";
import { now } from "../utils.js";
import { sendQuestion } from "../messaging/whatsapp.js";

export function askQuestion(
  db,
  { id, jobId = null, topic, text, metadata = {} },
) {
  db.prepare(
    "INSERT OR IGNORE INTO bot_questions(id,job_id,topic,text,metadata,created_at) VALUES (?,?,?,?,?,?)",
  ).run(id, jobId, topic, text, JSON.stringify(metadata), now());
  return db.prepare("SELECT * FROM bot_questions WHERE id=?").get(id);
}

export function acceptCandidateAnswer(db, { messageId, questionId, answer }) {
  if (
    typeof messageId !== "string" || !messageId || messageId.length > 512 ||
    /[\u0000-\u001f]/.test(messageId) ||
    typeof questionId !== "string" || !/^[A-Za-z0-9_.-]{1,120}$/.test(questionId) ||
    typeof answer !== "string"
  ) return { accepted: false, reason: "invalid_answer" };
  return db.transaction(() => {
    if (
      db
        .prepare("SELECT 1 FROM whatsapp_inbound_messages WHERE message_id=?")
        .get(messageId)
    )
      return { accepted: false, reason: "duplicate" };
    const question = db
      .prepare("SELECT * FROM bot_questions WHERE id=?")
      .get(questionId);
    if (!question || question.answer !== null)
      return { accepted: false, reason: "unknown_or_answered" };
    const value = String(answer).trim();
    if (!value || value.length > 2000 || /[\u0000-\u0008]/.test(value))
      return { accepted: false, reason: "invalid_answer" };
    if (question.topic === "email" && !z.email().safeParse(value).success)
      return { accepted: false, reason: "invalid_email" };
    if (question.topic === "skill" && !/^(sim|nao|não)$/i.test(value))
      return { accepted: false, reason: "expected_yes_no" };
    if (question.topic === "form") {
      const metadata = JSON.parse(question.metadata || "{}");
      if (metadata.yesNo && !/^(sim|nao|não)$/i.test(value)) return {accepted:false,reason:"expected_yes_no"};
      if (metadata.options?.length && !metadata.options.some((option)=>option.toLowerCase() === value.toLowerCase())) return {accepted:false,reason:"invalid_option"};
    }
    db.prepare("INSERT INTO whatsapp_inbound_messages VALUES (?,?)").run(
      messageId,
      now(),
    );
    db.prepare(
      "UPDATE bot_questions SET answer=?,answered_at=? WHERE id=?",
    ).run(value, now(), question.id);
    return { accepted: true };
  })();
}

export function acceptWhatsAppAnswer(db, input) {
  if (input.replyToMessageId) {
    const question = db
      .prepare("SELECT id FROM bot_questions WHERE notification_id=? AND answer IS NULL")
      .get(input.replyToMessageId);
    if (!question || (input.questionId && input.questionId !== question.id))
      return { accepted: false, reason: "unknown_reply" };
    return acceptCandidateAnswer(db, { ...input, questionId: question.id });
  }
  return acceptCandidateAnswer(db, input);
}

export function getWhatsAppStatus(db, { includeDiagnostics = false } = {}) {
  const counts = {
    pending: 0,
    queued: 0,
    accepted: 0,
    delivered: 0,
    read: 0,
    failed: 0,
    ambiguous: 0,
    retry: 0,
    answered: 0,
    errors: [],
  };
  for (const row of db.prepare(
    "SELECT notification_status AS status, answer IS NOT NULL AS answered, COUNT(*) AS n FROM bot_questions WHERE (? OR topic<>'whatsapp_test') GROUP BY notification_status, answer IS NOT NULL",
  ).all(Number(includeDiagnostics))) {
    if (row.answered) {
      counts.answered += row.n;
      continue;
    }
    counts.pending += row.n;
    if (row.status === "pending") counts.queued += row.n;
    else if (["accepted", "delivered", "read", "failed", "ambiguous"].includes(row.status))
      counts[row.status] += row.n;
    else if (row.status === "sending") counts.ambiguous += row.n;
  }
  counts.retry = db.prepare(
    "SELECT COUNT(*) AS n FROM bot_questions WHERE answer IS NULL AND notification_status='pending' AND notification_attempts>0 AND (? OR topic<>'whatsapp_test')",
  ).get(Number(includeDiagnostics)).n;
  counts.errors = db.prepare(
    "SELECT DISTINCT notification_error AS code FROM bot_questions WHERE answer IS NULL AND notification_error IS NOT NULL AND (? OR topic<>'whatsapp_test') ORDER BY code LIMIT 20",
  ).all(Number(includeDiagnostics)).map((row) => row.code).filter((code) => /^[A-Z_]{1,60}$/.test(code));
  return counts;
}

export function recordWhatsAppStatus(
  db,
  { messageId, status, recipient, phoneNumberId, timestamp, errorCode },
) {
  if (
    typeof messageId !== "string" || !messageId || messageId.length > 512 ||
    !["sent", "delivered", "read", "failed"].includes(status) ||
    !/^\d{8,15}$/.test(recipient || "") ||
    (phoneNumberId != null && !/^\d{5,25}$/.test(phoneNumberId)) ||
    !/^\d{1,11}$/.test(String(timestamp))
  ) return { accepted: false, reason: "invalid_status" };
  const stamp = Number(timestamp) * 1000;
  const at = new Date(stamp).toISOString();
  const providerCode = /^\d{1,10}$/.test(String(errorCode)) ? String(errorCode) : null;
  return db.transaction(() => {
    const question = db.prepare("SELECT * FROM bot_questions WHERE notification_id=?").get(messageId);
    if (!question) {
      // Authenticated callbacks may beat the outgoing HTTP response. Keep only
      // a small, expiring buffer; unknown IDs never change candidate data.
      db.prepare("DELETE FROM whatsapp_status_events WHERE received_at<?").run(Date.now() - 86400000);
      db.prepare(
        `INSERT INTO whatsapp_status_events(message_id,recipient,phone_number_id,status,timestamp,error_code,received_at)
         VALUES (?,?,?,?,?,?,?) ON CONFLICT(message_id,recipient,phone_number_id,status)
         DO UPDATE SET timestamp=MAX(timestamp,excluded.timestamp),error_code=excluded.error_code,received_at=excluded.received_at`,
      ).run(messageId, recipient, phoneNumberId || "", status, stamp, providerCode, Date.now());
      db.exec("DELETE FROM whatsapp_status_events WHERE rowid IN (SELECT rowid FROM whatsapp_status_events ORDER BY received_at DESC LIMIT -1 OFFSET 1000)");
      return { accepted: false, reason: "awaiting_receipt" };
    }
    if (
      (question.notification_recipient && question.notification_recipient !== recipient) ||
      (question.notification_phone_number_id && question.notification_phone_number_id !== phoneNumberId))
      return { accepted: false, reason: "unknown_message" };
    const nextStatus = status === "sent" ? "accepted" : status;
    const rank = { pending: 0, sending: 0, ambiguous: 0, failed: 0, accepted: 1, delivered: 2, read: 3 };
    if (
      (nextStatus === "failed" && rank[question.notification_status] >= 2) ||
      (nextStatus === "accepted" && question.notification_status === "failed") ||
      (nextStatus !== "failed" && rank[nextStatus] < rank[question.notification_status]) ||
      (stamp < question.notification_status_at && rank[nextStatus] <= rank[question.notification_status])
    ) return { accepted: false, reason: "outdated_status" };
    db.prepare(
      `UPDATE bot_questions SET notification_status=?,notification_status_at=?,
       notification_error=?,notification_provider_code=?,
       notification_delivered_at=COALESCE(notification_delivered_at,?),
       notification_read_at=COALESCE(notification_read_at,?) WHERE id=?`,
    ).run(
      nextStatus, Math.max(stamp, question.notification_status_at),
      nextStatus === "failed" ? "DELIVERY_FAILED" : null,
      nextStatus === "failed" ? providerCode : null,
      ["delivered", "read"].includes(nextStatus) ? at : null,
      nextStatus === "read" ? at : null, question.id,
    );
    return { accepted: true };
  })();
}

export function applyQuestionAnswers(store, config) {
  let profile = store.getProfile(),
    changed = false;
  const answers = store.db
    .prepare("SELECT * FROM bot_questions WHERE answer IS NOT NULL")
    .all();
  for (const question of answers) {
    if (question.id === "PROFILE_NAME" && profile.name !== question.answer) {
      profile.name = question.answer;
      changed = true;
    }
    if (question.id === "APPLICANT_EMAIL")
      config = {
        ...config,
        applicant: { ...config.applicant, email: question.answer },
      };
    if (question.topic === "skill") {
      const { skillName } = JSON.parse(question.metadata),
        verified = /^sim$/i.test(question.answer);
      let skill = profile.skills.find((s) => s.name === skillName);
      if (!skill) {
        skill = { name: skillName, verified };
        profile.skills.push(skill);
        changed = true;
      } else if (skill.verified !== verified) {
        skill.verified = verified;
        changed = true;
      }
    }
  }
  if (changed) {
    delete profile.resumes;
    store.saveProfile(profile);
  }
  return config;
}

export async function notifyQuestions(
  db,
  config,
  { env = process.env, sender = sendQuestion, clock = Date.now, signal, limit = 5, questionId } = {},
) {
  let accepted = 0;
  // `sent` is retained for callers of v2.1. It means API acceptance only.
  const result = (extra = {}) => ({ ...getWhatsAppStatus(db), sent: accepted, acceptedThisRun: accepted, ...extra });
  if (!config.enabled || signal?.aborted) return result();
  const accessToken = env[config.accessTokenEnv];
  const personal = config.transport === "personal";
  if (
    !config.to ||
    (personal ? sender === sendQuestion : !accessToken || !config.phoneNumberId || !config.templateName)
  )
    return result({ error: "WHATSAPP_CONFIGURATION_REQUIRED" });
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify([
    config.transport || "cloud",
    config.phoneNumberId, config.to, config.templateName, config.language,
    config.apiVersion, accessToken,
  ])).digest("hex");
  // Only a meaningful configuration/token change unlocks definite failures.
  // Accepted and ambiguous requests are never blindly replayed.
  db.prepare(
    `UPDATE bot_questions SET notification_status='pending',notification_attempts=0,
     notification_next_attempt_at=0,notification_error=NULL,notification_provider_code=NULL
     WHERE answer IS NULL AND notification_status='failed'
     AND (notification_config_hash IS NULL OR notification_config_hash<>?)
     AND ((? IS NULL AND topic<>'whatsapp_test') OR id=?)`,
  ).run(fingerprint, questionId ?? null, questionId ?? null);
  const questions = db.prepare(
    `SELECT * FROM bot_questions WHERE answer IS NULL AND notification_status='pending'
     AND notification_next_attempt_at<=? AND notification_attempts<3
     AND ((? IS NULL AND topic<>'whatsapp_test') OR id=?) ORDER BY created_at,id LIMIT ?`,
  ).all(clock(), questionId ?? null, questionId ?? null, Math.max(1, Math.min(20, Number.isInteger(limit) ? limit : 5)));
  for (const question of questions) {
    if (signal?.aborted) break;
    const claimed = db.prepare(
      `UPDATE bot_questions SET notification_status='sending',notification_attempts=notification_attempts+1,
       notification_config_hash=?,notification_recipient=?,notification_phone_number_id=?,
       notification_id=NULL,notification_status_at=0,notification_delivered_at=NULL,notification_read_at=NULL
       WHERE id=? AND answer IS NULL AND notification_status='pending'`,
    ).run(fingerprint, config.to, personal ? null : config.phoneNumberId, question.id);
    if (!claimed.changes) continue;
    try {
      const receipt = await sender(question, { ...config, accessToken, signal });
      if (receipt?.verified !== true || typeof receipt.messageId !== "string" ||
          !receipt.messageId || receipt.messageId.length > 512 || /[\u0000-\u001f]/.test(receipt.messageId))
        throw new Error("INVALID_RECEIPT");
      db.prepare(
        "UPDATE bot_questions SET notification_status='accepted',notification_id=?,notification_error=NULL,notification_provider_code=NULL,notification_status_at=0 WHERE id=?",
      ).run(receipt.messageId, question.id);
      const callbacks = db.prepare(
        "SELECT * FROM whatsapp_status_events WHERE message_id=? ORDER BY timestamp",
      ).all(receipt.messageId);
      for (const callback of callbacks) recordWhatsAppStatus(db, {
        messageId: callback.message_id, status: callback.status,
        recipient: callback.recipient, phoneNumberId: callback.phone_number_id || null,
        timestamp: String(callback.timestamp / 1000), errorCode: callback.error_code,
      });
      db.prepare("DELETE FROM whatsapp_status_events WHERE message_id=?").run(receipt.messageId);
      accepted++;
    } catch (error) {
      const code = /^[A-Z_]{1,60}$/.test(error.code || "")
        ? error.code
        : "WHATSAPP_AMBIGUOUS";
      if (code === "CANCELLED" || code === "CONNECTION_REQUIRED") {
        db.prepare(
          "UPDATE bot_questions SET notification_status='pending',notification_attempts=notification_attempts-1,notification_next_attempt_at=?,notification_error=? WHERE id=?",
        ).run(code === "CONNECTION_REQUIRED" ? clock() + 60000 : 0, code === "CONNECTION_REQUIRED" ? code : null, question.id);
        break;
      }
      const attempt = question.notification_attempts + 1;
      const retry = code === "RATE_LIMIT" && attempt < 3;
      const definite = ["AUTHORIZATION", "CONFIGURATION", "REJECTED", "RATE_LIMIT"].includes(code);
      const providerCode = /^\d{1,10}$/.test(String(error.providerCode)) ? String(error.providerCode) : null;
      db.prepare(
        "UPDATE bot_questions SET notification_status=?,notification_error=?,notification_provider_code=?,notification_next_attempt_at=? WHERE id=?",
      ).run(
        retry ? "pending" : definite ? "failed" : "ambiguous", code, providerCode,
        retry ? clock() + 60000 * 2 ** (attempt - 1) : 0, question.id,
      );
    }
  }
  return result();
}

export const notifyPendingQuestions = notifyQuestions;
