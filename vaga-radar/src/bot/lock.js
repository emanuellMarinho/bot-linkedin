import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Um lock por diretório de dados evita dois bots enviando a mesma candidatura.
export function acquireBotLock(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, "bot.lock"),
    token = randomUUID();
  let descriptor;
  try {
    descriptor = fs.openSync(filename, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let previous;
    try {
      previous = JSON.parse(fs.readFileSync(filename, "utf8"));
    } catch {
      throw new Error(
        "Lock do bot inválido. Confira que o bot está encerrado antes de remover bot.lock.",
      );
    }
    if (!Number.isInteger(previous.pid) || previous.pid <= 0)
      throw new Error("Lock do bot inválido");
    try {
      process.kill(previous.pid, 0);
      throw new Error("Já existe um bot ativo neste diretório de dados");
    } catch (check) {
      if (check.code !== "ESRCH") throw check;
    }
    // Reclamamos apenas um lock comprovadamente órfão, sem sobrescrever o de outro processo.
    const tombstone = filename + "." + token + ".stale";
    fs.renameSync(filename, tombstone);
    try {
      descriptor = fs.openSync(filename, "wx", 0o600);
    } finally {
      fs.unlinkSync(tombstone);
    }
  }
  fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token }));
  fs.closeSync(descriptor);
  return () => {
    try {
      if (JSON.parse(fs.readFileSync(filename, "utf8")).token === token)
        fs.unlinkSync(filename);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };
}
