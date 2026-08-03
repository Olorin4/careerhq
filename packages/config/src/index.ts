import { existsSync } from "node:fs";
import path from "node:path";
import { AI_MODES, type AiMode } from "@careerhq/contracts";
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
 * Shared-directory settings (FILE_STORAGE_DIR, AI_REPLAY_DIR) must name one
 * directory for every process — the seed writes CVs there and the web upload
 * action reads/writes the same tree, the replay fixtures are committed once
 * and read by both web and worker, and in the container both are mounted
 * paths. Absolute values are used as given; relative ones resolve against the
 * repo root, never against cwd.
 */
function resolveSharedDir(value: string): string {
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

const DEFAULT_AI_WRITING_MODELS = [
  "deepseek/deepseek-chat:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemini-2.0-flash-001",
];

/**
 * Splits a comma-separated env value into trimmed, non-empty entries, falling
 * back to `fallback` when nothing survives. An explicitly empty value bypasses
 * zod's `.default()`, and Compose passes exactly that with
 * `AI_FAST_MODELS: ${AI_FAST_MODELS:-}` (and the same for AI_WRITING_MODELS) —
 * an empty list would leave the fallback client with no model to try and
 * report it as "all models cooling down", which is not what happened.
 */
function parseModelList(value: string, fallback: readonly string[]): string[] {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : [...fallback];
}

/** Empty and whitespace-only env values mean "unset" — see `parseModelList`. */
function optionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The compose service name of the local mail sink. A sandbox workspace may
 * only send to this host (spec §11's `sandbox_blocked` gate), so the value has
 * to point at something that cannot reach a real recruiter.
 */
const DEFAULT_SANDBOX_SMTP_HOST = "mailpit";

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
  // Compared against a connection's SMTP host by the sandbox gate. An empty
  // value (what Compose passes for an unset variable) must not become an empty
  // allow-list entry — it falls back to the default, like the model lists.
  SANDBOX_SMTP_ALLOWED_HOST: z
    .string()
    .default(DEFAULT_SANDBOX_SMTP_HOST)
    .transform((v) => v.trim() || DEFAULT_SANDBOX_SMTP_HOST),
  FOLLOW_UP_DAYS: z.coerce.number().int().positive().default(7),
  FILE_STORAGE_DIR: z.string().default("var/files").transform(resolveSharedDir),
  // AI features are off by default (deterministic floor) until a key is provisioned.
  OPENROUTER_API_KEY: z.string().optional(),
  AI_FAST_MODELS: z
    .string()
    .default(DEFAULT_AI_FAST_MODELS.join(","))
    .transform((value) => parseModelList(value, DEFAULT_AI_FAST_MODELS)),
  AI_WRITING_MODELS: z
    .string()
    .default(DEFAULT_AI_WRITING_MODELS.join(","))
    .transform((value) => parseModelList(value, DEFAULT_AI_WRITING_MODELS)),
  INGEST_CRON: z.string().default("0 */6 * * *"),
  EMAIL_SYNC_CRON: z.string().default("*/15 * * * *"),
  AI_MODE: z.enum(AI_MODES, {
    errorMap: () => ({
      message: `AI_MODE must be one of: ${AI_MODES.join(", ")}`,
    }),
  }).default("live"),
  // Where withReplay's filesystem store keeps recorded AI calls. Fixtures are
  // committed, so the default points at the in-repo directory.
  AI_REPLAY_DIR: z.string().default("packages/ai/fixtures/replay").transform(resolveSharedDir),
  // The libsodium secretbox key used to seal/open email credentials
  // (packages/db/src/crypto.ts). Unset (or empty, as Compose passes with
  // `${CAREERHQ_MASTER_KEY:-}`) disables email connections entirely — there
  // is no key to encrypt SMTP/IMAP passwords with. This package cannot
  // depend on libsodium (kept dep-light), so the length check is done with
  // plain `Buffer.from(v, "base64")` rather than the real secretbox key size
  // constant; packages/db/src/crypto.ts re-validates with libsodium's own
  // constant and throws CryptoError if the two ever disagree.
  CAREERHQ_MASTER_KEY: z
    .string()
    .optional()
    .refine(
      (v) => {
        const trimmed = v?.trim();
        if (!trimmed) return true;
        return Buffer.from(trimmed, "base64").length === 32;
      },
      {
        message:
          "CAREERHQ_MASTER_KEY must be a base64-encoded 32-byte key — generate one with: "
          + "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
      },
    ),
});

export interface AppConfig {
  databaseUrl: string;
  submissionsLiveEmail: boolean;
  submissionsLiveCompanySite: boolean;
  sandboxForceSafe: boolean;
  /** Never empty: the only SMTP host a sandbox workspace may submit to. */
  sandboxSmtpAllowedHost: string;
  followUpDays: number;
  /** Always absolute: relative FILE_STORAGE_DIR values resolve against the repo root. */
  fileStorageDir: string;
  /** null (default) keeps AI features off — the deterministic floor when no key is provisioned. */
  openrouterApiKey: string | null;
  /** Never empty: an unset or blank AI_FAST_MODELS yields the default list. */
  aiFastModels: string[];
  /** Never empty: an unset or blank AI_WRITING_MODELS yields the default list. */
  aiWritingModels: string[];
  ingestCron: string;
  /** Cron for the worker's IMAP poll; default every 15 minutes. */
  emailSyncCron: string;
  /** Controls the AI record/replay layer; default "live" makes real calls. */
  aiMode: AiMode;
  /** Always absolute: relative AI_REPLAY_DIR values resolve against the repo root. */
  aiReplayDir: string;
  /** null (default) disables email connections — no key to seal/open credentials with. */
  masterKey: string | null;
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
    sandboxSmtpAllowedHost: parsed.SANDBOX_SMTP_ALLOWED_HOST,
    followUpDays: parsed.FOLLOW_UP_DAYS,
    fileStorageDir: parsed.FILE_STORAGE_DIR,
    openrouterApiKey: optionalString(parsed.OPENROUTER_API_KEY),
    aiFastModels: parsed.AI_FAST_MODELS,
    aiWritingModels: parsed.AI_WRITING_MODELS,
    ingestCron: parsed.INGEST_CRON,
    emailSyncCron: parsed.EMAIL_SYNC_CRON,
    aiMode: parsed.AI_MODE,
    aiReplayDir: parsed.AI_REPLAY_DIR,
    masterKey: optionalString(parsed.CAREERHQ_MASTER_KEY),
  };
}
