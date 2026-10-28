import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { acceptCandidateAnswer } from "../bot/questions.js";

export function startTerminalAnswers(
  db,
  { input = process.stdin, output = process.stdout, onStop = () => {}, onCommand } = {},
) {
  const rl = createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY && output.isTTY),
    historySize: 0,
  });
  let closing = false;
  const line = (raw) => {
    if (onCommand) {
      try {
        const result = onCommand(raw);
        if (typeof result === "string") {
          output.write(result + "\n");
          return;
        }
      } catch {
        output.write("Não consegui consultar o acompanhamento. Tente novamente.\n");
        return;
      }
    }
    const match = raw.trim().match(/^([A-Za-z0-9_.-]{1,120}):\s*(.+)$/);
    if (!match) {
      if (raw.trim())
        output.write(
          "Digite vagas, candidaturas, vaga ID ou ajuda. Para responder uma dúvida: ID: sua resposta. Ctrl+C encerra.\n",
        );
      return;
    }
    try {
      const result = acceptCandidateAnswer(db, {
        messageId: `terminal:${randomUUID()}`,
        questionId: match[1],
        answer: match[2],
      });
      output.write(
        result.accepted
          ? "Resposta salva. O bot retomará a vaga durante o horário de trabalho.\n"
          : "Resposta não aceita. Confira o ID, o formato solicitado e se a pergunta continua pendente.\n",
      );
    } catch {
      output.write("Não consegui salvar a resposta. Tente novamente.\n");
    }
  };
  rl.on("line", line);
  rl.on("SIGINT", () => {
    closing = true;
    onStop();
    rl.close();
  });
  rl.on("close", () => {
    if (!closing) onStop();
  });
  return {
    close() {
      closing = true;
      rl.off("line", line);
      rl.close();
    },
  };
}
