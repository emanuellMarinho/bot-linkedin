/*
 * Node SEA entrypoint. Application modules and native dependencies live beside
 * the executable, so the delivered ZIP is portable, not a one-file application.
 */
const path = require("node:path");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

const portableDirectory = path.dirname(process.execPath);
const applicationPackage = path.join(portableDirectory, "app", "package.json");

if (!fs.existsSync(applicationPackage)) {
  console.error(
    "Pacote incompleto. Extraia todo o ZIP e mantenha a pasta app ao lado de VagaRadar.exe.",
  );
  process.exitCode = 1;
} else {
  process.env.VAGA_RADAR_PORTABLE_DIR ||= portableDirectory;
  const applicationRequire = createRequire(applicationPackage);
  const entrypoint = applicationRequire.resolve("./src/bot.js");
  import(pathToFileURL(entrypoint).href)
    .then(async ({ main }) => {
      if (typeof main !== "function") throw new Error("Entrypoint ausente");
      // Node SEA preserves the usual argument layout: user args start at 2.
      const result = await main(process.argv.slice(2));
      if (Number.isInteger(result)) process.exitCode = result;
    })
    .catch(() => {
      // Exceptions can include paths or personal input: don't print their bodies.
      console.error(
        "Não foi possível iniciar o bot. Confira a configuração e a integridade do pacote; nenhum painel web foi iniciado.",
      );
      process.exitCode = 1;
    });
}
