import { safeUrl } from "../utils.js";

const labels = {
  new: "nova", saved: "salva", reviewing: "em análise", prepared: "currículo preparado",
  started: "em preenchimento", sent: "enviada", interview: "entrevista",
  rejected: "não selecionada", offer: "proposta", archived: "arquivada",
  sending: "envio em andamento", submitted: "envio confirmado",
  failed: "envio bloqueado", rate_limited: "aguardando limite da plataforma",
  ambiguous: "envio sem confirmação — conferir na plataforma",
};
const reasons = {
  AUTHORIZATION: "a plataforma recusou a autorização",
  REJECTED: "a plataforma recusou os dados do formulário",
  MISSING_CREDENTIAL: "falta autorização da integração",
  RATE_LIMIT: "limite temporário da plataforma",
  CANCELLED: "execução interrompida antes do envio",
  INTERRUPTED: "execução interrompida; conferir resultado na plataforma",
  AMBIGUOUS: "a plataforma ainda não confirmou o resultado",
  AUTO_APPLY_DISABLED: "envio automático desativado na configuração",
  AWAITING_CANDIDATE_ANSWERS: "aguardando suas respostas pelo WhatsApp ou terminal",
  NO_AUTHORIZED_CONNECTOR: "esta plataforma ainda não tem conector de envio compatível",
  PLATFORM_AUTHORIZATION_REQUIRED: "falta autorização da integração da plataforma",
  PROVIDER_CREDENTIAL_REQUIRED: "falta a credencial do conector de envio",
  CONTACT_REQUIRED: "faltam seus dados de contato",
  ELIGIBILITY_UNCONFIRMED: "a elegibilidade para esta vaga precisa ser confirmada",
  OUTSIDE_RECENCY_WINDOW: "vaga fora da janela de publicação configurada",
  REQUIREMENTS_UNCONFIRMED: "requisitos técnicos ainda não confirmados",
  APPLICATION_LIMIT: "limite diário ou por ciclo de candidaturas atingido",
  RESUME_REQUIRED: "informe seu currículo no assistente",
  ATS_RESUME_FAILED: "não foi possível preparar o currículo ATS",
  BROWSER_UNAVAILABLE: "navegador compatível não encontrado",
  CAPTCHA_REQUIRED: "a plataforma exige uma verificação manual",
};
const clean = (value, limit = 180) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
  .replace(/\s+/g, " ").trim().slice(0, limit);
const label = (status) => labels[status] || clean(status, 80);
const stateOf = (row) => ["interview", "rejected", "offer", "archived"].includes(row.application_status)
  ? row.application_status : row.submission_status || row.application_status || row.status;
function pendingReason(db, row) {
  if (row.error_code) return row.error_code;
  try {
    const stored = db.prepare("SELECT value FROM settings WHERE key=?").get(`bot_pending:${row.id}`);
    return stored ? JSON.parse(stored.value).reason : null;
  } catch { return null; }
}
const bounded = (text) => text.length <= 3500 ? text : text.slice(0, 3460) + "\n… Use vaga ID para ver os detalhes.";
function urlOf(row) {
  try {
    const data = JSON.parse(row.data);
    return safeUrl(data.applicationUrl || data.url || row.canonical_url).toString();
  } catch {
    return "Link indisponível";
  }
}

/** Read-only, bounded view shared by the terminal and authenticated WhatsApp chat. */
export function formatTracking(storeOrDb, command = "vagas") {
  const db = storeOrDb.db || storeOrDb;
  const normalized = String(command).trim().toLowerCase();
  if (["ajuda", "help", "comandos"].includes(normalized))
    return "Comandos: vagas — oportunidades mais compatíveis; candidaturas — acompanhar envios; vaga ID — link, status e pendências. Para responder uma dúvida: ID_DA_PERGUNTA: resposta, ou use Responder na mensagem do WhatsApp. Ctrl+C encerra o terminal.";
  if (["vagas", "status", "candidaturas"].includes(normalized)) {
    const applications = normalized !== "vagas";
    const rows = db.prepare(`
      SELECT j.*, a.status AS application_status,
        s.status AS submission_status, s.error_code,
        (SELECT COUNT(*) FROM bot_questions q WHERE (q.job_id=j.id OR q.job_id IS NULL) AND q.answer IS NULL AND q.topic<>'whatsapp_test') AS questions
      FROM jobs j ${applications ? "JOIN" : "LEFT JOIN"} applications a ON a.job_id=j.id
      LEFT JOIN submission_attempts s ON s.job_id=j.id
      ORDER BY ${applications ? "a.updated_at DESC,j.id DESC" : "j.score DESC,j.id DESC"} LIMIT 10
    `).all();
    if (!rows.length)
      return applications ? "Nenhuma candidatura iniciada. Digite vagas para acompanhar as oportunidades encontradas." : "Nenhuma vaga encontrada ainda. A coleta continua durante o horário configurado.";
    const lines = [applications ? "Candidaturas recentes:" : "Vagas mais compatíveis:"];
    for (const row of rows) {
      const state = stateOf(row);
      lines.push(`#${row.id} · ${clean(row.title, 110)} — ${clean(row.company, 80)}\nCompatibilidade: ${row.score}/100 · ${label(state)}${row.questions ? ` · ${row.questions} dúvida(s) pendente(s)` : ""}`);
      const reason = pendingReason(db, row);
      if (reason) lines.push(`Pendência: ${reasons[reason] || "revisar o envio na plataforma"}.`);
    }
    lines.push("Digite vaga ID para abrir o link e ver detalhes (ex.: vaga 12).");
    return bounded(lines.join("\n\n"));
  }
  const match = normalized.match(/^vaga\s+#?(\d{1,12})$/);
  if (!match) return null;
  const row = db.prepare(`
    SELECT j.*,a.status AS application_status,a.sent_at,
      s.status AS submission_status,s.error_code,s.retry_at
    FROM jobs j LEFT JOIN applications a ON a.job_id=j.id
    LEFT JOIN submission_attempts s ON s.job_id=j.id WHERE j.id=?
  `).get(Number(match[1]));
  if (!row) return "Vaga não encontrada. Digite vagas para consultar os IDs disponíveis.";
  const questions = db.prepare(
    "SELECT id,text FROM bot_questions WHERE answer IS NULL AND (job_id=? OR (job_id IS NULL AND topic<>'whatsapp_test')) ORDER BY created_at LIMIT 5",
  ).all(row.id);
  const lines = [
    `#${row.id} · ${clean(row.title)} — ${clean(row.company)}`,
    `Compatibilidade: ${row.score}/100`,
    `Status: ${label(stateOf(row))}`,
    `Local: ${clean(row.location) || "não informado"}`,
    `Candidatura: ${urlOf(row)}`,
  ];
  if (row.sent_at) lines.push(`Envio registrado: ${clean(row.sent_at)}`);
  const reason = pendingReason(db, row);
  if (reason) lines.push(`Pendência: ${reasons[reason] || "revisar o envio na plataforma"}.`);
  if (row.retry_at) lines.push(`Nova tentativa após: ${clean(row.retry_at)}`);
  for (const question of questions)
    lines.push(`Dúvida ${clean(question.id, 120)}: ${clean(question.text, 350)}`);
  if (!row.submission_status && row.application_status !== "sent")
    lines.push("A candidatura ainda não tem confirmação de envio.");
  return bounded(lines.join("\n"));
}
