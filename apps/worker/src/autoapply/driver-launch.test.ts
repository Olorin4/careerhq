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
const { BROWSER_CLOSE_BUDGET_MS, DriverError, openSession } = await import("./driver.js");
const { acquireBrowserSlot, BrowserBusyError, browserSlotsInUse, configureBrowserLimit, resetBrowserLimit } =
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

  // A `close()` that never settles used to hold the process's only slot for
  // ever: the `finally` runs on a rejection but not on a hang, and Playwright's
  // close has no timeout of its own. One wedged Chromium on the demo box was
  // indistinguishable from auto-apply being broken until the container
  // restarted. Leaking the process is survivable; leaking the slot is not.
  it("frees the slot when browser.close() never settles", async () => {
    configureBrowserLimit(1);
    vi.mocked(chromium.launch).mockResolvedValueOnce({
      ...fakeBrowser(),
      close: () => new Promise<void>(() => undefined),
    } as never);
    const session = await openSession();

    vi.useFakeTimers();
    try {
      const closing = session.close();
      expect(browserSlotsInUse()).toBe(1);
      await vi.advanceTimersByTimeAsync(BROWSER_CLOSE_BUDGET_MS);
      await closing;
    } finally {
      vi.useRealTimers();
    }
    expect(browserSlotsInUse()).toBe(0);
    // And the slot is genuinely usable again, not merely counted down.
    vi.mocked(chromium.launch).mockResolvedValueOnce(fakeBrowser() as never);
    await (await openSession()).close();
  });
});

// The reservation seam (P6 task-5 review, BLOCKING 1): apps/web takes ONE slot
// for a whole confirm — probe, `beginSubmission`, submit — so the loser of a
// race is refused before the confirmation token is burned. That only works if a
// session opened on a caller's slot neither takes a second one nor gives the
// caller's away.
describe("openSession on a caller-held slot", () => {
  const fakeBrowser = (): { newPage: () => Promise<never>; close: () => Promise<void> } => ({
    newPage: () => Promise.reject(new Error("not used")),
    close: async () => undefined,
  });

  it("opens two sessions in a row on one held slot, and never releases it", async () => {
    configureBrowserLimit(1);
    const slot = acquireBrowserSlot();
    expect(browserSlotsInUse()).toBe(1);

    // Twice, because a confirm really does open two: the probe's launch/close
    // round trip, then the submit's.
    for (let round = 0; round < 2; round += 1) {
      vi.mocked(chromium.launch).mockResolvedValueOnce(fakeBrowser() as never);
      const session = await openSession({ slot });
      await session.close();
      // Still held: `close()` must not hand back what it did not take.
      expect(browserSlotsInUse()).toBe(1);
    }
    // …and nothing else may have one meanwhile.
    expect(() => acquireBrowserSlot()).toThrow(BrowserBusyError);

    slot();
    expect(browserSlotsInUse()).toBe(0);
  });

  it("leaves the caller's slot held when the launch fails", async () => {
    configureBrowserLimit(1);
    const slot = acquireBrowserSlot();
    vi.mocked(chromium.launch).mockRejectedValueOnce(new Error("browserType.launch: nope"));
    await expect(openSession({ slot })).rejects.toBeInstanceOf(DriverError);
    // The launch-failure path releases the slot it acquired ITSELF; a caller's
    // reservation is the caller's to end, in its own `finally`.
    expect(browserSlotsInUse()).toBe(1);
    slot();
    expect(browserSlotsInUse()).toBe(0);
  });
});
