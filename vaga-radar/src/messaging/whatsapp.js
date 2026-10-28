// Meta Cloud API: https://github.com/WhatsApp/WhatsApp-Nodejs-SDK
// Always use an approved template, including outside the 24-hour service window.
export class WhatsAppError extends Error {
  constructor(code, message, providerCode) {
    super(message);
    this.name = "WhatsAppError";
    this.code = code;
    this.requiresReconciliation = code === "AMBIGUOUS";
    if (Number.isSafeInteger(providerCode) && providerCode >= 0)
      this.providerCode = providerCode;
  }
}

const invalid = () =>
  new WhatsAppError(
    "CONFIGURATION",
    "Configuração do WhatsApp inválida ou incompleta",
  );

async function boundedJson(response) {
  if (Number(response.headers.get("content-length")) > 1024 * 1024) {
    await response.body?.cancel();
    throw new Error("limit");
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 1024 * 1024) throw new Error("limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function sendQuestion(
  question,
  {
    enabled = false,
    phoneNumberId,
    to,
    accessToken,
    templateName,
    language = "pt_BR",
    apiVersion = "v24.0",
    fetcher = fetch,
    signal,
  } = {},
) {
  if (!enabled) return { provider: "disabled", sent: false };
  if (
    typeof phoneNumberId !== "string" ||
    !/^\d{5,25}$/.test(phoneNumberId) ||
    typeof to !== "string" ||
    !/^\d{8,15}$/.test(to) ||
    typeof accessToken !== "string" ||
    !accessToken.trim() ||
    accessToken.length > 4096 ||
    /\s/.test(accessToken) ||
    typeof templateName !== "string" ||
    !/^[a-z][a-z0-9_]{0,511}$/.test(templateName) ||
    !/^v\d{1,3}\.\d{1,2}$/.test(apiVersion) ||
    !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language) ||
    typeof question?.id !== "string" ||
    !/^[A-Za-z0-9_.-]{1,120}$/.test(question.id) ||
    typeof question?.text !== "string" ||
    !question.text.trim() ||
    question.text.length > 700
  )
    throw invalid();
  if (signal?.aborted)
    throw new WhatsAppError("CANCELLED", "Envio cancelado antes da requisição");

  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: language },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: question.text },
            { type: "text", text: question.id },
          ],
        },
      ],
    },
  };
  let response;
  try {
    response = await fetcher(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
      },
    );
  } catch {
    throw new WhatsAppError(
      "AMBIGUOUS",
      "Resultado do envio ao WhatsApp inconclusivo; não reenviar automaticamente",
    );
  }
  if (!response.ok) {
    // Only expose a numeric provider code; Meta's text may contain private data.
    let providerCode;
    try {
      const error = (await boundedJson(response))?.error;
      if (Number.isSafeInteger(error?.code) && error.code >= 0)
        providerCode = error.code;
    } catch {
      // The HTTP result remains authoritative if its error body is malformed.
    }
    if (
      [401, 403].includes(response.status) ||
      (response.status >= 400 && response.status < 500 && providerCode === 190)
    )
      throw new WhatsAppError(
        "AUTHORIZATION",
        "A autorização da integração WhatsApp precisa ser revisada",
        providerCode,
      );
    if (
      response.status === 429 ||
      (response.status >= 400 && response.status < 500 &&
        [4, 17, 32, 613, 130429, 131048, 131056].includes(providerCode))
    )
      throw new WhatsAppError(
        "RATE_LIMIT",
        "Limite do WhatsApp atingido; aguarde antes de uma nova tentativa",
        providerCode,
      );
    if (response.status >= 400 && response.status < 500)
      throw new WhatsAppError(
        "REJECTED",
        "WhatsApp recusou a mensagem; revise o número e o template aprovado",
        providerCode,
      );
    throw new WhatsAppError(
      "AMBIGUOUS",
      "Resultado do envio ao WhatsApp inconclusivo; não reenviar automaticamente",
      providerCode,
    );
  }
  let parsed;
  try {
    parsed = await boundedJson(response);
  } catch {
    throw new WhatsAppError(
      "AMBIGUOUS",
      "WhatsApp não retornou um comprovante válido; não reenviar automaticamente",
    );
  }
  const messageId = parsed?.messages?.[0]?.id;
  if (
    typeof messageId !== "string" ||
    !/^wamid\.[A-Za-z0-9_+/=.-]{1,500}$/.test(messageId)
  ) {
    throw new WhatsAppError(
      "AMBIGUOUS",
      "WhatsApp não retornou um comprovante válido; não reenviar automaticamente",
    );
  }
  return { provider: "whatsapp", messageId, verified: true };
}
