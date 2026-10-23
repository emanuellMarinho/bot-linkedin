import { normalize } from "../utils.js";

const aliases = {
  JavaScript: ["javascript", "js"],
  TypeScript: ["typescript", "ts"],
  "Node.js": ["node.js", "nodejs", "node js"],
  Express: ["express", "express.js"],
  HTML: ["html", "html5"],
  CSS: ["css", "css3"],
  SQL: ["sql"],
  "REST APIs": ["rest", "restful"],
  Git: ["git"],
  GitHub: ["github"],
  PostgreSQL: ["postgresql", "postgres"],
  MySQL: ["mysql"],
  "SQL Server": ["sql server"],
  SQLite: ["sqlite"],
  jQuery: ["jquery"],
  Bootstrap: ["bootstrap"],
  "TOTVS Fluig": ["fluig"],
  BPM: ["bpm"],
  "Integrações de sistemas": ["integracoes de sistemas", "system integration"],
  Docker: ["docker"],
  Linux: ["linux"],
  Java: ["java"],
  Python: ["python"],
  "C#": ["c#"],
  ".NET": [".net", "dotnet"],
  Go: ["golang"],
  Ruby: ["ruby"],
  PHP: ["php"],
  React: ["react", "reactjs"],
  Angular: ["angular"],
  Vue: ["vue"],
  AWS: ["aws"],
  Kubernetes: ["kubernetes"],
  Rust: ["rust"],
  Kotlin: ["kotlin"],
  Swift: ["swift"],
  "Next.js": ["next.js", "nextjs"],
  NestJS: ["nestjs", "nest.js"],
  Spring: ["spring"],
  Django: ["django"],
  MongoDB: ["mongodb"],
  Redis: ["redis"],
  GraphQL: ["graphql"],
};
const matchers = Object.entries(aliases).map(([name, words]) => [
  name,
  words.map((term) => {
    const escaped = normalize(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i");
  }),
]);
export function technologies(text) {
  const normalized = normalize(text);
  return matchers
    .filter(([, patterns]) =>
      patterns.some((pattern) => pattern.test(normalized)),
    )
    .map(([name]) => name);
}
export function infer(job) {
  const title = normalize(job.title),
    text = normalize(`${job.title}\n${job.description}`);
  let seniority = null;
  if (/\b(senior|sr|staff|principal|lead|lider|head)\b/.test(title))
    seniority = "senior";
  else if (/\b(junior|jr|entry level)\b/.test(title)) seniority = "junior";
  else if (/\b(pleno|mid|mid-level|intermediate)\b/.test(title))
    seniority = "mid";
  const lines = String(job.description || "").split("\n");
  const required = [],
    desirable = [],
    mentioned = [];
  let section = "mentioned";
  for (const line of lines) {
    const n = normalize(line);
    if (/desejave|diferencia|nice.to.have|preferred|bonus/.test(n))
      section = "desirable";
    else if (
      /requisit|requirements|required|must.have|obrigatori|qualifications|necessari|what you.{0,15}(bring|need)|what we.{0,15}look|o que (buscamos|esperamos)|voce precisa/.test(
        n,
      )
    )
      section = "required";
    else if (/beneficios|benefits|responsibil|oferecemos|about us/.test(n))
      section = "mentioned";
    (section === "required"
      ? required
      : section === "desirable"
        ? desirable
        : mentioned
    ).push(...technologies(line));
  }
  return {
    seniority,
    modality: /hibrid|hybrid/.test(text)
      ? "hybrid"
      : /\b(remoto|remota|remote)\b/.test(text)
        ? "remote"
        : /presencial|on.site/.test(text)
          ? "onsite"
          : null,
    contractType: /\bclt\b/.test(text)
      ? "CLT"
      : /\bpj\b/.test(text)
        ? "PJ"
        : null,
    requiredSkills: [...new Set(required)],
    desiredSkills: [...new Set(desirable)],
    mentionedSkills: [...new Set([...mentioned, ...technologies(job.title)])],
  };
}
export function scoreJob(job, profile, settings, clock = Date.now()) {
  const derived = infer(job),
    data = {
      ...derived,
      ...Object.fromEntries(
        Object.entries(job).filter(([, v]) => v !== null && v !== undefined),
      ),
    };
  const candidateSkills = new Set(profile.skills.map((s) => normalize(s.name)));
  const required = data.requiredSkills || [],
    desired = data.desiredSkills || [],
    mentions = derived.mentionedSkills;
  const compared = required.length ? required : mentions;
  const matched = compared.filter((s) => candidateSkills.has(normalize(s))),
    gaps = required.filter((s) => !candidateSkills.has(normalize(s)));
  const reasons = [],
    unknown = [],
    exclusions = [];
  const weights = settings.weights;
  const parts = {
    technical: 0,
    seniority: 0,
    location: 0,
    recency: 0,
    contract: 0,
  };
  if (compared.length) {
    parts.technical =
      ((weights.technical * matched.length) / compared.length) *
      (required.length ? 1 : 0.65);
    reasons.push(
      `${matched.length}/${compared.length} tecnologias compatíveis ${required.length ? "nos requisitos" : "mencionadas (requisitos não identificados)"}`,
    );
    if (desired.length) {
      const bonus =
        desired.filter((s) => candidateSkills.has(normalize(s))).length /
        desired.length;
      parts.technical = Math.min(
        weights.technical,
        parts.technical + weights.technical * 0.1 * bonus,
      );
    }
  } else unknown.push("Requisitos técnicos");
  if (data.seniority) {
    parts.seniority = settings.seniorities.includes(data.seniority)
      ? weights.seniority
      : 0;
    reasons.push(`Senioridade: ${data.seniority}`);
    if (data.seniority === "senior" && settings.excludeSenior)
      exclusions.push("Senioridade fora da preferência");
  } else unknown.push("Senioridade");
  const geo = normalize(
    [data.location, data.description].filter(Boolean).join(" "),
  );
  let eligible = null;
  const country = normalize(settings.country);
  const positive =
    geo.includes(country) ||
    (["brasil", "brazil"].includes(country) &&
      /brazil|brasil|\blatam\b|latin america|america latina/.test(geo)) ||
    /worldwide|anywhere in the world|global remote|qualquer lugar do mundo/.test(
      geo,
    );
  const location = normalize(data.location);
  const restricted =
    /(?:only|apenas|somente|must (?:be|reside)|restricted to|eligible .*in).{0,35}(united states|\busa\b|\bus\b|canada|europe|uk)|(?:united states|\busa\b|\bus\b|canada|europe|uk).{0,20}(?:only|apenas)/.test(
      geo,
    ) ||
    (!/brazil|brasil|\blatam\b|latin america|worldwide|global/.test(location) &&
      /united states|\busa\b|\bus\b|canada|europe|european union|\buk\b/.test(
        location,
      ));
  if (restricted && ["brasil", "brazil"].includes(country)) {
    eligible = false;
    exclusions.push("Restrição geográfica incompatível anunciada");
  } else if (positive) eligible = true;
  if (
    eligible === true &&
    data.modality &&
    settings.modalities.includes(data.modality)
  )
    parts.location = weights.location;
  else if (eligible === false) reasons.push("Localização incompatível");
  else if (eligible === null)
    unknown.push(`Elegibilidade em ${settings.country}`);
  if (!data.modality) unknown.push("Modalidade");
  const date = job.publishedAt && Date.parse(job.publishedAt);
  if (date && date <= clock) {
    const hours = (clock - date) / 36e5;
    parts.recency =
      hours <= settings.primaryHours
        ? weights.recency
        : hours <= settings.secondaryDays * 24
          ? weights.recency * 0.5
          : 0;
    reasons.push(
      hours <= settings.primaryHours
        ? "Publicada na janela prioritária"
        : hours <= settings.secondaryDays * 24
          ? "Publicada na janela secundária"
          : "Fora da janela de recência",
    );
  } else unknown.push("Data de publicação verificável");
  if (data.contractType) {
    parts.contract = settings.contracts.includes(data.contractType)
      ? weights.contract
      : 0;
    reasons.push(`Contratação: ${data.contractType}`);
  } else unknown.push("Tipo de contratação (FullTime não comprova CLT)");
  const title = normalize(job.title);
  const keywordMatch = Object.values(settings.keywordGroups)
    .flat()
    .some((term) => title.includes(normalize(term)));
  if (
    /\b(suporte|support|sales|vendas|help.?desk)\b/.test(title) &&
    !/developer|desenvolvedor|engineer.*software/.test(title)
  )
    exclusions.push("Área fora de desenvolvimento");
  if (!keywordMatch) {
    reasons.push(
      "Cargo fora das nomenclaturas configuradas; revisar relevância",
    );
    exclusions.push(
      "Cargo fora das nomenclaturas de desenvolvimento configuradas",
    );
  }
  const rawScore = Math.round(Object.values(parts).reduce((a, b) => a + b, 0));
  return {
    score: exclusions.length ? Math.min(rawScore, 25) : rawScore,
    parts,
    reasons,
    unknown,
    gaps,
    matched,
    exclusions,
    eligible,
    keywordMatch,
    inferred: derived,
    lowCompetition:
      job.applicantCount == null
        ? null
        : job.applicantCount <= settings.maxApplicants,
    competition:
      job.applicantCount == null
        ? null
        : job.applicantCount <= 10
          ? "0-10"
          : job.applicantCount <= 25
            ? "11-25"
            : job.applicantCount <= 50
              ? "26-50"
              : "51+",
  };
}
