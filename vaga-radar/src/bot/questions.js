import { z } from "zod";
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

export const acceptWhatsAppAnswer = acceptCandidateAnswer;

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
  { env = process.env, sender = sendQuestion } = {},
) {
  if (!config.enabled)
    return {
      sent: 0,
      pending: db
        .prepare("SELECT COUNT(*) AS n FROM bot_questions WHERE answer IS NULL")
        .get().n,
    };
  const questions = db
    .prepare(
      "SELECT * FROM bot_questions WHERE answer IS NULL AND notification_status='pending' ORDER BY created_at LIMIT 5",
    )
    .all();
  const accessToken = env[config.accessTokenEnv];
  if (
    !accessToken ||
    !config.phoneNumberId ||
    !config.to ||
    !config.templateName
  )
    return {
      sent: 0,
      pending: questions.length,
      error: "WHATSAPP_CONFIGURATION_REQUIRED",
    };
  let sent = 0;
  for (const question of questions) {
    db.prepare(
      "UPDATE bot_questions SET notification_status='sending' WHERE id=? AND notification_status='pending'",
    ).run(question.id);
    try {
      const receipt = await sender(question, { ...config, accessToken });
      if (receipt?.verified !== true || !receipt.messageId)
        throw new Error("INVALID_RECEIPT");
      db.prepare(
        "UPDATE bot_questions SET notification_status='sent',notification_id=?,notification_error=NULL WHERE id=?",
      ).run(receipt.messageId, question.id);
      sent++;
    } catch (error) {
      const code = /^[A-Z_]+$/.test(error.code || "")
        ? error.code
        : "WHATSAPP_AMBIGUOUS";
      db.prepare(
        "UPDATE bot_questions SET notification_status='ambiguous',notification_error=? WHERE id=?",
      ).run(code, question.id);
    }
  }
  return {
    sent,
    pending: db
      .prepare("SELECT COUNT(*) AS n FROM bot_questions WHERE answer IS NULL")
      .get().n,
  };
}
