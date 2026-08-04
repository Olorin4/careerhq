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

/**
 * The two model tiers, in the order the sequential fallback tries them
 * (ADR-0003). Every id below was verified by actually running this repo's own
 * prompts against it three times, not by reading the OpenRouter catalogue: the
 * previous defaults were four `:free` ids that OpenRouter has since retired,
 * and they answered `http_404` on every call while the README still advertised
 * them. Two lessons are encoded here. `:free` aliases churn, so the defaults
 * are cheap-but-stable paid ids instead (fractions of a cent per call — a
 * re-rank costs about $0.00005). And a model that passes one tier can still
 * fail the other: `google/gemini-2.5-flash-lite` re-ranks and classifies
 * flawlessly but returns generation's `confidence` as a *string*, which the
 * grounding schema rejects, so it is deliberately absent from the writing
 * tier. If you swap an id, run both tiers' prompts before trusting it.
 *
 * The lists stay env-overridable for exactly the reason they went stale — see
 * ADR-0003 §"Model lists are env configuration, not code".
 */
const DEFAULT_AI_FAST_MODELS = [
  "google/gemini-2.5-flash-lite",
  "qwen/qwen3-30b-a3b-instruct-2507",
  "meta-llama/llama-3.3-70b-instruct",
];

/**
 * The writing tier's first entry is also the only one the streaming generation
 * endpoint uses (`aiWritingModels[0]`), so it is verified streaming as well as
 * buffered. `deepseek/deepseek-v4-flash` is the undated alias on purpose: the
 * dated snapshots are the ids that disappear.
 */
