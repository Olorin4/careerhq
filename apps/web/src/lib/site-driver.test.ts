import { describe, expect, it, vi } from "vitest";
import { loadConfig, type AppConfig } from "@careerhq/config";
import type { CanonicalForm } from "@careerhq/contracts";

/**
 * The browser-slot lifetime of a confirm (spec P6 §3, and P6 task-5 review
 * BLOCKING 1). What is under test is WHO holds the process's single slot and
 * for how long — not what Chromium does with it — so `playwright` is mocked and
 * no browser is ever started. The slot counter itself is the real one
 * (apps/worker/src/autoapply/browser-limit.ts, reached through the same
 * `@careerhq/worker/autoapply` package export the driver adapter uses), because
 * a fake counter would prove nothing about the property that matters.
 *
 * The live-Chromium proof of the same seam is site-e2e.test.ts.
 */
class FakeTimeoutError extends Error {}
const launched: Array<{ closed: boolean }> = [];

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(async () => {
      const browser = { closed: false };
      launched.push(browser);
      return {
        newPage: () => Promise.reject(new Error("no page in this test")),
        close: async () => { browser.closed = true; },
      };
    }),
  },
  errors: { TimeoutError: FakeTimeoutError },
}));

import type { ReservedSiteDriver } from "./site-driver.js";

const { withSiteBrowserReservation } = await import("./site-driver.js");

function config(): AppConfig {
  return loadConfig({ DATABASE_URL: "postgres://u:p@localhost:5432/careerhq" });
}

/** Enough of a `SiteSubmitArgs` to reach `openSession`; the page work fails right after. */
const submitArgs = {
  url: "http://demo-ats:3001/lever/jobs/eng-2",
  form: { url: "http://demo-ats:3001/lever/jobs/eng-2", fields: [], totalSteps: 1 } as unknown as CanonicalForm,
  answers: [],
  files: {},
  policy: { workspaceKind: "sandbox" as const, sandboxSiteAllowedHost: "demo-ats" },
};

const isBusy = (err: unknown): boolean => err instanceof Error && err.name === "BrowserBusyError";

/** Whether a second, independent confirm could get a browser right now. */
async function slotIsFree(): Promise<boolean> {
  return withSiteBrowserReservation(config(), async (other) => {
    try {
      await other.probeDriver();
      return true;
    } catch (err) {
      if (isBusy(err)) return false;
      throw err;
    }
  });
}

describe("withSiteBrowserReservation", () => {
  it("holds the slot from the probe until the reservation ends", async () => {
    let refused: unknown;
    await withSiteBrowserReservation(config(), async (reserved) => {
      await reserved.probeDriver();
      // The whole fix: a second confirm arriving anywhere in here — including
      // the `beginSubmission` window the old probe left open — is refused.
      refused = await slotIsFree();
    });
    expect(refused).toBe(false);
    // …and the slot is back the moment the reservation ends.
    expect(await slotIsFree()).toBe(true);
  });

  it("submits on the slot the probe already holds, instead of asking for a second one", async () => {
    const err = await withSiteBrowserReservation(config(), async (reserved) => {
      await reserved.probeDriver();
      return reserved.submit(submitArgs).catch((e: unknown) => e);
    });
    // With `max = 1` and the probe's slot held, a `submit` that opened its own
    // session would be refused here — this getting as far as the page proves it
    // reused the reservation.
    expect(isBusy(err)).toBe(false);
    expect((err as Error).message).toMatch(/no page in this test/);
    expect(await slotIsFree()).toBe(true);
  });

  it("gives the slot back when the confirm throws after the probe", async () => {
    const boom = withSiteBrowserReservation(config(), async (reserved) => {
      await reserved.probeDriver();
      throw new Error("the orchestrator blew up mid-confirm");
    });
    await expect(boom).rejects.toThrow(/blew up mid-confirm/);
    expect(await slotIsFree()).toBe(true);
  });

  it("gives the slot back when the reservation returns early, before any submit", async () => {
    // `begin_refused` and every other early return between probe and submit:
    // the orchestrator simply returns, and the slot must not leak.
    const outcome = await withSiteBrowserReservation(config(), async (reserved) => {
      await reserved.probeDriver();
      return "blocked" as const;
    });
    expect(outcome).toBe("blocked");
    expect(await slotIsFree()).toBe(true);
  });

  it("closes every browser it opens, and releases nothing it never took", async () => {
    launched.length = 0;
    await withSiteBrowserReservation(config(), async (reserved: ReservedSiteDriver) => {
      await reserved.probeDriver();
    });
    expect(launched).toHaveLength(1);
    expect(launched[0]?.closed).toBe(true);

    // A reservation that never probes holds nothing, so ending it is a no-op —
    // this is the prepare path, which shares the wiring but never asks for a
    // browser slot of its own.
    await withSiteBrowserReservation(config(), async () => undefined);
    expect(await slotIsFree()).toBe(true);
  });
});
