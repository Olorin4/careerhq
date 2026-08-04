import { beforeEach, describe, expect, it } from "vitest";
import { checkRateLimit, clearRateLimits, demoRateLimit } from "./rate-limit.js";

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
});
