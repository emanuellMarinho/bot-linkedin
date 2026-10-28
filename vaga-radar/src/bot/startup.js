import { acceptCandidateAnswer, acceptWhatsAppAnswer, recordWhatsAppStatus } from "./questions.js";

const quietUI = { step() {}, status() {}, success() {}, error() {}, info() {}, raw() {}, withExclusive: (action) => action() };

export function notificationConfigFor(config, channel = config.notifications.channel) {
  if (channel === "sms") return {
    enabled: config.sms.enabled, transport: "sms", from: config.sms.from,
    to: config.sms.to.replace(/\D/g, ""),
    accessTokenEnv: config.sms.authTokenEnv, accountIdEnv: config.sms.accountSidEnv,
  };
  if (channel === "terminal") return { enabled: false, transport: "terminal", to: "" };
  return config.whatsapp;
}

/** Startup is a gate: no collection is started until this action resolves. */
export async function prepareMessaging({
  config, db, signal, ui = quietUI, interactive = false, promptFactory,
  personalFactory, smsFactory, cloudFactory, onCommand, configureSms, useTerminal, env = process.env,
}) {
  let channel = config.notifications.channel;
  let client;
  let sender;
  let poll = async () => {};
  let closed = false;
  async function closeClient() {
    if (!client) return;
    const previous = client;
    client = undefined;
    await previous.close();
  }
  const finish = (ready) => ({
    ready, channel, config, questionSender: sender,
    notificationConfig: notificationConfigFor(config, channel),
    getState: () => channel === "terminal" ? { ready: true, state: "terminal" } : client?.getState?.() || { ready, state: ready ? "connected" : "blocked" },
    poll: async () => { if (!closed && !signal?.aborted) await poll(); },
    close: async () => { if (closed) return; closed = true; await closeClient(); },
  });
  while (!signal?.aborted) {
    sender = undefined;
    poll = async () => {};
    ui.step(2, 4, "Preparar seus avisos", "A busca comeca quando esta etapa terminar.");
    if (channel === "terminal") {
      ui.success("Perguntas e acompanhamento disponiveis nesta janela.");
      return finish(true);
    }
    let connected = false;
    try {
      if (channel === "whatsapp") {
        if (!config.whatsapp.enabled) throw new Error("CHANNEL_DISABLED");
        if (config.whatsapp.transport === "personal") {
          const factory = personalFactory || (await import("../messaging/personal.js")).startPersonalWhatsApp;
          await ui.withExclusive(async () => {
            ui.info("Conectando WhatsApp (ate 90 segundos). Se aparecer um QR, leia pelo celular. Aguarde a confirmacao antes de continuar. Ctrl+C cancela.");
            client = await factory({
              dataDir: config.dataDir, to: config.whatsapp.to, signal,
              output: (message) => ui.raw(message),
              onAnswer: (input) => acceptWhatsAppAnswer(db, input),
              onStatus: (input) => recordWhatsAppStatus(db, input), onCommand,
            });
            connected = await client.waitUntilReady({ signal, timeoutMs: 90000 });
          });
          if (connected) sender = client.sendQuestion;
        } else {
          if (config.whatsapp.autoStartWebhook) {
            const factory = cloudFactory || (await import("../whatsapp-server.js")).startWhatsAppServer;
            client = await factory({ dataDir: config.dataDir, whatsapp: config.whatsapp, env });
          }
          const { checkWhatsAppConnection } = await import("../messaging/diagnostics.js");
          const report = await checkWhatsAppConnection(config.whatsapp, { env, signal });
          connected = report.ready;
          if (!connected) for (const issue of report.issues) ui.error(issue.message);
        }
      } else if (channel === "sms") {
        const factory = smsFactory || (await import("../messaging/sms.js")).startSmsMessaging;
        ui.info("Validando o servico SMS. Nenhuma mensagem e enviada nesta verificacao.");
        client = await factory({
          db, config: config.sms, env, signal, output: (message) => ui.info(message),
          onAnswer: (input) => acceptCandidateAnswer(db, input),
          onStatus: (input) => recordWhatsAppStatus(db, input),
        });
        const report = await client.checkConnection();
        connected = report.ready;
        if (connected) { sender = client.sendQuestion; poll = client.pollAnswers; }
        else for (const issue of report.issues || []) ui.error(issue.message);
      }
    } catch {
      if (!signal?.aborted) ui.error(channel === "sms"
        ? "SMS indisponivel. Confira a conta Twilio, as credenciais e o numero remetente habilitado para SMS."
        : "O WhatsApp ainda nao terminou de conectar. A busca nao foi iniciada.");
    }
    if (connected) {
      ui.success(channel === "sms" ? "Servico SMS autenticado. Mensagens usam sua conta Twilio e podem ter custo." : "WhatsApp conectado. Esta etapa terminou.");
      return finish(true);
    }
    await closeClient();
    if (signal?.aborted) return finish(false);
    ui.error("Os avisos ainda nao estao conectados. Nenhuma busca ou candidatura foi iniciada.");
    if (!interactive || !promptFactory) return finish(false);
    let choice;
    await ui.withExclusive(async () => {
      ui.info("1  Tentar conectar novamente\n2  Configurar SMS\n3  Continuar recebendo perguntas no terminal\n0  Encerrar");
      const prompt = promptFactory();
      const release = ui.suspend?.();
      try {
        choice = await prompt.ask("Escolha uma opcao", {
          defaultValue: "3", validate: (value) => /^[0123]$/.test(value) || "Escolha 0, 1, 2 ou 3.",
        });
      } finally { prompt.close(); release?.(); }
    });
    if (choice === "0") return finish(false);
    if (choice === "3") {
      if (useTerminal) config = await useTerminal(config);
      channel = "terminal";
    }
    else if (choice === "2") {
      if (!configureSms) {
        ui.info("Configure o servico SMS no assistente --setup antes de iniciar.");
        return finish(false);
      }
      await ui.withExclusive(async () => { config = await configureSms(config); });
      channel = "sms";
    }
  }
  await closeClient();
  return finish(false);
}
