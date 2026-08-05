import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

import {
  configureHostBrowserLockClass, createHostBrowserSlotLock, resetHostBrowserSlots,
} from "@careerhq/db";
import type { ReservedSiteDriver } from "./site-driver.js";

const { withSiteBrowserReservation } = await import("./site-driver.js");

/**
 * A real database, because the cap has two halves now and only one of them
 * lives in this process: `acquireBothSlots` takes the in-process counter AND a
 * `pg_try_advisory_lock` on the host (packages/db/src/host-lock.ts). A fake
 * DATABASE_URL would make every assertion below fail on a connection error
 * rather than on the property it is about.
 */
const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

// This file's own advisory-lock namespace. The host lock is host-wide by
// design, which means every browser-driving test file in the monorepo would
// otherwise contend for one slot against a single shared `TEST_DATABASE_URL` —
// turbo runs the packages' test tasks concurrently, and a suite proving "the
// second acquirer is refused" would start passing because a suite in another
// process happened to be holding the slot. Per-file namespaces restore the
// independence the per-process counter used to give these tests for free.
const lockClass = 910_000_000 + Math.floor(Math.random() * 10_000_000);

beforeAll(async () => {
  if (!url) return;
  await configureHostBrowserLockClass(lockClass);
});

afterAll(async () => {
  await resetHostBrowserSlots();
});

function config(): AppConfig {
  return loadConfig({ DATABASE_URL: url ?? "" });
}

/** Enough of a `SiteSubmitArgs` to reach `openSession`; the page work fails right after. */
const submitArgs = {
  url: "http://demo-ats:3001/lever/jobs/eng-2",
  form: { url: "http://demo-ats:3001/lever/jobs/eng-2", fields: [], totalSteps: 1 } as unknown as CanonicalForm,
  answers: [],
  files: {},
  policy: { workspaceKind: "sandbox" as const, sandboxSiteAllowedHost: "demo-ats" },
};

// Either half of the cap refusing: the in-process counter's `BrowserBusyError`
// or the host lock's `HostBrowserBusyError`. Which one wins the race is not
// what these tests are about — that a second confirm is refused is.
const isBusy = (err: unknown): boolean =>
  err instanceof Error && (err.name === "BrowserBusyError" || err.name === "HostBrowserBusyError");

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

d("withSiteBrowserReservation", () => {
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

  /**
   * The half the in-process counter cannot see, and the reason the host lock
   * exists (roadmap, "Carried beyond P6 → Operational"): `worker` is a second
   * process with its own counter, so before this the box could hold two
   * Chromiums while both processes honestly reported "one".
   *
   * The stand-in for that second process is a second Postgres CONNECTION —
   * which is exactly what makes it a stand-in and not a mock. `web`'s counter
   * here is completely free in both directions below; the only thing refusing
   * is the advisory lock.
   */
  it("refuses a confirm when another PROCESS on this host holds the browser", async () => {
    const worker = createHostBrowserSlotLock(url!, { lockClass });
    try {
      const workersBrowser = await worker.acquire(1);

      const refused = await withSiteBrowserReservation(config(), async (reserved) => {
        try {
          await reserved.probeDriver();
          return false;
        } catch (err) {
          if (isBusy(err)) return true;
          throw err;
        }
      });
      // This process's own counter said yes — nothing in it is held. The
      // refusal came from the host.
      expect(refused).toBe(true);

      await workersBrowser();
      // …and the moment the other process is done, this one can proceed.
      expect(await slotIsFree()).toBe(true);
    } finally {
      await worker.close();
    }
  });

  it("denies the other process a browser for as long as a confirm is running", async () => {
    const worker = createHostBrowserSlotLock(url!, { lockClass });
    try {
      let workerRefused: unknown;
      await withSiteBrowserReservation(config(), async (reserved) => {
        await reserved.probeDriver();
        workerRefused = await worker.acquire(1).then(() => false, (err: unknown) => err);
      });
      expect((workerRefused as Error).name).toBe("HostBrowserBusyError");

      // The reservation has ended, so the slot is genuinely back — a lock the
      // release forgot would show up here as a permanent refusal.
      const workersBrowser = await worker.acquire(1);
      await workersBrowser();
    } finally {
      await worker.close();
    }
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
