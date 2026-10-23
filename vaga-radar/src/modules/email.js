import { simpleParser } from "mailparser";
import { plain, canonicalUrl } from "../utils.js";

// Apenas conteúdo entregue pelo usuário; nenhuma conexão com a caixa postal ou com o LinkedIn.
export async function parseAlert(content, isEml = false) {
  let body = content;
  if (isEml) {
    const mail = await simpleParser(content, {
      skipHtmlToText: true,
      skipTextToHtml: true,
      skipImageLinks: true,
      maxHtmlLengthToParse: 2 * 1024 * 1024,
    });
    body = [
      mail.subject,
      mail.text,
      typeof mail.html === "string" ? mail.html : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  const urls = new Set();
  for (const match of body.matchAll(
    /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/jobs\/view\/(?:[a-zA-Z0-9-]*-)?\d+[^\s<>"']*/g,
  )) {
    try {
      urls.add(canonicalUrl(match[0].replace(/[).,;]+$/, "")));
    } catch {
      /* link incompleto no alerta: não importar */
    }
  }
  return {
    text: plain(body).slice(0, 150000),
    links: [...urls].slice(0, 100),
    notice:
      "Links extraídos apenas do conteúdo fornecido. Revise e preencha empresa e cargo antes de importar; a página original não foi consultada.",
  };
}
