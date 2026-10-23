const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const labels = {
  new: "Nova",
  saved: "Salva",
  reviewing: "Em análise",
  prepared: "Preparada",
  started: "Candidatura iniciada",
  sent: "Candidatura enviada",
  interview: "Em entrevista",
  offer: "Proposta recebida",
  rejected: "Rejeitada",
  discarded: "Descartada",
  remote: "Remoto",
  hybrid: "Híbrido",
  onsite: "Presencial",
  junior: "Júnior",
  mid: "Pleno",
  senior: "Sênior",
  manual: "Manual",
  "linkedin-manual": "LinkedIn · manual",
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
  completed: "Concluída",
  partial: "Com erros",
  no_sources: "Sem fontes",
  running: "Em execução",
  paused: "Pausada",
  interrupted: "Interrompida",
  failed: "Falhou",
};
const label = (v) => labels[v] || v || "Não informado";
const date = (v) =>
  v
    ? new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(v))
    : "Não informada";
const button = (text, action, id, cls = "secondary small") =>
  `<button class="button ${cls}" data-action="${action}" data-id="${id}">${text}</button>`;
const badge = (text, cls = "") =>
  `<span class="tag ${cls}">${escape(text)}</span>`;
const empty = (
  title,
  message,
  link = "#import",
  cta = "Importar oportunidade",
) =>
  `<div class="empty"><span class="empty-symbol" aria-hidden="true">◎</span><h3>${title}</h3><p>${message}</p>${link ? `<a class="button secondary" href="${link}">${cta}</a>` : ""}</div>`;
const head = (eyebrow, title, subtitle, actions = "") =>
  `<div class="page-head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${subtitle}</p></div><div class="actions">${actions}</div></div>`;
const opts = (values, selected, placeholder = "Todas") =>
  `<option value="">${placeholder}</option>` +
  values
    .map(
      (v) =>
        `<option value="${escape(v)}" ${v === selected ? "selected" : ""}>${escape(label(v))}</option>`,
    )
    .join("");
let currentRoute = "",
  routeVersion = 0,
  filter = { relevance: "relevant" },
  page = 1,
  transitions = {},
  profile,
  settings,
  detailId,
  toastTimer;
async function api(url, options = {}) {
  const response = await fetch("/api" + url, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.details
        ? result.details.map((d) => `${d.field}: ${d.message}`).join(" • ")
        : result.error || "Falha na operação",
    );
  return result;
}
const send = (url, body, method = "POST") =>
  api(url, { method, body: JSON.stringify(body) });
