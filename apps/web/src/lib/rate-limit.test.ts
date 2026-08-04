import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkRateLimit, clearRateLimits, demoRateLimit, RATE_LIMIT_WINDOWS_KEY,
} from "./rate-limit.js";

describe("checkRateLimit", () => {
  beforeEach(() => clearRateLimits());

  it("allows up to the limit then refuses with a retry hint", () => {
    for (let i = 0; i < 3; i += 1) expect(checkRateLimit("b", { limit: 3, now: 1000 }).ok).toBe(true);
    const refused = checkRateLimit("b", { limit: 3, now: 1000 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("starts a fresh window after windowMs", () => {
    checkRateLimit("b", { limit: 1, now: 1000 });
    expect(checkRateLimit("b", { limit: 1, now: 1000 }).ok).toBe(false);
    expect(checkRateLimit("b", { limit: 1, now: 1000 + 60_000 }).ok).toBe(true);
  });

  it("keeps buckets independent", () => {
    checkRateLimit("a", { limit: 1, now: 1000 });
    expect(checkRateLimit("b", { limit: 1, now: 1000 }).ok).toBe(true);
  });

  it("counts down the retry hint as the window drains", () => {
    checkRateLimit("b", { limit: 1, now: 1000 });
    const refused = checkRateLimit("b", { limit: 1, now: 1000 + 59_000 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterSeconds).toBe(1);
  });
});

describe("demoRateLimit", () => {
  beforeEach(() => clearRateLimits());

  it("never throttles outside demo mode — personal self-hosted use is unlimited", () => {
    const config = { demoMode: false, demoRateLimitPerMin: 1 };
    for (let i = 0; i < 50; i += 1) expect(demoRateLimit("action", config)).toBeNull();
  });

  it("refuses past the configured per-minute limit in demo mode", () => {
    const config = { demoMode: true, demoRateLimitPerMin: 2 };
    expect(demoRateLimit("action", config)).toBeNull();
    expect(demoRateLimit("action", config)).toBeNull();
    expect(demoRateLimit("action", config)).toMatch(/too many requests, try again in \d+s/);
  });

  it("keeps each action's budget its own", () => {
    const config = { demoMode: true, demoRateLimitPerMin: 1 };
    expect(demoRateLimit("one", config)).toBeNull();
    expect(demoRateLimit("two", config)).toBeNull();
    expect(demoRateLimit("one", config)).not.toBeNull();
  });

  it("caps the browser- and model-launching buckets below a generous global limit", () => {
    const config = { demoMode: true, demoRateLimitPerMin: 30 };
    for (const bucket of ["prepareSiteApplication", "confirmAndSubmitSite", "generateDocument"]) {
      for (let i = 0; i < 5; i += 1) expect(demoRateLimit(bucket, config)).toBeNull();
      expect(demoRateLimit(bucket, config)).toMatch(/too many requests/);
    }
    // A cheap row write still gets the full configured budget.
    for (let i = 0; i < 30; i += 1) expect(demoRateLimit("dismissJob", config)).toBeNull();
    expect(demoRateLimit("dismissJob", config)).toMatch(/too many requests/);
  });

  it("still honours a configured limit lower than the heavy-bucket cap", () => {
    const config = { demoMode: true, demoRateLimitPerMin: 1 };
    expect(demoRateLimit("confirmAndSubmitSite", config)).toBeNull();
    expect(demoRateLimit("confirmAndSubmitSite", config)).toMatch(/too many requests/);
  });
});

/**
 * The seam the P6 task-3 review caught by execution and no test covered: the
 * SSE route (`app/api/generate/stream/route.ts`) and `generateDocumentAction`
 * (`applications/[id]/materials-actions.ts`) share the "generateDocument"
 * bucket, but Next.js compiles them into SEPARATE server bundles, each of which
 * gets its own copy of every module it imports. A module-level `Map` in
 * rate-limit.ts is therefore per bundle, not per process, and driving both
 * transports bought twice the budget on the most expensive path in the app.
 *
 * `vi.resetModules()` + a second dynamic import is the closest thing a vitest
 * suite has to a second bundle: it re-evaluates the module top to bottom,
 * producing a genuinely distinct module instance with distinct module-level
 * state. If the counters ever move back off `globalThis`, these go red.
 */
describe("cross-bundle sharing", () => {
  beforeEach(() => clearRateLimits());

  it("keeps the counters on globalThis, not in module scope", () => {
    const globals = globalThis as typeof globalThis & { [RATE_LIMIT_WINDOWS_KEY]?: Map<string, unknown> };
    checkRateLimit("onGlobal", { limit: 5, now: 1000 });
    expect(globals[RATE_LIMIT_WINDOWS_KEY]?.has("onGlobal")).toBe(true);
    clearRateLimits();
    expect(globals[RATE_LIMIT_WINDOWS_KEY]?.has("onGlobal")).toBe(false);
  });

  it("counts a second module instance's calls against the first one's budget", async () => {
    vi.resetModules();
    const bundleA = await import("./rate-limit.js");
    vi.resetModules();
    const bundleB = await import("./rate-limit.js");
    // Two genuinely different module instances, as the route bundle and the
    // page bundle are — not the same object handed back twice.
    expect(bundleA).not.toBe(bundleB);

    const config = { demoMode: true, demoRateLimitPerMin: 1 };
    expect(bundleA.demoRateLimit("generateDocument", config)).toBeNull();
    // Before the fix this was ALSO null: bundle B had its own empty Map, so the
    // panel's stream -> action fallback ran a second generation on a budget of one.
    expect(bundleB.demoRateLimit("generateDocument", config)).toMatch(/too many requests/);
    // …and the sharing goes both ways: B's refusal did not create a private window.
    expect(bundleA.demoRateLimit("generateDocument", config)).toMatch(/too many requests/);
  });
});
