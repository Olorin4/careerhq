import { loadConfig } from "@careerhq/config";

/**
 * A fixed-window counter, one window per named bucket, held in this module's
 * memory. It exists for exactly one reason (spec P6 §3): the hosted demo is a
 * public URL on a shared 3.7 GB VPS, and a visitor holding down a button must
 * not be able to spend the box's CPU, its browser slot or its database on
 * behalf of everyone else.
 *
 * Single-process is the right scope here — the demo runs one web container, so
 * there is nothing to share the counters with. It is deliberately NOT a
 * security boundary and never stands in for one: every submission still passes
 * the full gate matrix, the sandbox host allow-list and SANDBOX_FORCE_SAFE.
 * This layer only decides how OFTEN a caller may ask.
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

const windows = new Map<string, Window>();

export function checkRateLimit(bucket: string, opts: RateLimitOptions): RateLimitResult {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const now = opts.now ?? Date.now();

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
  windows.clear();
}

/** The slice of `AppConfig` this module reads; keeps the test callers honest and small. */
export interface DemoRateLimitConfig {
  demoMode: boolean;
  demoRateLimitPerMin: number;
}

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
  const result = checkRateLimit(bucket, { limit: config.demoRateLimitPerMin });
  if (result.ok) return null;
  return `too many requests, try again in ${result.retryAfterSeconds}s`;
}