function toast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 7000);
}
async function guarded(action, target) {
  if (target?.disabled) return;
  if (target) target.disabled = true;
  try {
    await action();
  } catch (error) {
    toast(error.message);
  } finally {
    if (target?.isConnected) target.disabled = false;
  }
}
function jobCard(job) {
  const inferred = job.matching.inferred;
  const tech = [
    ...new Set([
      ...(job.requiredSkills || inferred.requiredSkills),
      ...inferred.mentionedSkills,
    ]),
  ].slice(0, 5);
  const initials = job.company
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return `<article class="job-card"><div class="job-top"><div class="company-icon" aria-hidden="true">${escape(initials)}</div><div class="job-heading"><h3>${escape(job.title)}</h3><p class="company-name">${escape(job.company)} · ${escape(job.location || "Localização não informada")}</p></div><div class="score ${job.score < 65 ? "low" : ""}">${job.score}<small>de 100</small></div></div><div class="tags">${badge(label(job.modality || inferred.modality), (job.modality || inferred.modality) === "remote" ? "green" : "")}${badge(label(job.seniority || inferred.seniority))}${tech.map((t) => badge(t, "blue")).join("")}${job.matching.lowCompetition === true ? badge("Poucas candidaturas · contagem fornecida", "green") : ""}${job.matching.exclusions.length ? badge("Revisar incompatibilidade", "warning") : ""}${job.provenance === "demo" ? badge("DEMONSTRAÇÃO", "warning") : ""}</div><div class="job-footer"><div>${escape(label(job.sources[0]?.provider))} · ${escape(job.publishedAt ? date(job.publishedAt) : "Publicação não informada")}<br>Candidaturas: ${job.applicantCount ?? "Não informado"} · ${escape(label(job.status))}</div><div class="actions">${button("Ver detalhes", "detail", job.id)}${job.status === "new" ? button("Salvar", "save", job.id) : ""}${["new", "saved", "reviewing"].includes(job.status) ? button("Descartar", "discard", job.id) : ""}</div></div></article>`;
}
async function dashboard() {
  const [data, top, notifications] = await Promise.all([
    api("/dashboard"),
    api("/jobs?limit=4&sort=score&relevance=relevant"),
    api("/notifications"),
  ]);
  const stats = [
    ["Vagas no radar", data.total, "Oportunidades centralizadas", "⌕"],
    [
      "Alta compatibilidade",
      data.highMatch,
      `A partir de ${settings.minScore} pontos`,
      "◎",
    ],
    [
      "Aguardando candidatura",
      data.awaiting,
      "Do primeiro interesse à preparação",
      "▤",
    ],
    ["Candidaturas enviadas", data.sent, "Confirmadas por você", "↗"],
    ["Vagas novas", data.new, "Ainda não analisadas", "＋"],
    ["Vagas remotas", data.remote, "Elegibilidade exige revisão", "⌂"],
    [
      "Publicações recentes",
      data.recent,
      `Últimas ${settings.primaryHours} horas verificáveis`,
      "◷",
    ],
    ["Em entrevista", data.interviews, "Conversas em andamento", "◌"],
  ];
  const tracked = data.applications.reduce((n, a) => n + a.total, 0);
  return (
    head(
      "SEU PRÓXIMO PASSO COMEÇA AQUI",
      "Um olhar para as oportunidades.",
      "Relevância primeiro. Decisões sempre nas suas mãos.",
      `<a class="button secondary" href="#import">＋ Importar vaga</a><button class="button" data-action="collect">↻ Atualizar radar</button>`,
    ) +
    `<div class="hero"><div><div class="eyebrow">BUSCA COM DIREÇÃO</div><h2>Seu próximo trabalho merece uma boa escolha.</h2><p>Encontre oportunidades alinhadas ao seu perfil, entenda os requisitos e prepare cada candidatura com cuidado.</p></div><div class="hero-icon" aria-hidden="true">◎</div></div><div class="stats">${stats.map(([title, value, note, icon]) => `<div class="stat"><div class="stat-label">${title}<span class="stat-icon" aria-hidden="true">${icon}</span></div><strong>${value}</strong><small>${note}</small></div>`).join("")}</div><div class="metrics-note">${settings.collectionEnabled ? `Coleta programada a cada ${settings.intervalHours}h` : "Coleta pausada"} · Última execução: ${escape(date(data.lastRun?.finished_at))} · Nenhum envio automático</div><div class="dashboard-grid"><div><section class="panel"><div class="panel-head"><h2>Oportunidades em destaque</h2><a href="#jobs">Explorar todas ↗</a></div><div class="job-list">${top.items.length ? top.items.map(jobCard).join("") : empty("Seu radar está pronto para começar", "Adicione um quadro público ou importe uma vaga que chamou sua atenção.")}</div></section><section class="panel"><div class="panel-head"><h2>Seu progresso</h2><a href="#applications">Acompanhar ↗</a></div>${tracked ? data.applications.map((a) => `<div class="progress-row"><span>${escape(label(a.status))}</span><progress class="bar" max="${tracked}" value="${a.total}" aria-label="${escape(label(a.status))}"></progress><b>${a.total}</b></div>`).join("") : '<p class="muted">Suas candidaturas aparecerão aqui assim que você salvar ou analisar uma vaga.</p>'}</section></div><div class="dashboard-secondary"><section class="panel"><div class="panel-head"><h2>Fontes monitoradas</h2><a href="#settings">Gerenciar ↗</a></div>${data.sources.length ? data.sources.map((s) => `<div class="source-row"><strong><span class="dot"></span>${escape(s.company)}</strong><span class="muted">${escape(label(s.provider))} / ${escape(s.board)} · ${s.enabled ? "Ativa" : "Pausada"}</span><small>Verificação: ${escape(date(s.last_checked))}</small>${s.last_error ? `<small class="inline-error">${escape(s.last_error)}</small>` : ""}</div>`).join("") : empty("Nenhuma fonte configurada", "Escolha os quadros de empresas que deseja acompanhar.", "#settings", "Configurar fontes")}</section><section class="panel"><div class="panel-head"><h2>Atividade do radar</h2><button class="button secondary small" data-action="read-notifications">Marcar lidas</button></div>${
      notifications.length
        ? notifications
            .slice(0, 8)
            .map(
              (n) =>
                `<div class="notification ${n.read ? "" : "unread"}">${escape(n.message)}<small>${escape(date(n.created_at))}</small></div>`,
            )
            .join("")
        : '<p class="muted">Novas vagas compatíveis, mudanças de status e avisos das fontes aparecerão aqui.</p>'
    }</section></div></div>`
  );
}
async function jobs() {
  const query = new URLSearchParams({ ...filter, page, limit: 20 });
  const result = await api("/jobs?" + query);
  return (
    head(
      "OPORTUNIDADES",
      "Explore com intenção.",
      "Use os filtros para encontrar vagas que fazem sentido para você.",
      '<a class="button secondary" href="#import">＋ Importar vaga</a>',
    ) +
    `<form id="filter-form" class="panel"><div class="filters"><label class="wide">Buscar cargo, empresa ou palavra<input name="q" placeholder="Ex.: Node.js, Fluig, desenvolvimento…" value="${escape(filter.q)}"></label><label>Área e compatibilidade<select name="relevance"><option value="relevant" ${filter.relevance === "relevant" ? "selected" : ""}>Dentro dos critérios</option><option value="all" ${filter.relevance === "all" ? "selected" : ""}>Todas as coletadas</option><option value="excluded" ${filter.relevance === "excluded" ? "selected" : ""}>Incompatíveis sinalizadas</option></select></label><label>Empresa<input name="company" value="${escape(filter.company)}" placeholder="Nome da empresa"></label><label>Tecnologia<input name="technology" value="${escape(filter.technology)}" placeholder="Ex.: TypeScript"></label><label>Senioridade<select name="seniority">${opts(["junior", "mid", "senior"], filter.seniority)}</select></label><label>Modalidade<select name="modality">${opts(["remote", "hybrid", "onsite"], filter.modality)}</select></label><label>Fonte<select name="source">${opts(["greenhouse", "lever", "ashby", "manual", "linkedin-manual"], filter.source)}</select></label><label>Contratação<input name="contract" placeholder="CLT, PJ…" value="${escape(filter.contract)}"></label><label>Publicação<select name="hours">${opts(["24", "168", "720"], filter.hours, "Qualquer data").replace(">24<", ">Últimas 24 horas<").replace(">168<", ">Últimos 7 dias<").replace(">720<", ">Últimos 30 dias<")}</select></label><label>Pontuação mínima<input type="number" name="minScore" min="0" max="100" value="${escape(filter.minScore)}" placeholder="0 a 100"></label><label>Candidaturas conhecidas<select name="competition">${opts(["0-10", "11-25", "26-50", "51+", "unknown"], filter.competition).replace(">unknown<", ">Não informado<")}</select></label><label>Ordenar por<select name="sort">${["score", "date", "competition"].map((v, i) => `<option value="${v}" ${v === (filter.sort || "score") ? "selected" : ""}>${["Relevância", "Publicação recente", "Menor concorrência conhecida"][i]}</option>`).join("")}</select></label></div><div class="actions form-section"><label class="check-label"><input type="checkbox" name="eligibleOnly" ${filter.eligibleOnly === "true" ? "checked" : ""}>Somente elegibilidade identificada</label><button class="button" type="submit">Aplicar filtros</button><button class="button secondary" type="button" data-action="clear-filters">Limpar</button></div></form><div class="result-head"><span>${result.total} oportunidade${result.total === 1 ? "" : "s"} · Página ${result.page}</span><span>Dados atualizados pelas fontes</span></div><div class="jobs-grid">${result.items.length ? result.items.map(jobCard).join("") : empty("Nenhuma vaga nesta busca", "Ajuste os filtros, configure uma fonte ou importe uma oportunidade.")}</div><div class="pagination">${page > 1 ? button("← Anterior", "previous-page", "") : ""}${result.total > page * 20 ? button("Próxima →", "next-page", "") : ""}</div>`
  );
}
function importPage() {
  return (
    head(
      "NOVA OPORTUNIDADE",
      "Adicione ao seu radar.",
      "Cole os dados de uma vaga ou importe o conteúdo de um alerta de e-mail.",
    ) +
    `<div class="notice">Nenhuma página do LinkedIn será consultada. Informe somente dados que você pode verificar; campos desconhecidos devem ficar vazios.</div><form id="import-form" class="panel"><h2>Importação manual</h2><div class="form-grid"><label class="full">Link original *<input type="url" name="url" required placeholder="https://www.linkedin.com/jobs/view/…"></label><label>Cargo *<input name="title" required maxlength="200"></label><label>Empresa *<input name="company" required maxlength="200"></label><label class="full">Descrição completa<textarea name="description" rows="7" maxlength="150000" placeholder="Cole a descrição e preserve os títulos Requisitos e Diferenciais, quando existirem."></textarea></label><label>Localização / restrições geográficas<input name="location" placeholder="Somente o que foi anunciado"></label><label>Modalidade<select name="modality">${opts(["remote", "hybrid", "onsite"], "", "Não informada")}</select></label><label>Senioridade<select name="seniority">${opts(["junior", "mid", "senior"], "", "Não informada")}</select></label><label>Contratação<input name="contractType" placeholder="CLT, PJ (se explícito)"></label><label>Tecnologias obrigatórias<input name="requiredSkills" placeholder="Separadas por vírgula; deixe vazio se desconhecidas"></label><label>Tecnologias desejáveis<input name="desiredSkills" placeholder="Separadas por vírgula"></label><label>Publicação verificada<input type="datetime-local" name="publishedAt"></label><label>Evidência da data<input name="publicationEvidence" placeholder="Ex.: data exibida no anúncio original"></label><label>Candidaturas verificadas<input type="number" name="applicantCount" min="0" max="1000000" placeholder="Não informado"></label><label>Evidência da contagem<input name="applicantEvidence" placeholder="Ex.: contagem vista no anúncio em DD/MM"></label><label>Faixa salarial informada<input name="salary"></label><label>Link de candidatura (opcional)<input type="url" name="applicationUrl"></label></div><div class="form-section actions"><button class="button" type="submit">Importar e analisar</button><span class="form-help">Nenhuma candidatura será enviada.</span></div></form><section class="panel"><h2>Importar alerta de e-mail</h2><p class="muted">Use o texto ou um arquivo .eml recebido por você. Os links encontrados exigem revisão antes da importação.</p><form id="alert-form"><label>Conteúdo do alerta<textarea name="text" rows="5"></textarea></label><label>Ou arquivo .eml<input type="file" name="file" accept=".eml,message/rfc822"></label><button class="button secondary" type="submit">Ler conteúdo fornecido</button></form><div id="alert-result"></div></section>`
  );
}
async function applications() {
  const apps = await api("/applications");
  return (
    head(
      "ACOMPANHAMENTO",
      "Cada candidatura, um próximo passo.",
      "Abertura de link e envio confirmado são registrados separadamente.",
    ) +
    `<div class="panel"><div class="tags">${Object.keys(transitions)
      .map((s) =>
        badge(
          `${label(s)} · ${apps.filter((a) => a.status === s).length}`,
          ["prepared", "sent", "interview"].includes(s) ? "green" : "",
        ),
      )
      .join("")}</div></div>` +
    (apps.length
      ? apps
          .map(
            (a) =>
              `<article class="application-row"><div><h3>${escape(a.job.title)}</h3><p>${escape(a.job.company)} · Atualizada em ${escape(date(a.updated_at))}</p>${a.sent_at ? `<small>Envio confirmado em ${escape(date(a.sent_at))}</small>` : ""}</div><div class="actions">${badge(label(a.status), "green")}${button("Acompanhar", "detail", a.job_id)}</div></article>`,
          )
          .join("")
      : empty(
          "Sua jornada começa com uma oportunidade",
          "Salve uma vaga ou prepare sua primeira candidatura.",
          "#jobs",
          "Explorar vagas",
        ))
  );
}
const experienceRow = (e = {}) =>
  `<div class="experience"><label>Empresa<input data-field="company" value="${escape(e.company)}" required></label><label>Cargo<input data-field="role" value="${escape(e.role)}" required></label><label>Período<input data-field="period" value="${escape(e.period)}"></label><button class="button danger small" type="button" data-action="remove-experience" aria-label="Remover experiência">×</button><textarea data-field="description" aria-label="Descrição da experiência" placeholder="Descreva atividades e resultados verificáveis.">${escape(e.description)}</textarea></div>`;