const DEFAULT_AI_WRITING_MODELS = [
  "deepseek/deepseek-v4-flash",
  "qwen/qwen3-30b-a3b-instruct-2507",
  "meta-llama/llama-3.3-70b-instruct",
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

/** The compose service name of the fictional ATS (apps/demo-ats). */
const DEFAULT_DEMO_ATS_URL = "http://demo-ats:3001";

/**
 * The compose service name of the fictional ATS, as a bare hostname. A sandbox
 * workspace may only auto-apply to this host (spec §11's `sandbox_blocked`
 * gate for the company-site channel), so — like the SMTP allow-list — the
 * default has to name something that cannot reach a real employer. Compared
 * against the target URL's `hostname`, which carries no port: the port is not
 * a safety boundary, and the user retypes the host, not "demo-ats:3001".
 */
const DEFAULT_SANDBOX_SITE_HOST = "demo-ats";

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
  // Puts the app on the sandbox workspace (spec P6 §3): web resolves
  // "CareerHQ Demo" instead of the personal workspace, credential setup
  // refuses server-side, and the layout shows the non-dismissible banner.
  // Off by default, like every other gate in this file.
  DEMO_MODE: boolFromEnv,
  // How many times a single mutating action may run per minute in demo mode
  // (apps/web/src/lib/rate-limit.ts). Only consulted when DEMO_MODE is on —
  // a personal install is never throttled — but parsed always, so a nonsense
  // value fails at startup rather than the first time a visitor clicks.
  DEMO_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(30),
  // Compared against a connection's SMTP host by the sandbox gate. An empty
  // value (what Compose passes for an unset variable) must not become an empty
  // allow-list entry — it falls back to the default, like the model lists.
  SANDBOX_SMTP_ALLOWED_HOST: z
    .string()
    .default(DEFAULT_SANDBOX_SMTP_HOST)
    .transform((v) => v.trim() || DEFAULT_SANDBOX_SMTP_HOST),
  // The company-site equivalent, compared against the target URL's hostname.
  // Same empty-value rule: Compose passes "" for anything the user never set.
  SANDBOX_SITE_ALLOWED_HOST: z
    .string()
    .default(DEFAULT_SANDBOX_SITE_HOST)
    .transform((v) => v.trim() || DEFAULT_SANDBOX_SITE_HOST),
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
  // How often the worker wipes and reseeds the demo workspace. Only scheduled
  // when DEMO_MODE is on (apps/worker/src/main.ts) — a personal deployment must
  // never register a job that deletes data — but parsed always, like the other
  // crons, so a typo fails at startup rather than six hours later.
  DEMO_RESET_CRON: z.string().default("0 */6 * * *"),
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
  // Auto-apply (spec §10). The browser budget covers one navigation or one
  // field action in the Playwright driver, not the whole attempt — a real ATS
  // page with a slow embed regularly needs more than a default 30s.
  AUTOAPPLY_BROWSER_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
  // How many headless Chromium instances one process may have open at once
  // (apps/worker/src/autoapply/browser-limit.ts). Spec P6 §3's "Chromium runs
  // one at a time, globally": a browser is the most expensive thing this app
  // does, and the demo shares a 3.7 GB box with the owner's other services.
  // Read by BOTH web and worker — each launches browsers of its own.
  AUTOAPPLY_MAX_CONCURRENT_BROWSERS: z.coerce.number().int().positive().default(1),
  // The fictional ATS (apps/demo-ats): the only site auto-apply demos target.
  // Compose's service name is the default; a local run points at localhost.
  DEMO_ATS_URL: z
    .string()
    .default(DEFAULT_DEMO_ATS_URL)
    .transform((v) => v.trim().replace(/\/+$/, "") || DEFAULT_DEMO_ATS_URL)
    .refine(
      (v) => {
        // Not `URL.canParse`: it accepts "demo-ats:3001" (scheme "demo-ats"),
        // which is the exact typo a "host:port" habit produces here.
        try {
          const url = new URL(v);
          return url.protocol === "http:" || url.protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "DEMO_ATS_URL must be an http(s) URL, e.g. http://localhost:3001" },
    ),
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
  /** Puts the app on the sandbox workspace and disables credential setup; default false. */
  demoMode: boolean;
  /** Per-action, per-minute call budget applied only in demo mode; default 30. */
  demoRateLimitPerMin: number;
  /** Never empty: the only SMTP host a sandbox workspace may submit to. */
  sandboxSmtpAllowedHost: string;
  /** Never empty: the only site hostname a sandbox workspace may auto-apply to. */
  sandboxSiteAllowedHost: string;
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
  /** Cron for the demo workspace reseed; scheduled only in demo mode, default every 6 hours. */
  demoResetCron: string;
  /** Controls the AI record/replay layer; default "live" makes real calls. */
  aiMode: AiMode;
  /** Always absolute: relative AI_REPLAY_DIR values resolve against the repo root. */
  aiReplayDir: string;
  /** null (default) disables email connections — no key to seal/open credentials with. */
  masterKey: string | null;
  /** Per-action budget for the Playwright auto-apply driver; default 45s. */
  autoapplyBrowserTimeoutMs: number;
  /** Headless browsers one process may hold open at once; default 1, never 0. */
  autoapplyMaxConcurrentBrowsers: number;
  /** Never empty and never trailing-slashed: base URL of the demo ATS. */
  demoAtsUrl: string;
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
    demoMode: parsed.DEMO_MODE,
    demoRateLimitPerMin: parsed.DEMO_RATE_LIMIT_PER_MIN,
    sandboxSmtpAllowedHost: parsed.SANDBOX_SMTP_ALLOWED_HOST,
    sandboxSiteAllowedHost: parsed.SANDBOX_SITE_ALLOWED_HOST,
    followUpDays: parsed.FOLLOW_UP_DAYS,
    fileStorageDir: parsed.FILE_STORAGE_DIR,
    openrouterApiKey: optionalString(parsed.OPENROUTER_API_KEY),
    aiFastModels: parsed.AI_FAST_MODELS,
    aiWritingModels: parsed.AI_WRITING_MODELS,
    ingestCron: parsed.INGEST_CRON,
    emailSyncCron: parsed.EMAIL_SYNC_CRON,
    demoResetCron: parsed.DEMO_RESET_CRON,
    aiMode: parsed.AI_MODE,
    aiReplayDir: parsed.AI_REPLAY_DIR,
    masterKey: optionalString(parsed.CAREERHQ_MASTER_KEY),
    autoapplyBrowserTimeoutMs: parsed.AUTOAPPLY_BROWSER_TIMEOUT_MS,
    autoapplyMaxConcurrentBrowsers: parsed.AUTOAPPLY_MAX_CONCURRENT_BROWSERS,
    demoAtsUrl: parsed.DEMO_ATS_URL,
  };
}
