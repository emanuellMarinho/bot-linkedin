import fs from "node:fs";
import path from "node:path";
import { config } from "../src/config.js";
import { openDatabase } from "../src/database/index.js";
import { createStore } from "../src/database/store.js";
import { normalizePosting } from "../src/providers/index.js";

const fixtures = JSON.parse(
  fs.readFileSync(
    new URL("../tests/fixtures/postings.json", import.meta.url),
    "utf8",
  ),
);
const db = openDatabase(path.join(config.dataDir, "radar.sqlite")),
  store = createStore(db);
for (const provider of ["greenhouse", "lever", "ashby"]) {
  const item =
    provider === "lever" ? fixtures[provider][0] : fixtures[provider].jobs[0];
  const job = normalizePosting(provider, item, {
    company: "DEMONSTRAÇÃO — Empresa fictícia",
    board: "fixture",
  });
  job.title = `[DEMONSTRAÇÃO] ${job.title}`;
  job.provenance = "demo";
  store.upsertJob(job);
}
console.log(
  "Três vagas de DEMONSTRAÇÃO adicionadas. Nenhuma vaga real foi consultada por este comando.",
);
db.close();
