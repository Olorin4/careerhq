import { describe, expect, it, vi } from "vitest";

// A launch failure has no click to be ambiguous about, so `openSession` must
// never report it as "timeout" — that kind parks the attempt NEEDS_RECONCILE
// ("the click may have landed") for a browser that never existed. This file
// mocks playwright so it can make `chromium.launch` fail both ways; the
// real-browser suite lives in driver.test.ts.
class FakeTimeoutError extends Error {}

vi.mock("playwright", () => ({
  chromium: { launch: vi.fn() },
  errors: { TimeoutError: FakeTimeoutError },
}));

const { chromium } = await import("playwright");
const { DriverError, openSession } = await import("./driver.js");

describe("openSession launch failures", () => {
  it("reports a plain launch failure as pre-click kind navigation", async () => {
    vi.mocked(chromium.launch).mockRejectedValueOnce(
      new Error("browserType.launch: Executable doesn't exist\nsecond line of call log"),
    );
    const err = await openSession().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as InstanceType<typeof DriverError>).kind).toBe("navigation");
    // First line only — Playwright call logs never cross the boundary.
    expect((err as Error).message).not.toMatch(/second line/);
  });

  it("reports a launch TIMEOUT as kind navigation too — there was no click to be ambiguous about", async () => {
    vi.mocked(chromium.launch).mockRejectedValueOnce(new FakeTimeoutError("Timeout 30000ms exceeded"));
    const err = await openSession().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as InstanceType<typeof DriverError>).kind).toBe("navigation");
  });
});
