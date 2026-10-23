import { z } from "zod";
import { safeUrl } from "./utils.js";
import { statuses } from "./config.js";

const text = (max = 200) => z.string().trim().min(1).max(max);
const nullableText = (max = 500) =>
  z.string().trim().max(max).nullable().default(null);
export const publicUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      safeUrl(value);
      return true;
    } catch {
      return false;
    }
  }, "URL pública HTTP(S) obrigatória");
const date = z.iso.datetime({ offset: true }).nullable().default(null);
export const jobInput = z
  .object({
    title: text(),
    company: text(),
    description: z.string().max(150000).default(""),
    url: publicUrl,
    applicationUrl: publicUrl.nullable().default(null),
    location: nullableText(),
    modality: z.enum(["remote", "hybrid", "onsite"]).nullable().default(null),
    seniority: z.enum(["junior", "mid", "senior"]).nullable().default(null),
    requiredSkills: z.array(text(80)).max(100).nullable().default(null),
    desiredSkills: z.array(text(80)).max(100).nullable().default(null),
    contractType: nullableText(80),
    salary: nullableText(1000),
    publishedAt: date,
    updatedAt: date,
    applicantCount: z
      .number()
      .int()
      .min(0)
      .max(1000000)
      .nullable()
      .default(null),
    applicantEvidence: nullableText(2000),
    publicationEvidence: nullableText(2000),
  })
  .strict()
  .superRefine((job, ctx) => {
    if (job.applicantCount !== null && !job.applicantEvidence)
      ctx.addIssue({
        code: "custom",
        path: ["applicantEvidence"],
        message: "Informe a evidência da contagem de candidaturas",
      });
    if (job.publishedAt && !job.publicationEvidence)
      ctx.addIssue({
        code: "custom",
        path: ["publicationEvidence"],
        message: "Informe a evidência da data de publicação",
      });
    if (job.publishedAt && Date.parse(job.publishedAt) > Date.now() + 60000)
      ctx.addIssue({
        code: "custom",
        path: ["publishedAt"],
        message: "Data de publicação futura",
      });
  });
export const sourceInput = z
  .object({
    provider: z.enum(["greenhouse", "lever", "ashby"]),
    board: text(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    company: text(),
    enabled: z.boolean().default(true),
  })
  .strict();
export const profileInput = z
  .object({
    name: z.string().trim().max(150),
    summary: z.string().max(10000),
    experiences: z
      .array(
        z
          .object({
            company: text(),
            role: text(),
            description: z.string().max(10000),
            period: z.string().max(200),
          })
          .strict(),
      )
      .max(100),
    seniority: z.enum(["junior", "mid", "senior"]).nullable(),
    professionalLinks: z.array(publicUrl).max(20),
    additional: z.string().max(10000),
    skills: z
      .array(z.object({ name: text(80), verified: z.boolean() }).strict())
      .max(100)
      .refine(
        (s) => new Set(s.map((v) => v.name.toLowerCase())).size === s.length,
        "Habilidades repetidas",
      ),
  })
  .strict();
export const settingsInput = z
  .object({
    country: text(100),
    modalities: z
      .array(z.enum(["remote", "hybrid", "onsite"]))
      .min(1)
      .max(3),
    seniorities: z
      .array(z.enum(["junior", "mid", "senior"]))
      .min(1)
      .max(3),
    contracts: z.array(text(80)).min(1).max(10),
    weights: z
      .object({
        technical: z.number().min(0).max(100),
        seniority: z.number().min(0).max(100),
        location: z.number().min(0).max(100),
        recency: z.number().min(0).max(100),
        contract: z.number().min(0).max(100),
      })
      .strict()
      .refine(
        (v) =>
          Math.abs(Object.values(v).reduce((a, b) => a + b, 0) - 100) < 0.001,
        "Os pesos devem somar 100",
      ),
    primaryHours: z.number().int().min(1).max(168),
    secondaryDays: z.number().int().min(1).max(60),
    maxApplicants: z.number().int().min(0).max(100000),
    minScore: z.number().min(0).max(100),
    collectionEnabled: z.boolean(),
    intervalHours: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(6),
      z.literal(8),
      z.literal(12),
      z.literal(24),
    ]),
    notificationsEnabled: z.boolean(),
    excludeSenior: z.boolean(),
    keywordGroups: z
      .record(text(100), z.array(text(150)).max(100))
      .refine(
        (value) =>
          Object.keys(value).length > 0 &&
          Object.keys(value).length <= 20 &&
          Object.values(value).flat().length > 0,
        "Configure ao menos uma nomenclatura",
      ),
  })
  .strict();
export const applicationPatch = z
  .object({
    status: z.enum(statuses).optional(),
    notes: z.string().max(20000).optional(),
    confirmedSent: z.boolean().optional(),
    resumeId: z.number().int().positive().nullable().optional(),
  })
  .strict();
export const parseId = (value) =>
  z.coerce.number().int().positive().parse(value);
