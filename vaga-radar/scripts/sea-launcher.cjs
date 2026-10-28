/*
 * Node SEA entrypoint. Application modules and native dependencies live beside
 * the executable, so the delivered ZIP is portable, not a one-file application.
 */
const path = require("node:path");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

async function pauseAfterLaunchFailure() {
  // Explorer closes a new console as soon as the executable exits. Keep the
  // diagnostic visible there, while scripts/CI with redirected input never wait.
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const { createInterface } = require("node:readline/promises");
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    await terminal.question("Pressione Enter para fechar esta janela...");
  } finally {
    terminal.close();
  }
}

const portableDirectory = path.dirname(process.execPath);
const applicationPackage = path.join(portableDirectory, "app", "package.json");

async function launch() {
  if (!fs.existsSync(applicationPackage)) {
    console.error(
      "Pacote incompleto. Extraia todo o ZIP e mantenha a pasta app ao lado de VagaRadar.exe.",
    );
    process.exitCode = 1;
    await pauseAfterLaunchFailure();
    return;
  }
  try {
    process.env.VAGA_RADAR_PORTABLE_DIR ||= portableDirectory;
    const applicationRequire = createRequire(applicationPackage);
    const entrypoint = applicationRequire.resolve("./src/bot.js");
    const application = await import(pathToFileURL(entrypoint).href);
    const run = application.runCLI || application.main;
    if (typeof run !== "function") throw new Error("Entrypoint ausente");
    // Node SEA preserves the usual argument layout: user args start at 2.
    const result = await run(process.argv.slice(2));
    if (Number.isInteger(result)) process.exitCode = result;
  } catch {
    // Exceptions can contain personal input: never print their raw contents.
    console.error(
      "Não foi possível iniciar o bot. Confira a configuração e a integridade do pacote; nenhum painel web foi iniciado.",
    );
    process.exitCode = 1;
    await pauseAfterLaunchFailure();
  }
}

launch().catch(() => {
  process.exitCode = 1;
});
