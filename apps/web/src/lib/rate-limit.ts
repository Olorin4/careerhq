import { loadConfig } from "@careerhq/config";

/**
 * A fixed-window counter, one window per named bucket. It exists for exactly
 * one reason (spec P6 §3): the hosted demo is a public URL on a shared 3.7 GB
 * VPS, and a visitor holding down a button must not be able to spend the box's
 * CPU, its browser slot or its database on behalf of everyone else.
 *
 * The counters hang off `globalThis` behind a registered symbol, NOT off a
 * module-level `const`. That distinction is the whole point: Next.js emits a
 * separate server bundle per route entry, each with its own copy of every
 * module it reaches, so a module-level `Map` here is per BUNDLE, not per
 * process. The demo does run one web container — but "one container" was never
 * the scope that mattered. `generateDocument` is claimed by both the SSE route
 * (`app/api/generate/stream/route.js`) and `generateDocumentAction`
 * (`app/(dashboard)/applications/[id]/page.js`); with a module-level map those
 * were two counters, and the materials panel's own stream→action fallback
 * bought exactly twice the documented budget on the most expensive path in the
 * app (P6 task-3 review, B1 — proved by execution against `next start`).
 * `Symbol.for` resolves through the cross-realm global registry, so every
 * bundle in the process reaches the same Map. Anything added here that is used
 * from more than one route gets that for free.
 *
 * It is deliberately NOT a security boundary and never stands in for one: every
 * submission still passes the full gate matrix, the sandbox host allow-list and
 * SANDBOX_FORCE_SAFE. This layer only decides how OFTEN a caller may ask. It is
 * also per-process, not per-visitor: a second web process (or a second replica)
 * would get its own budget, which is fine for the demo's single container and
 * would not be for a real quota.
 *
 * The map is bounded by the number of distinct bucket names — one per action,
 * a compile-time constant — so it never grows with traffic and needs no
 * eviction pass.
 */
export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

export interface RateLimitOptions {
  /** Calls allowed inside one window. */
  limit: number;
  /** Window length; default 60s. */
  windowMs?: number;
  /** Injected in tests; defaults to `Date.now()`. */
  now?: number;
}

/** What the config default (30/min) is expressed against. */
const DEFAULT_WINDOW_MS = 60_000;

interface Window {
  startedAt: number;
  count: number;
}

/**
 * The global registry key the counters live under. Exported so the tests can
 * assert on the slot directly — if this module ever goes back to a
 * module-level `Map`, `rate-limit.test.ts`'s cross-bundle test goes red.
 */
export const RATE_LIMIT_WINDOWS_KEY = Symbol.for("careerhq.web.rateLimitWindows");

type WindowStore = Map<string, Window>;
type GlobalWithWindows = typeof globalThis & { [RATE_LIMIT_WINDOWS_KEY]?: WindowStore };

function windowStore(): WindowStore {
  const globals = globalThis as GlobalWithWindows;
  const existing = globals[RATE_LIMIT_WINDOWS_KEY];
  if (existing) return existing;
  const created: WindowStore = new Map();
  globals[RATE_LIMIT_WINDOWS_KEY] = created;
  return created;
}

export function checkRateLimit(bucket: string, opts: RateLimitOptions): RateLimitResult {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const now = opts.now ?? Date.now();
  const windows = windowStore();

  const current = windows.get(bucket);
  if (!current || now - current.startedAt >= windowMs) {
    windows.set(bucket, { startedAt: now, count: 1 });
    return { ok: true };
  }
  if (current.count >= opts.limit) {
    // Rounded up and never below 1: "try again in 0s" reads as "try again now",
    // which is the one thing the caller must not do.
    const retryAfterSeconds = Math.max(1, Math.ceil((current.startedAt + windowMs - now) / 1000));
    return { ok: false, retryAfterSeconds };
  }
  current.count += 1;
  return { ok: true };
}

/** Test hook: drops every window so suites cannot leak counts into each other. */
export function clearRateLimits(): void {
  windowStore().clear();
}

/** The slice of `AppConfig` this module reads; keeps the test callers honest and small. */
export interface DemoRateLimitConfig {
  demoMode: boolean;
  demoRateLimitPerMin: number;
}

/**
 * Buckets whose call is not a cheap row write but a whole *process*: the two
 * that launch a headless Chromium in-process (`prepareSiteApplication` reads a
 * live page, `confirmAndSubmitSite` fills and submits one), the one that calls
 * a model, and `uploadCv` — the only action that writes a visitor's bytes to
 * the host's filesystem. `DEMO_RATE_LIMIT_PER_MIN`'s default of 30 is sized
 * for click-y row writes; thirty Chromium launches a minute on a 3.7 GB VPS
 * that also runs the owner's other production services is not a ceiling that
 * protects anything (P6 task-3 review, advisory D), and neither is thirty
 * multi-megabyte writes a minute onto its shared disk (advisory B).
 *
 * The rate is only half of what `uploadCv` needs — a rate bounds how often,
 * not how much — so it also carries a hard store ceiling; see
 * `apps/web/src/lib/cv-storage.ts`.
 *
 * A cap rather than a replacement — `Math.min` below — so lowering
 * DEMO_RATE_LIMIT_PER_MIN still lowers these too, and an operator who wants
 * them lower than 5 sets the one variable they already have.
 */
const HEAVY_BUCKET_LIMIT_PER_MIN = 5;
const HEAVY_BUCKETS: ReadonlySet<string> = new Set([
  "prepareSiteApplication",
  "confirmAndSubmitSite",
  "generateDocument",
  "uploadCv",
]);

/**
 * The one call every mutating server action makes, before it touches anything.
 * Returns null when the call may proceed, or the reason to hand back in the
 * action's own failure shape — actions report this, they never throw it.
 *
 * Off outside demo mode by construction: a personal, self-hosted install is
 * one user on their own machine and is never throttled.
 */
export function demoRateLimit(bucket: string, config: DemoRateLimitConfig = loadConfig()): string | null {
  if (!config.demoMode) return null;
  const limit = HEAVY_BUCKETS.has(bucket)
    ? Math.min(config.demoRateLimitPerMin, HEAVY_BUCKET_LIMIT_PER_MIN)
    : config.demoRateLimitPerMin;
  const result = checkRateLimit(bucket, { limit });
  if (result.ok) return null;
  return `too many requests, try again in ${result.retryAfterSeconds}s`;
}
