import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * The repo root — the directory holding pnpm-workspace.yaml — found by walking
 * up from the current working directory. Processes run from all over the
 * workspace (`next dev` from apps/web, the seed from packages/db, the worker
 * from /app in the container), so cwd alone is not a stable base for relative
 * paths. Falls back to cwd outside a workspace checkout.
 */
function findRepoRoot(): string {
  const cwd = process.cwd();
  let dir = cwd;
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

/**
 * FILE_STORAGE_DIR must name one directory for every process — the seed writes
 * CVs there and the web upload action reads/writes the same tree, and in the
 * container it is the mounted volume. Absolute values are used as given;
 * relative ones resolve against the repo root, never against cwd.
 */
function resolveStorageDir(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(findRepoRoot(), value);
}

const boolFromEnv = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const DEFAULT_AI_FAST_MODELS = [
  "google/gemini-2.0-flash-exp:free",
  "meta-llama/llama-3.3-70b-instruct:free",
];

/** Splits a comma-separated env value into trimmed, non-empty entries. */
function parseCommaList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

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
  FILE_STORAGE_DIR: z.string().default("var/files").transform(resolveStorageDir),
  // AI features are off by default (deterministic floor) until a key is provisioned.
  OPENROUTER_API_KEY: z.string().optional(),
  AI_FAST_MODELS: z
    .string()
    .default(DEFAULT_AI_FAST_MODELS.join(","))
    .transform(parseCommaList),
  INGEST_CRON: z.string().default("0 */6 * * *"),
});

export interface AppConfig {
  databaseUrl: string;
  submissionsLiveEmail: boolean;
  submissionsLiveCompanySite: boolean;
  sandboxForceSafe: boolean;
  followUpDays: number;
  /** Always absolute: relative FILE_STORAGE_DIR values resolve against the repo root. */
  fileStorageDir: string;
  /** null (default) keeps AI features off — the deterministic floor when no key is provisioned. */
  openrouterApiKey: string | null;
  aiFastModels: string[];
  ingestCron: string;
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
    openrouterApiKey: parsed.OPENROUTER_API_KEY ?? null,
    aiFastModels: parsed.AI_FAST_MODELS,
    ingestCron: parsed.INGEST_CRON,
  };
}
