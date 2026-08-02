import { z } from "zod";

const boolFromEnv = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const envSchema = z.object({
  DATABASE_URL: z
    .string({
      required_error:
        "DATABASE_URL is not set — copy .env.example to .env in the repo root (see the README quickstart)",
    })
    .url({ message: "DATABASE_URL must be a valid postgres URL" })
    .refine((v) => v.startsWith("postgres://") || v.startsWith("postgresql://"), {
      message: "DATABASE_URL must use the postgres:// scheme, e.g. postgres://careerhq:careerhq@localhost:5432/careerhq",
    }),
  SUBMISSIONS_LIVE_EMAIL: boolFromEnv,
  SUBMISSIONS_LIVE_COMPANY_SITE: boolFromEnv,
  SANDBOX_FORCE_SAFE: boolFromEnv,
  FOLLOW_UP_DAYS: z.coerce.number().int().positive().default(7),
  FILE_STORAGE_DIR: z.string().default("var/files"),
});

export interface AppConfig {
  databaseUrl: string;
  submissionsLiveEmail: boolean;
  submissionsLiveCompanySite: boolean;
  sandboxForceSafe: boolean;
  followUpDays: number;
  fileStorageDir: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    // A raw ZodError is unreadable in a browser error overlay or a container
    // log, and a missing .env is the single most likely first-run failure.
    const details = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  const parsed = result.data;
  return {
    databaseUrl: parsed.DATABASE_URL,
    submissionsLiveEmail: parsed.SUBMISSIONS_LIVE_EMAIL,
    submissionsLiveCompanySite: parsed.SUBMISSIONS_LIVE_COMPANY_SITE,
    sandboxForceSafe: parsed.SANDBOX_FORCE_SAFE,
    followUpDays: parsed.FOLLOW_UP_DAYS,
    fileStorageDir: parsed.FILE_STORAGE_DIR,
  };
}
