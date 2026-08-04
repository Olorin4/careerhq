import { beforeEach, describe, expect, it, vi } from "vitest";

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
const { BrowserBusyError, browserSlotsInUse, configureBrowserLimit, resetBrowserLimit } =
  await import("./browser-limit.js");

beforeEach(() => {
  resetBrowserLimit();
  vi.mocked(chromium.launch).mockClear();
});

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

  it("gives the slot back when the launch fails — a browser that never started holds nothing", async () => {
    configureBrowserLimit(1);
    vi.mocked(chromium.launch).mockRejectedValueOnce(new Error("browserType.launch: nope"));
    await expect(openSession()).rejects.toBeInstanceOf(DriverError);
    expect(browserSlotsInUse()).toBe(0);
  });
});

// The concurrency limit's enforcement point (spec P6 §3): `openSession` is the
// only place a Chromium process is started, so it is the only place the cap can
// be told the truth.
describe("openSession concurrency", () => {
  const fakeBrowser = (): { newPage: () => Promise<never>; close: () => Promise<void> } => ({
    newPage: () => Promise.reject(new Error("not used")),
    close: async () => undefined,
  });

  it("refuses a second concurrent session with BrowserBusyError, not a DriverError", async () => {
    configureBrowserLimit(1);
    vi.mocked(chromium.launch).mockResolvedValueOnce(fakeBrowser() as never);
    const session = await openSession();

    const err = await openSession().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserBusyError);
    // Distinct from a launch failure on purpose: apps/web tells the visitor
    // "busy, try again" rather than "the browser could not be started".
    expect(err).not.toBeInstanceOf(DriverError);
    // And it never got as far as asking playwright for a second browser.
    expect(vi.mocked(chromium.launch)).toHaveBeenCalledTimes(1);

    await session.close();
    expect(browserSlotsInUse()).toBe(0);
  });

  it("frees the slot even when closing the browser throws", async () => {
    configureBrowserLimit(1);
    vi.mocked(chromium.launch).mockResolvedValueOnce({
      ...fakeBrowser(),
      close: () => Promise.reject(new Error("browser.close: target closed")),
    } as never);
    const session = await openSession();
    await expect(session.close()).rejects.toThrow(/target closed/);
    expect(browserSlotsInUse()).toBe(0);
  });
});
