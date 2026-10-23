import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/database/index.js";
import { createStore } from "../src/database/store.js";
import { createCollector } from "../src/services/collector.js";
import { createApp } from "../src/app.js";

export const fixtures = JSON.parse(
  fs.readFileSync(new URL("./fixtures/postings.json", import.meta.url), "utf8"),
);
export const manualJob = (overrides = {}) => ({
  title: "Desenvolvedor Node.js Pleno",
  company: "Empresa de teste",
  description:
    "Requisitos\nNode.js, JavaScript, SQL\nDiferenciais\nDocker\nRemoto no Brasil. CLT.",
  url: "https://example.org/jobs/1",
  location: "Brasil",
  modality: "remote",
  seniority: "mid",
  ...overrides,
});
export const normalizedJob = (overrides = {}) => ({
  ...manualJob(),
  provider: "manual",
  board: "",
  originalId: null,
  applicationUrl: "https://example.org/jobs/1",
  publishedAt: null,
  updatedAt: null,
  applicantCount: null,
  salary: null,
  provenance: "user",
  ...overrides,
});
export function harness(options = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "vaga-test-"));
  const db = openDatabase(
    options.persistent ? path.join(dataDir, "radar.sqlite") : ":memory:",
  );
  const store = createStore(db),
    logger = { warn() {}, error() {} };
  const collector = createCollector(store, { logger, ...options });
  const app = createApp(store, collector, { dataDir, logger });
  return {
    app,
    db,
    store,
    collector,
    dataDir,
    close() {
      collector.stop();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
