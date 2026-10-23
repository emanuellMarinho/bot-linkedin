import sanitizeHtml from "sanitize-html";
import { createHash } from "node:crypto";

export const normalize = (value = "") =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/full[ -]?stack/g, "fullstack")
    .replace(/back[ -]?end/g, "backend")
    .replace(/\s+/g, " ")
    .trim();
export function plain(html = "") {
  const strip = (value) =>
    sanitizeHtml(
      value
        .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n"),
      { allowedTags: [], allowedAttributes: {} },
    );
  const first = strip(String(html))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  return strip(first).trim();
}
export function safeUrl(value) {
  const u = new URL(value);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    value.length > 2048
  )
    throw new Error("URL HTTP(S) inválida");
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    !host.includes(".") ||
    /^\d+\./.test(host) ||
    host.includes(":") ||
    host.startsWith("[")
  )
    throw new Error("URL deve apontar para um site público");
  return u;
}
export function canonicalUrl(value) {
  const u = safeUrl(value);
  if (u.hostname === "linkedin.com" || u.hostname.endsWith(".linkedin.com")) {
    const match = u.pathname.match(/^\/jobs\/view\/(?:.*-)?(\d+)\/?$/);
    if (match) {
      u.hostname = "www.linkedin.com";
      u.protocol = "https:";
      u.pathname = `/jobs/view/${match[1]}`;
      u.search = "";
    }
  }
  u.hash = "";
  for (const key of [...u.searchParams.keys()])
    if (/^(utm_|trk|tracking|ref$|source$|fbclid|gclid)/i.test(key))
      u.searchParams.delete(key);
  u.searchParams.sort();
  u.pathname = u.pathname.replace(/\/$/, "") || "/";
  return u.toString();
}
export const fingerprint = (job) =>
  createHash("sha256")
    .update([job.company, job.title, job.location].map(normalize).join("|"))
    .digest("hex");
export const isoDate = (value) =>
  value && !Number.isNaN(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
export const now = () => new Date().toISOString();
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
