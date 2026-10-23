import path from "node:path";
import { config } from "../src/config.js";
import { openDatabase } from "../src/database/index.js";

const db = openDatabase(path.join(config.dataDir, "radar.sqlite"));
for (const [provider, board, company] of [
  ["greenhouse", "vtex", "VTEX"],
  ["lever", "ciandt", "CI&T"],
  ["ashby", "ashby", "Ashby"],
])
  db.prepare(
    "INSERT OR IGNORE INTO sources(provider,board,company) VALUES (?,?,?)",
  ).run(provider, board, company);
console.log(
  "Quadros públicos configurados: VTEX (Greenhouse), CI&T (Lever), Ashby. Revise empresas e fontes no painel.",
);
db.close();
