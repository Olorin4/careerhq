import { z } from "zod";

const boolFromEnv = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const envSchema = z.object({
  DATABASE_URL: z.string().url({ message: "DATABASE_URL must be a valid postgres URL" }),
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
  const parsed = envSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    submissionsLiveEmail: parsed.SUBMISSIONS_LIVE_EMAIL,
    submissionsLiveCompanySite: parsed.SUBMISSIONS_LIVE_COMPANY_SITE,
    sandboxForceSafe: parsed.SANDBOX_FORCE_SAFE,
    followUpDays: parsed.FOLLOW_UP_DAYS,
    fileStorageDir: parsed.FILE_STORAGE_DIR,
  };
}
