import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSettings, skills } from "../config.js";

export function openDatabase(filename) {
  if (filename !== ":memory:") {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  }
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(
    "CREATE TABLE IF NOT EXISTS migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const dir = fileURLToPath(new URL("./migrations", import.meta.url));
  for (const file of fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (!db.prepare("SELECT 1 FROM migrations WHERE version=?").get(file))
      db.transaction(() => {
        db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
        db.prepare("INSERT INTO migrations VALUES (?,?)").run(
          file,
          new Date().toISOString(),
        );
      })();
  }
  db.prepare("INSERT OR IGNORE INTO settings VALUES (?,?)").run(
    "preferences",
    JSON.stringify(defaultSettings),
  );
  const profileCreated = db
    .prepare("INSERT OR IGNORE INTO candidate_profile VALUES (1,?)")
    .run(
      JSON.stringify({
        name: "",
        summary: "",
        experiences: [],
        seniority: null,
        professionalLinks: [],
        additional: "",
      }),
    ).changes;
  if (profileCreated)
    for (const name of skills)
      db.prepare("INSERT INTO candidate_skills(name) VALUES (?)").run(name);
  if (!db.prepare("SELECT 1 FROM job_keywords LIMIT 1").get())
    for (const [group, terms] of Object.entries(defaultSettings.keywordGroups))
      for (const term of terms)
        db.prepare(
          "INSERT INTO job_keywords(group_name,term) VALUES (?,?)",
        ).run(group, term);
  return db;
}
