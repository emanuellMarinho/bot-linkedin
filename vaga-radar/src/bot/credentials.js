const bindings = {
  openaiApiKey: (c) => c.ai.apiKeyEnv,
  whatsappAccessToken: (c) => c.whatsapp.accessTokenEnv,
  whatsappVerifyToken: () => "VAGA_WHATSAPP_VERIFY_TOKEN",
  metaAppSecret: () => "VAGA_META_APP_SECRET",
  leverApiKey: (c) => c.autoApply.sources[0]?.apiKeyEnv || "VAGA_LEVER_KEY",
  twilioAccountSid: (c) => c.sms.accountSidEnv,
  twilioAuthToken: (c) => c.sms.authTokenEnv,
};

export function applyLocalCredentials(config, env = process.env) {
  for (const [field, target] of Object.entries(bindings)) {
    const value = config.credentials?.[field];
    if (value) env[target(config)] = value;
  }
  if (config.whatsapp.to) env.VAGA_WHATSAPP_TO = config.whatsapp.to;
  return env;
}