function profilePage() {
  return (
    head(
      "MEU PERFIL",
      "Sua experiência, com clareza.",
      "Mantenha um perfil fiel ao seu trabalho. Você controla o que entra nas respostas.",
    ) +
    `<form id="profile-form" class="panel"><div class="form-grid"><label>Nome profissional<input name="name" value="${escape(profile.name)}" maxlength="150"></label><label>Senioridade declarada<select name="seniority">${opts(["junior", "mid", "senior"], profile.seniority, "Não informada")}</select></label><label class="full">Resumo profissional<textarea name="summary" rows="5">${escape(profile.summary)}</textarea></label><label class="full">Links profissionais (um por linha)<textarea name="professionalLinks" rows="2">${escape(profile.professionalLinks.join("\n"))}</textarea></label><label class="full">Informações adicionais de candidatura<textarea name="additional">${escape(profile.additional)}</textarea></label></div><section class="form-section"><h3>Habilidades e critérios de busca</h3><p class="form-help">Marque apenas habilidades que você declara possuir e consegue sustentar. As demais orientam a busca, mas não serão afirmadas pelo assistente.</p><div class="skills-list">${profile.skills.map((s) => `<span class="skill-entry"><label class="check-label"><input type="checkbox" data-skill="${escape(s.name)}" ${s.verified ? "checked" : ""}>${escape(s.name)}</label><button type="button" class="icon-button" data-action="remove-skill" aria-label="Remover habilidade ${escape(s.name)}">×</button></span>`).join("")}</div><label>Adicionar habilidades (separadas por vírgula)<input name="newSkills" placeholder="Novas habilidades serão adicionadas sem confirmação"></label></section><section class="form-section"><h3>Experiências profissionais</h3><div id="experiences">${profile.experiences.map(experienceRow).join("")}</div><button class="button secondary" type="button" data-action="add-experience">＋ Adicionar experiência</button></section><button class="button" type="submit">Salvar perfil e recalcular compatibilidade</button></form><section class="panel"><h2>Versões do currículo</h2><p class="muted">PDF ou TXT, até 2 MB. Armazenamento privado, fora da pasta pública do servidor.</p><form id="resume-form" class="actions"><label>Arquivo do currículo<input type="file" name="file" accept=".pdf,.txt" required></label><button class="button secondary" type="submit">Adicionar versão</button></form><div class="form-section">${profile.resumes.map((r) => `<div class="source-row"><a href="/api/resumes/${r.id}/download">↓ ${escape(r.name)}</a><small>${escape(date(r.created_at))}</small></div>`).join("") || '<p class="muted">Nenhum currículo adicionado.</p>'}</div></section>`
  );
}
function checkList(name, values, selected) {
  return `<div class="skills-list">${values.map((v) => `<label class="check-label"><input type="checkbox" name="${name}" value="${v}" ${selected.includes(v) ? "checked" : ""}>${escape(label(v))}</label>`).join("")}</div>`;
}
async function settingsPage() {
  const [sources, history] = await Promise.all([
    api("/sources"),
    api("/collection/history"),
  ]);
  return (
    head(
      "CONFIGURAÇÕES",
      "Um radar do seu jeito.",
      "Ajuste fontes, preferências e critérios. Sem credenciais no MVP.",
    ) +
    `<section class="panel"><div class="panel-head"><h2>Quadros públicos de empresas</h2><button class="button secondary small" data-action="collect">↻ Coletar agora</button></div><p class="form-help">Informe o identificador do quadro, não uma URL. Exemplos de formato: boards.greenhouse.io/<b>empresa</b>, jobs.lever.co/<b>empresa</b>, jobs.ashbyhq.com/<b>empresa</b>.</p>${sources.map((s) => `<div class="source-row"><div class="actions"><strong>${escape(s.company)} · ${escape(label(s.provider))}/${escape(s.board)}</strong><button class="button secondary small" data-action="toggle-source" data-id="${s.id}" data-enabled="${!s.enabled}">${s.enabled ? "Pausar fonte" : "Ativar fonte"}</button></div><small>Última verificação: ${escape(date(s.last_checked))} · Último sucesso: ${escape(date(s.last_success))}</small>${s.last_error ? `<div class="notice error">${escape(s.last_error)}</div>` : ""}</div>`).join("")}<form id="source-form" class="source-form form-section"><label>Provedor<select name="provider" required>${["greenhouse", "lever", "ashby"].map((v) => `<option value="${v}">${label(v)}</option>`).join("")}</select></label><label>Identificador do quadro<input name="board" pattern="[a-zA-Z0-9](?:[a-zA-Z0-9_]|-)*" required placeholder="empresa"></label><label>Nome da empresa<input name="company" required></label><button class="button" type="submit">Adicionar fonte</button></form></section><form id="settings-form" class="panel"><h2>Preferências e pontuação</h2><div class="form-grid"><label>País de residência<input name="country" value="${escape(settings.country)}" required></label><label>Contratações preferidas (vírgulas)<input name="contracts" value="${escape(settings.contracts.join(", "))}" required></label><fieldset><legend>Modalidades preferidas</legend>${checkList("modalities", ["remote", "hybrid", "onsite"], settings.modalities)}</fieldset><fieldset><legend>Senioridades preferidas</legend>${checkList("seniorities", ["junior", "mid", "senior"], settings.seniorities)}</fieldset><label>Janela prioritária (horas)<input type="number" name="primaryHours" value="${settings.primaryHours}" min="1" max="168" required></label><label>Janela secundária (dias)<input type="number" name="secondaryDays" value="${settings.secondaryDays}" min="1" max="60" required></label><label>Compatibilidade mínima para alertas<input type="number" name="minScore" value="${settings.minScore}" min="0" max="100" required></label><label>Preferência de candidaturas conhecidas<input type="number" name="maxApplicants" value="${settings.maxApplicants}" min="0" required></label><label>Frequência de coleta<select name="intervalHours">${[1, 2, 3, 4, 6, 8, 12, 24].map((h) => `<option value="${h}" ${h === settings.intervalHours ? "selected" : ""}>A cada ${h} hora${h > 1 ? "s" : ""}</option>`).join("")}</select></label><div><label class="check-label"><input type="checkbox" name="collectionEnabled" ${settings.collectionEnabled ? "checked" : ""}>Coleta automática e manual ativa</label><label class="check-label"><input type="checkbox" name="notificationsEnabled" ${settings.notificationsEnabled ? "checked" : ""}>Notificações internas</label><label class="check-label"><input type="checkbox" name="excludeSenior" ${settings.excludeSenior ? "checked" : ""}>Sinalizar vagas sênior incompatíveis</label></div></div><section class="form-section"><h3>Pesos (total obrigatório: 100)</h3><div class="filters">${Object.entries(
      settings.weights,
    )
      .map(
        ([key, value]) =>
          `<label>${{ technical: "Técnica", seniority: "Senioridade", location: "Modalidade e localização", recency: "Recência", contract: "Contratação" }[key]}<input type="number" data-weight="${key}" value="${value}" min="0" max="100" required></label>`,
      )
      .join(
        "",
      )}</div></section><section class="form-section"><h3>Nomenclaturas pesquisadas</h3><p class="form-help">Um termo por linha. Correspondência em português e inglês, sem distinção de acentos ou caixa.</p><div class="form-grid">${Object.entries(
      settings.keywordGroups,
    )
      .map(
        ([group, terms]) =>
          `<label>${escape(group)}<textarea data-keyword-group="${escape(group)}" rows="6">${escape(terms.join("\n"))}</textarea></label>`,
      )
      .join(
        "",
      )}</div></section><button class="button" type="submit">Salvar configurações e recalcular</button></form><section class="panel"><h2>Histórico de coletas</h2>${history.length ? history.map((h) => `<div class="history-row"><strong>${escape(date(h.started_at))} · ${escape(label(h.status))}</strong><p>${h.received} recebidas · ${h.inserted} novas · ${h.duplicates} já conhecidas · ${h.duration_ms ?? 0} ms</p>${h.errors.map((e) => `<p class="inline-error">${escape(e.provider)}: ${escape(e.message)}</p>`).join("")}</div>`).join("") : '<p class="muted">Nenhuma execução registrada.</p>'}</section>`
  );
}
async function render() {
  const version = ++routeVersion;
  currentRoute = location.hash.slice(1).split("?")[0] || "dashboard";
  $$("[data-nav]").forEach((a) => {
    a.classList.toggle("active", a.dataset.nav === currentRoute);
    if (a.dataset.nav === currentRoute) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $("#main").innerHTML =
    '<div class="loader" role="status"><div class="loading-ring"></div>Atualizando seu radar…</div>';
  try {
    [profile, settings, transitions] = await Promise.all([
      api("/profile"),
      api("/settings"),
      api("/transitions"),
    ]);
    const views = {
      dashboard,
      jobs,
      applications,
      import: importPage,
      profile: profilePage,
      settings: settingsPage,
    };
    const html = await (views[currentRoute] || dashboard)();
    if (version === routeVersion) $("#main").innerHTML = html;
  } catch (error) {
    if (version === routeVersion)
      $("#main").innerHTML =
        `<div class="notice error">${escape(error.message)}</div><button class="button" data-action="retry">Tentar novamente</button>`;
  }
}
async function showDetail(id) {
  detailId = id;
  const job = await api(`/jobs/${id}`),
    m = job.matching,
    a = job.application;
  const next = a ? transitions[a.status] : [];
  $("#detail-content").innerHTML =
    `<div class="eyebrow">${escape(job.company)} · ${escape(label(job.sources[0]?.provider))}</div><h2 id="detail-title">${escape(job.title)}</h2><p class="muted">${escape(job.location || "Localização não informada")}</p><div class="tags">${badge(`${job.score}/100 de compatibilidade`, "green")}${badge(label(job.status))}${badge(label(job.modality || m.inferred.modality))}${badge(m.eligible === true ? "Elegibilidade identificada" : m.eligible === false ? "Restrição geográfica" : "Elegibilidade não informada", m.eligible === false ? "warning" : "")}</div><div class="notice">Publicação: ${escape(date(job.publishedAt))} · Atualização da fonte: ${escape(date(job.updatedAt))}<br>Coleta: ${escape(date(job.collectedAt))} · Candidaturas: ${job.applicantCount ?? "Não informado"}<br>Contratação: ${escape(job.contractType || m.inferred.contractType || "Não informada")} · Salário: ${escape(job.salary || "Não informado")}</div><div class="actions"><a class="button secondary" href="${escape(job.url)}" target="_blank" rel="noopener noreferrer">Ver anúncio original ↗</a><a class="button" href="${escape(job.applicationUrl)}" target="_blank" rel="noopener noreferrer">Abrir formulário original ↗</a>${["new", "saved", "reviewing", "prepared"].includes(job.status) ? button(a?.preparation ? "Atualizar preparação" : "Preparar candidatura", "prepare", job.id, "") : ""}</div><div class="detail-grid form-section"><section><h3>Por que esta pontuação?</h3><ul>${m.reasons.map((r) => `<li>${escape(r)}</li>`).join("")}</ul>${m.exclusions.map((r) => `<div class="notice error">${escape(r)}</div>`).join("")}<p>Partes: técnica ${m.parts.technical.toFixed(1)}, senioridade ${m.parts.seniority}, localização ${m.parts.location}, recência ${m.parts.recency}, contratação ${m.parts.contract}.</p></section><section><h3>Lacunas e informações ausentes</h3><p>Requisitos sem compatibilidade: ${escape(m.gaps.join(", ") || "Nenhum identificado; verifique o anúncio")}</p><p>Informações não disponíveis: ${escape(m.unknown.join("; ") || "Nenhuma identificada")}</p><p>Obrigatórias: ${escape((job.requiredSkills || m.inferred.requiredSkills).join(", ") || "Não identificadas")}</p><p>Desejáveis: ${escape((job.desiredSkills || m.inferred.desiredSkills).join(", ") || "Não identificadas")}</p><p>Mencionadas: ${escape(m.inferred.mentionedSkills.join(", ") || "Não identificadas")}</p><p>Tecnologias e senioridade extraídas do texto são inferências para revisão.</p></section></div><section><h3>Descrição da oportunidade</h3><div class="detail-description">${escape(job.description || "Descrição não fornecida.")}</div></section>${a?.preparation ? `<section class="form-section"><h3>Preparação da candidatura</h3><div class="notice">${escape(a.preparation.warning)}</div><p class="preparation">${escape(a.preparation.summary)}</p><p class="muted">Pontos fortes declarados: ${escape(a.preparation.strengths.join(", ") || "Nenhum requisito confirmado no perfil")}</p><p class="muted">Lacunas a revisar: ${escape(a.preparation.gaps.join(", ") || "Nenhuma identificada")}</p>${a.preparation.answers.map((answer) => `<div class="answer"><strong>${escape(answer.question)}</strong><p>${escape(answer.answer)}</p></div>`).join("")}${a.preparation.additional ? `<div class="answer"><strong>Informações adicionais declaradas</strong><p>${escape(a.preparation.additional)}</p></div>` : ""}${button("Copiar resumo", "copy-preparation", a.id)}</section>` : ""}<section class="form-section"><h3>Acompanhamento e histórico</h3>${
      a
        ? `<form id="application-form" data-id="${a.id}"><label>Versão do currículo<select name="resumeId"><option value="">Nenhuma selecionada</option>${profile.resumes.map((r) => `<option value="${r.id}" ${r.id === a.resume_id ? "selected" : ""}>${escape(r.name)}</option>`).join("")}</select></label><label>Anotações<textarea name="notes">${escape(a.notes)}</textarea></label><button class="button secondary small" type="submit">Salvar anotações e currículo</button></form><div class="actions form-section">${next
            .filter((s) => s !== "sent")
            .map(
              (s) =>
                `<button class="button secondary small" data-action="transition" data-id="${a.id}" data-status="${s}">${escape(label(s))}</button>`,
            )
            .join(
              "",
            )}</div>${next.includes("sent") ? `<div class="confirmation"><label class="check-label"><input type="checkbox" id="confirm-sent">Confirmo que enviei esta candidatura na plataforma original.</label><button class="button" data-action="confirm-sent" data-id="${a.id}">Registrar envio confirmado</button></div>` : ""}<div class="form-section">${a.events.map((e) => `<div class="event">${escape(label(e.to_status))} · ${escape(e.note)}<small>${escape(date(e.created_at))}</small></div>`).join("")}</div>`
        : button("Iniciar acompanhamento", "track", job.id)
    }<p class="form-help">Abrir o formulário não altera o status para enviada.</p></section><section class="form-section"><h3>Referências de origem</h3>${job.sources.map((s) => `<div class="source-row"><a href="${escape(s.url)}" target="_blank" rel="noopener noreferrer">${escape(label(s.provider))} / ${escape(s.board || "importação")} ↗</a><small>ID original: ${escape(s.originalId || "Não informado")}</small></div>`).join("")}</section>`;
  if (!$("#detail-dialog").open) $("#detail-dialog").showModal();
}
const split = (value) =>
  String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
document.addEventListener("submit", (event) => {
  const form = event.target;
  event.preventDefault();
  guarded(
    async () => {
      const data = new FormData(form),
        fields = Object.fromEntries(data);
      if (form.id === "import-form") {
        const body = { ...fields };
        for (const key of [
          "modality",
          "seniority",
          "location",
          "contractType",
          "salary",
          "applicationUrl",
          "publicationEvidence",
          "applicantEvidence",
        ])
          body[key] ||= null;
        body.publishedAt = fields.publishedAt
          ? new Date(fields.publishedAt).toISOString()
          : null;
        body.applicantCount =
          fields.applicantCount === "" ? null : Number(fields.applicantCount);
        body.requiredSkills = fields.requiredSkills
          ? split(fields.requiredSkills)
          : null;
        body.desiredSkills = fields.desiredSkills
          ? split(fields.desiredSkills)
          : null;
        const result = await send("/jobs/import", body);
        toast(
          result.inserted
            ? "Vaga importada e classificada."
            : "Vaga já conhecida. Referência preservada.",
        );
        form.reset();
        await showDetail(result.job.id);
      } else if (form.id === "filter-form") {
        filter = Object.fromEntries(
          [...data.entries()].filter(([, value]) => value !== ""),
        );
        if (fields.eligibleOnly) filter.eligibleOnly = "true";
        page = 1;
        await render();
      } else if (form.id === "profile-form") {
        const skills = $$("[data-skill]", form).map((input) => ({
          name: input.dataset.skill,
          verified: input.checked,
        }));
        for (const name of split(fields.newSkills))
          if (!skills.some((s) => s.name.toLowerCase() === name.toLowerCase()))
            skills.push({ name, verified: false });
        const experiences = $$(".experience", form).map((row) =>
          Object.fromEntries(
            $$("[data-field]", row).map((input) => [
              input.dataset.field,
              input.value,
            ]),
          ),
        );
        await send(
          "/profile",
          {
            name: fields.name,
            summary: fields.summary,
            seniority: fields.seniority || null,
            additional: fields.additional,
            professionalLinks: fields.professionalLinks
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
            skills,
            experiences,
          },
          "PUT",
        );
        toast("Perfil salvo. Compatibilidade recalculada.");
        await render();
      } else if (form.id === "settings-form") {
        const body = { ...settings };
        for (const key of ["country"]) body[key] = fields[key];
        body.contracts = split(fields.contracts);
        body.modalities = data.getAll("modalities");
        body.seniorities = data.getAll("seniorities");
        for (const key of [
          "minScore",
          "primaryHours",
          "secondaryDays",
          "maxApplicants",
          "intervalHours",
        ])
          body[key] = Number(fields[key]);
        for (const key of [
          "collectionEnabled",
          "notificationsEnabled",
          "excludeSenior",
        ])
          body[key] = data.has(key);
        body.weights = Object.fromEntries(
          $$("[data-weight]", form).map((i) => [
            i.dataset.weight,
            Number(i.value),
          ]),
        );
        body.keywordGroups = Object.fromEntries(
          $$("[data-keyword-group]", form).map((i) => [
            i.dataset.keywordGroup,
            i.value
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          ]),
        );
        await send("/settings", body, "PUT");
        toast("Configurações salvas. Agendamento atualizado.");
        await render();
      } else if (form.id === "source-form") {
        await send("/sources", { ...fields, enabled: true });
        toast("Fonte adicionada. Execute a coleta para validar o quadro.");
        await render();
      } else if (form.id === "resume-form") {
        await api("/resumes", { method: "POST", body: data });
        toast("Currículo salvo em armazenamento privado.");
        await render();
      } else if (form.id === "application-form") {
        await send(
          `/applications/${form.dataset.id}`,
          {
            notes: fields.notes,
            resumeId: fields.resumeId ? Number(fields.resumeId) : null,
          },
          "PATCH",
        );
        toast("Anotações e currículo salvos.");
        await showDetail(detailId);
      } else if (form.id === "alert-form") {
        const file = data.get("file");
        const result = file?.size
          ? await api("/alerts/parse", { method: "POST", body: data })
          : await send("/alerts/parse", { text: fields.text });
        $("#alert-result").innerHTML =
          `<div class="notice">${escape(result.notice)}</div><ul class="link-list">${result.links.map((url) => `<li><button class="button secondary small" type="button" data-action="use-alert-link" data-url="${escape(url)}">Usar ${escape(url)}</button></li>`).join("")}</ul><label>Texto para revisão<textarea id="alert-text" rows="8" readonly>${escape(result.text)}</textarea></label>${!result.links.length ? '<p class="muted">Nenhum link direto de vaga do LinkedIn encontrado. Você pode copiar as informações para o formulário manual.</p>' : ""}`;
      }
    },
    $('button[type="submit"]', form),
  );
});
document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action,
    id = Number(target.dataset.id);
  guarded(async () => {
    if (action === "detail") await showDetail(id);
    else if (action === "save" || action === "discard") {
      await send(
        `/jobs/${id}`,
        { status: action === "save" ? "saved" : "discarded" },
        "PATCH",
      );
      toast(action === "save" ? "Vaga salva." : "Vaga descartada.");
      await render();
    } else if (action === "collect") {
      target.textContent = "Consultando fontes…";
      const result = await send("/collection/run", {});
      toast(
        `${result.inserted} vagas novas; ${JSON.parse(result.errors).length} fontes com erros. Consulte o histórico.`,
      );
      await render();
    } else if (action === "read-notifications") {
      await send("/notifications/read", {});
      await render();
    } else if (action === "clear-filters") {
      filter = { relevance: "relevant" };
      page = 1;
      await render();
    } else if (action === "next-page" || action === "previous-page") {
      page += action === "next-page" ? 1 : -1;
      await render();
    } else if (action === "add-experience")
      $("#experiences").insertAdjacentHTML("beforeend", experienceRow());
    else if (action === "remove-skill") target.closest(".skill-entry").remove();
    else if (action === "remove-experience")
      target.closest(".experience").remove();
    else if (action === "toggle-source") {
      await send(
        `/sources/${id}`,
        { enabled: target.dataset.enabled === "true" },
        "PATCH",
      );
      await render();
    } else if (action === "prepare") {
      await send(`/jobs/${id}/prepare`, {});
      toast("Rascunho preparado com os fatos declarados no perfil.");
      await showDetail(id);
    } else if (action === "track") {
      await send("/applications", { jobId: id });
      await showDetail(detailId);
    } else if (action === "transition") {
      await send(
        `/applications/${id}`,
        { status: target.dataset.status },
        "PATCH",
      );
      await showDetail(detailId);
    } else if (action === "confirm-sent") {
      if (!$("#confirm-sent").checked)
        throw new Error(
          "Marque a confirmação de envio na plataforma original.",
        );
      await send(
        `/applications/${id}`,
        { status: "sent", confirmedSent: true },
        "PATCH",
      );
      toast("Envio confirmado registrado.");
      await showDetail(detailId);
    } else if (action === "copy-preparation") {
      const apps = await api("/applications");
      await navigator.clipboard.writeText(
        apps.find((a) => a.id === id).preparation.summary,
      );
      toast("Resumo copiado. Revise antes de usar.");
    } else if (action === "use-alert-link") {
      const form = $("#import-form");
      form.elements.url.value = target.dataset.url;
      form.elements.description.value = $("#alert-text").value;
      form.scrollIntoView({ behavior: "smooth" });
      form.elements.title.focus();
    } else if (action === "retry") await render();
  }, target);
});
$("#close-dialog").addEventListener("click", () => $("#detail-dialog").close());
$("#detail-dialog").addEventListener("close", () => render());
$("#detail-dialog").addEventListener("click", (event) => {
  if (event.target === $("#detail-dialog")) {
    const r = event.target.getBoundingClientRect();
    if (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    )
      event.target.close();
  }
});
if (localStorage.getItem("radar-theme") === "light")
  document.body.classList.add("light");
$("#theme-button").addEventListener("click", () => {
  document.body.classList.toggle("light");
  localStorage.setItem(
    "radar-theme",
    document.body.classList.contains("light") ? "light" : "dark",
  );
});
window.addEventListener("hashchange", () => {
  if ($("#detail-dialog").open) $("#detail-dialog").close();
  render();
});
render();
