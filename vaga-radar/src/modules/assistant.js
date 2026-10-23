import { normalize, now, HttpError } from "../utils.js";

// Interface substituível; o MVP usa exclusivamente dados estruturados e templates locais.
export class TemplateAssistantProvider {
  prepare(job, profile) {
    const verified = profile.skills
      .filter((s) => s.verified)
      .map((s) => s.name);
    const needs = job.requiredSkills ?? job.matching.inferred.requiredSkills;
    const strengths = needs.filter((s) =>
      verified.some((v) => normalize(v) === normalize(s)),
    );
    const gaps = needs.filter((s) => !strengths.includes(s));
    return {
      provider: "local-template",
      generatedAt: now(),
      strengths,
      gaps,
      summary: [
        profile.name ? `Sou ${profile.name}.` : "",
        profile.summary,
        strengths.length
          ? `Tecnologias declaradas por mim e alinhadas aos requisitos: ${strengths.join(", ")}.`
          : "Revise e complete seu perfil com experiências verificáveis antes de enviar.",
      ]
        .filter(Boolean)
        .join(" "),
      answers: [
        {
          question: "Conte sobre sua experiência.",
          answer:
            [
              profile.summary,
              ...profile.experiences
                .slice(0, 3)
                .map(
                  (e) =>
                    `${e.role} — ${e.company}${e.period ? ` (${e.period})` : ""}: ${e.description}`,
                ),
            ]
              .filter(Boolean)
              .join("\n") ||
            "Preencha seu resumo com fatos profissionais verificáveis.",
        },
        {
          question: "Por que esta oportunidade?",
          answer: `Tenho interesse na oportunidade ${job.title} na ${job.company}.${strengths.length ? ` Posso apresentar minha experiência declarada em ${strengths.join(", ")}.` : " Preciso revisar os requisitos e informar exemplos reais do meu trabalho."}`,
        },
        {
          question: "Quais requisitos precisam de esclarecimento?",
          answer: gaps.length
            ? `Ainda não declarei experiência verificada em: ${gaps.join(", ")}.`
            : "Validar escopo, contratação, localização e etapas do processo com a empresa.",
        },
      ],
      experiences: profile.experiences,
      additional: profile.additional,
      warning:
        "Rascunho local. Compatibilidade não comprova experiência. Revise cada resposta; nenhuma candidatura é enviada pelo aplicativo.",
    };
  }
}
export function prepareApplication(
  store,
  id,
  provider = new TemplateAssistantProvider(),
) {
  const application = store.ensureApplication(id);
  if (!["new", "saved", "reviewing", "prepared"].includes(application.status))
    throw new HttpError(409, "Reabra a análise antes de preparar novamente");
  const preparation = provider.prepare(store.getJob(id), store.getProfile());
  store.db.transaction(() => {
    let current = store.getApplication(application.id);
    if (["new", "saved"].includes(current.status))
      current = store.updateApplication(current.id, { status: "reviewing" });
    store.updateApplication(current.id, { status: "prepared" });
    store.db
      .prepare("UPDATE applications SET preparation=? WHERE id=?")
      .run(JSON.stringify(preparation), application.id);
  })();
  return store.getApplication(application.id);
}
