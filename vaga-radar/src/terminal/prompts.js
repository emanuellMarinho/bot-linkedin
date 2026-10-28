import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { wrapTerminalText } from "./ui.js";

export class SetupCancelled extends Error {
  constructor() {
    super("Configuração cancelada. Nenhuma alteração foi salva.");
    this.code = "SETUP_CANCELLED";
  }
}

export function createTerminalPrompt({
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const controller = new AbortController();
  let muted = false;
  const sink = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding);
      callback();
    },
  });
  sink.columns = output.columns;
  const terminal = Boolean(input.isTTY && output.isTTY);
  const rl = createInterface({ input, output: sink, terminal, historySize: 0 });
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    controller.abort();
    rl.close();
  };
  rl.on("SIGINT", cancel);
  rl.on("close", () => {
    cancelled = true;
    controller.abort();
  });
  async function runAsk(
    label,
    { defaultValue = "", secret = false, required = false, validate } = {},
  ) {
    while (true) {
      if (cancelled) throw new SetupCancelled();
      const suffix = defaultValue && !secret ? ` [${defaultValue}]` : "";
      const question = `${wrapTerminalText(`${label}${suffix}`, Math.max(24, (output.columns || 68) - 2)).join("\n")}\n> `;
      let value;
      try {
        if (secret) {
          output.write(question);
          muted = terminal;
          value = await rl.question("", { signal: controller.signal });
        } else
          value = await rl.question(question, {
            signal: controller.signal,
          });
      } catch {
        throw new SetupCancelled();
      } finally {
        if (secret) {
          muted = false;
          output.write("\n");
        }
      }
      value = value.trim() || String(defaultValue);
      if (required && !value) {
        output.write("Este campo é obrigatório.\n");
        continue;
      }
      if (validate) {
        const error = await validate(value);
        if (error !== true && error !== undefined) {
          output.write(
            typeof error === "string"
              ? `${error}\n`
              : "Valor inválido. Tente novamente.\n",
          );
          continue;
        }
      }
      return value;
    }
  }
  // A question owns the terminal through validation. A second caller waits
  // instead of replacing readline's active question while work is unfinished.
  let active = false;
  const requests = [];
  function drain() {
    if (active || !requests.length) return;
    active = true;
    const request = requests.shift();
    runAsk(request.label, request.options).then(
      (value) => {
        active = false;
        request.resolve(value);
        drain();
      },
      (error) => {
        active = false;
        request.reject(error);
        drain();
      },
    );
  }
  function ask(label, options) {
    return new Promise((resolve, reject) => {
      requests.push({ label, options, resolve, reject });
      drain();
    });
  }
  async function confirm(label, { defaultValue = false, ...options } = {}) {
    const value = await ask(`${label} (s/n)`, {
      ...options,
      defaultValue: defaultValue ? "s" : "n",
      validate: (v) =>
        /^(s|sim|y|yes|n|nao|não|no)$/i.test(v) || "Responda s ou n.",
    });
    return /^(s|sim|y|yes)$/i.test(value);
  }
  return {
    ask,
    confirm,
    close: () => {
      muted = false;
      rl.close();
    },
  };
}
