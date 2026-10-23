import { plain, isoDate, safeUrl } from "../utils.js";

export const endpoints = {
  greenhouse: (board) =>
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`,
  lever: (board) =>
    `https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json`,
  ashby: (board) =>
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`,
};

export function normalizePosting(provider, item, source) {
  let job;
  if (provider === "greenhouse")
    job = {
      originalId: String(item.id),
      title: item.title,
      description: plain(item.content),
      url: item.absolute_url,
      applicationUrl: item.absolute_url,
      location: item.location?.name || null,
      publishedAt: isoDate(item.first_published),
      updatedAt: isoDate(item.updated_at),
      modality: null,
      contractType: null,
      salary: item.pay_input_ranges?.length
        ? JSON.stringify(item.pay_input_ranges)
        : null,
    };
  else if (provider === "lever")
    job = {
      originalId: item.id,
      title: item.text,
      description: [
        item.descriptionPlain || plain(item.description),
        ...(item.lists || []).map(
          (list) => `${list.text}\n${plain(list.content)}`,
        ),
        item.additionalPlain || plain(item.additional),
      ]
        .filter(Boolean)
        .join("\n"),
      url: item.hostedUrl,
      applicationUrl: item.applyUrl || item.hostedUrl,
      location:
        item.categories?.allLocations?.join(" / ") ||
        item.categories?.location ||
        null,
      // createdAt não faz parte do contrato público documentado do Lever.
      publishedAt: null,
      updatedAt: null,
      modality:
        { remote: "remote", hybrid: "hybrid", "on-site": "onsite" }[
          item.workplaceType
        ] || null,
      contractType: null,
      employmentType: item.categories?.commitment || null,
      salary: item.salaryRange ? JSON.stringify(item.salaryRange) : null,
    };
  else if (provider === "ashby")
    job = {
      originalId: item.id || null,
      title: item.title,
      description: item.descriptionPlain || plain(item.descriptionHtml),
      url: item.jobUrl,
      applicationUrl: item.applyUrl || item.jobUrl,
      location:
        [
          item.location,
          ...(item.secondaryLocations || []).map((l) => l.location),
        ]
          .filter(Boolean)
          .join(" / ") || null,
      publishedAt: isoDate(item.publishedAt),
      updatedAt: null,
      modality: item.workplaceType
        ? { Remote: "remote", Hybrid: "hybrid", OnSite: "onsite" }[
            item.workplaceType
          ] || null
        : item.isRemote === true
          ? "remote"
          : null,
      contractType: null,
      employmentType: item.employmentType || null,
      salary: item.compensation ? JSON.stringify(item.compensation) : null,
    };
  else throw new Error("Provedor não suportado");
  if (
    (provider !== "ashby" &&
      (!job.originalId || job.originalId === "undefined")) ||
    !job.title ||
    !job.url
  )
    throw new Error("Resposta sem identificação, título ou URL");
  safeUrl(job.url);
  safeUrl(job.applicationUrl);
  return {
    ...job,
    company: source.company,
    provider,
    board: source.board,
    applicantCount: null,
    provenance: "collected",
    rawFacts: {
      location: job.location,
      modality: job.modality,
      contractType: job.contractType,
      publishedAt: job.publishedAt,
      updatedAt: job.updatedAt,
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function boundedJson(response) {
  if (Number(response.headers.get("content-length")) > 12 * 1024 * 1024)
    throw new Error("Resposta excede 12 MB");
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 12 * 1024 * 1024) throw new Error("Resposta excede 12 MB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function fetchJobs(
  source,
  { fetcher = fetch, delay = sleep, signal } = {},
) {
  if (
    !endpoints[source.provider] ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(source.board)
  )
    throw new Error("Fonte inválida");
  const url = endpoints[source.provider](source.board);
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    const timeout = AbortSignal.timeout(20000);
    response = await fetcher(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "VagaRadar/1.0 (public job board reader)",
      },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.ok) break;
    if (![429, 502, 503, 504].includes(response.status) || attempt === 2)
      throw new Error(
        `${source.provider}: HTTP ${response.status} em ${new URL(url).hostname}`,
      );
    const header = response.headers.get("retry-after");
    const retry =
      header && /^\d+$/.test(header)
        ? Number(header)
        : header
          ? Math.max(0, Math.ceil((Date.parse(header) - Date.now()) / 1000))
          : 0;
    await response.body?.cancel();
    if (retry > 3)
      throw new Error(
        `${source.provider}: HTTP ${response.status}; respeitar Retry-After de ${retry}s antes da próxima coleta`,
      );
    await delay(retry > 0 ? retry * 1000 : 500 * 2 ** attempt);
    signal?.throwIfAborted();
  }
  const body = await boundedJson(response);
  const items = source.provider === "lever" ? body : body.jobs;
  if (!Array.isArray(items)) throw new Error("Formato inesperado da API");
  if (items.length > 20000)
    throw new Error("Quadro acima do limite de 20.000 vagas");
  const jobs = [],
    errors = [];
  for (const item of items) {
    if (item.isListed === false) continue;
    try {
      jobs.push(normalizePosting(source.provider, item, source));
    } catch (error) {
      errors.push(`Registro inválido: ${error.message}`);
    }
  }
  return { jobs, errors };
}
