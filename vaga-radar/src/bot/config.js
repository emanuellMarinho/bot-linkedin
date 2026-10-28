import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { profileInput, settingsInput, sourceInput } from "../validation.js";

export const botConfigInput = z
  .object({
    dataDir: z.string().min(1).default("./data"),
    profile: profileInput.partial().optional(),
    preferences: settingsInput.partial().default({}),
    sources: z.array(sourceInput).max(100).optional(),
    applicant: z
      .object({
        email: z.union([z.email(), z.literal("")]).default(""),
        resumePath: z.string().default(""),
      })
      .strict()
      .default({ email: "", resumePath: "" }),
    autoApply: z
      .object({
        enabled: z.boolean().default(false),
        maxPerRun: z.number().int().min(1).max(10).default(1),
        maxPerDay: z.number().int().min(1).max(20).default(3),
        sources: z
          .array(
            z
              .object({
                provider: z.literal("lever"),
                board: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/),
                apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
                authorizationConfirmed: z.boolean().default(false),
              })
              .strict(),
          )
          .max(100)
          .default([]),
      })
      .strict()
      .default({ enabled: false, maxPerRun: 1, maxPerDay: 3, sources: [] }),
    ai: z
      .object({
        enabled: z.boolean().default(false),
        model: z.string().min(1).max(100).default("gpt-4.1-mini"),
        apiKeyEnv: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .default("VAGA_OPENAI_KEY"),
      })
      .strict()
      .default({
        enabled: false,
        model: "gpt-4.1-mini",
        apiKeyEnv: "VAGA_OPENAI_KEY",
      }),
    workWindow: z
      .object({
        enabled: z.boolean().default(true),
        startHour: z.number().int().min(0).max(23).default(8),
        hours: z.number().int().min(1).max(24).default(12),
        timeZone: z
          .string()
          .refine((v) => {
            try {
              new Intl.DateTimeFormat("en", { timeZone: v });
              return true;
            } catch {
              return false;
            }
          }, "Fuso inválido")
          .default("America/Sao_Paulo"),
      })
      .strict()
      .default({
        enabled: true,
        startHour: 8,
        hours: 12,
        timeZone: "America/Sao_Paulo",
      }),
    whatsapp: z
      .object({
        enabled: z.boolean().default(false),
        phoneNumberId: z.string().regex(/^\d*$/).default(""),
        to: z.string().regex(/^\d*$/).default(""),
        accessTokenEnv: z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .default("VAGA_WHATSAPP_TOKEN"),
        templateName: z
          .string()
          .regex(/^[a-z0-9_]*$/)
          .default("vaga_radar_duvida"),
        language: z.string().default("pt_BR"),
        apiVersion: z
          .string()
          .regex(/^v\d{1,2}\.\d$/)
          .default("v24.0"),
      })
      .strict()
      .default({
        enabled: false,
        phoneNumberId: "",
        to: "",
        accessTokenEnv: "VAGA_WHATSAPP_TOKEN",
        templateName: "vaga_radar_duvida",
        language: "pt_BR",
        apiVersion: "v24.0",
      }),
  })
  .strict();

export function readBotConfig(filename) {
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
    throw new Error("Arquivo de configuração inválido ou maior que 2 MB");
  const parsed = botConfigInput.parse(
    JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/, "")),
  );
  const directory = path.dirname(path.resolve(filename));
  return {
    ...parsed,
    dataDir: path.resolve(directory, parsed.dataDir),
    applicant: {
      ...parsed.applicant,
      resumePath: parsed.applicant.resumePath
        ? path.resolve(directory, parsed.applicant.resumePath)
        : "",
    },
  };
}

export function applyBotConfig(store, config) {
  if (config.profile) {
    const { resumes, ...current } = store.getProfile();
    store.saveProfile(profileInput.parse({ ...current, ...config.profile }));
  }
  const current = store.getSettings();
  store.saveSettings(
    settingsInput.parse({ ...current, ...config.preferences }),
  );
  if (config.sources !== undefined)
    store.db.transaction(() => {
      store.db.prepare("UPDATE sources SET enabled=0").run();
      for (const source of config.sources)
        store.db
          .prepare(
            "INSERT INTO sources(provider,board,company,enabled) VALUES (?,?,?,?) ON CONFLICT(provider,board) DO UPDATE SET company=excluded.company,enabled=excluded.enabled",
          )
          .run(
            source.provider,
            source.board,
            source.company,
            Number(source.enabled),
          );
    })();
}
