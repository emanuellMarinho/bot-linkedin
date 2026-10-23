import { config } from "../src/config.js";
const base = `http://${config.host === "::1" ? "[::1]" : config.host}:${config.port}`;
try {
  const response = await fetch(`${base}/api/collection/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(180000),
  });
  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
  if (!response.ok || !["completed", "no_sources"].includes(result.status))
    process.exitCode = 1;
} catch (error) {
  console.error(
    "Não foi possível coletar. Inicie o servidor e verifique a rede:",
    error.message,
  );
  process.exitCode = 1;
}
