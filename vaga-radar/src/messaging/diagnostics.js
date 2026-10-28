import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

// Local configuration checks deliberately perform no network access and never
// return the recipient, token, app secret, URL or provider response body.
export function validateWebhookUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      url.pathname.endsWith("/webhook") &&
      !url.username && !url.password && !url.search && !url.hash &&
      (!url.port || url.port === "443") &&
      !isIP(hostname) && !hostname.includes(":") &&
      hostname.length <= 253 &&
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname) &&
      !/(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/.test(hostname)
    );
  } catch {
    return false;
  }
}

export function inspectWhatsAppConfig(config = {}, { env = process.env } = {}) {
  const issues = [];
  const add = (code, message) => issues.push({ code, message });
  if (!config.enabled)
    add("WHATSAPP_DISABLED", "WhatsApp desativado. Salvar o número pessoal não conecta um serviço remetente.");
  if (!/^\d{8,15}$/.test(config.to || ""))
    add("RECIPIENT_REQUIRED", "Informe seu número pessoal com país e DDD para receber as perguntas.");
  if (config.transport === "personal")
    return { ready: issues.length === 0, issues };
  if (!/^\d{5,25}$/.test(config.phoneNumberId || ""))
    add("SENDER_REQUIRED", "Falta o Phone Number ID de um remetente autenticado na Meta. Seu número pessoal pode continuar como destino.");
  const token = env[config.accessTokenEnv || "VAGA_WHATSAPP_TOKEN"];
  if (typeof token !== "string" || !token || token.length > 4096 || /\s/.test(token))
    add("ACCESS_TOKEN_REQUIRED", "Configure o token de acesso do serviço remetente no assistente local ou no ambiente.");
  if (!/^[a-z][a-z0-9_]{0,511}$/.test(config.templateName || ""))
    add("TEMPLATE_REQUIRED", "Configure o nome do template aprovado com os parâmetros de pergunta e identificador.");
  if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(config.language || "pt_BR"))
    add("LANGUAGE_INVALID", "O idioma do template precisa ter um código válido, como pt_BR.");
  if (!/^v\d{1,3}\.\d{1,2}$/.test(config.apiVersion || "v24.0"))
    add("API_VERSION_INVALID", "Configure uma versão válida da API Meta.");
  if (!validateWebhookUrl(config.webhookUrl))
    add("PUBLIC_WEBHOOK_REQUIRED", "Configure uma URL HTTPS pública terminada em /webhook para receber respostas; o receptor local sozinho não é acessível pela Meta.");
  for (const [name, code, message] of [
    ["VAGA_META_APP_SECRET", "APP_SECRET_REQUIRED", "Configure o App Secret local da Meta para validar a assinatura das respostas."],
    ["VAGA_WHATSAPP_VERIFY_TOKEN", "VERIFY_TOKEN_REQUIRED", "Configure o verify token local usado no cadastro do webhook da Meta."],
  ]) {
    const value = env[name];
    if (typeof value !== "string" || value.length < 16 || value.length > 8192)
      add(code, message);
  }
  return { ready: issues.length === 0, issues };
}

async function smallText(response, limit = 16384) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("Response too large");
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body || []) {
    length += chunk.length;
    if (length > limit) throw new Error("Response too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function checkWhatsAppConnection(
  config,
  { env = process.env, fetcher = fetch, signal } = {},
) {
  const inspected = inspectWhatsAppConfig(config, { env });
  const checks = {
    configuration: inspected.ready ? "passed" : "failed",
    credentials: "unverified",
    webhook: "unverified",
  };
  const report = {
    ...inspected,
    checks,
    deliveryVerified: false,
    templateVerified: false,
    subscriptionVerified: false,
  };
  if (!inspected.ready) return report;
  if (config.transport === "personal") {
    report.ready = false;
    report.checks.webhook = "not_applicable";
    report.issues.push({
      code: "PERSONAL_SESSION_REQUIRED",
      message: "A conexão pessoal precisa de uma sessão ativa. Abra o bot e leia o QR code exibido no terminal para conectar o WhatsApp.",
    });
    return report;
  }
  if (signal?.aborted) {
    report.ready = false;
    report.issues.push({ code: "CANCELLED", message: "Diagnóstico cancelado antes da consulta." });
    return report;
  }
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
    : AbortSignal.timeout(15000);
  const results = await Promise.all([
    (async () => {
      try {
        const response = await fetcher(
          `https://graph.facebook.com/${config.apiVersion || "v24.0"}/${config.phoneNumberId}?fields=id`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${env[config.accessTokenEnv || "VAGA_WHATSAPP_TOKEN"]}` },
            redirect: "error",
            signal: requestSignal,
          },
        );
        if (!response.ok) {
          await response.body?.cancel();
          return { code: "SENDER_CHECK_FAILED", message: "A Meta não confirmou o token e o Phone Number ID. Revise as permissões e a validade do token." };
        }
        const payload = JSON.parse(await smallText(response));
        if (payload?.id !== config.phoneNumberId)
          return { code: "SENDER_CHECK_FAILED", message: "A Meta não confirmou o remetente configurado." };
        return null;
      } catch {
        return { code: "SENDER_CHECK_UNAVAILABLE", message: "Não foi possível verificar o remetente na Meta. Confira a conexão e tente novamente." };
      }
    })(),
    (async () => {
      try {
        const challenge = randomBytes(24).toString("hex");
        const endpoint = new URL(config.webhookUrl);
        endpoint.searchParams.set("hub.mode", "subscribe");
        endpoint.searchParams.set("hub.verify_token", env.VAGA_WHATSAPP_VERIFY_TOKEN);
        endpoint.searchParams.set("hub.challenge", challenge);
        const response = await fetcher(endpoint.href, {
          method: "GET",
          redirect: "error",
          signal: requestSignal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          return { code: "WEBHOOK_CHECK_FAILED", message: "O webhook público não aceitou a verificação. Confira a URL, o verify token e o receptor em execução." };
        }
        if ((await smallText(response)) !== challenge)
          return { code: "WEBHOOK_CHECK_FAILED", message: "O endpoint público não respondeu ao desafio do webhook. Confira o encaminhamento para o receptor do bot." };
        return null;
      } catch {
        return { code: "WEBHOOK_CHECK_UNAVAILABLE", message: "O webhook público não respondeu. Confira o HTTPS e o encaminhamento para o receptor do bot." };
      }
    })(),
  ]);
  [checks.credentials, checks.webhook] = results.map((result) => result ? "failed" : "passed");
  report.issues.push(...results.filter(Boolean));
  report.ready = report.issues.length === 0;
  return report;
}
