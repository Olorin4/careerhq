import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "@careerhq/config";
import type { RawFormPage } from "@careerhq/autoapply";
// Task 8's Playwright driver lives in the worker app (its Docker image is the
// one built with Chromium's browser binaries); this reaches it through the
// package export `@careerhq/worker/autoapply` (apps/worker/package.json's
// "exports", backed by apps/worker/src/autoapply/index.ts) rather than a
// relative import crossing the app boundary — `.dependency-cruiser.cjs`'s
// `no-relative-cross-app-*` rules enforce that a relative path here is a
// build-time error. Nothing here re-implements the driver — it only shapes
// `openSession`/`capturePage`/`fillAndSubmit`'s results into the
// `SiteDeps.capture`/`submit` contract `site-submission.ts` expects, and
// writes the raw screenshot buffer to disk (the one adapter step the
// orchestrator explicitly leaves to its caller — see Task 11's report).
import {
  acquireBrowserSlot, capturePage, configureBrowserLimit, fillAndSubmit, openSession,
  type BrowserSlot,
} from "@careerhq/worker/autoapply";
import {
  allowsCaptureTarget, allowsResolvedAddress, type CaptureTargetPolicy,
} from "@careerhq/autoapply/policy";
import { acquireHostBrowserSlot, type HostBrowserSlot } from "@careerhq/db";
import { safeExternalHref } from "./safe-url.js";
import type { SiteSubmitArgs, SiteSubmitResult } from "./site-submission.js";

/**
 * Tells this process's browser counter what the configured cap is (spec P6 §3).
 *
 * Called from every factory below rather than once from a wiring module,
 * because in Next.js there is no "once": each route entry is its own server
 * bundle with its own module instances, and whichever bundle reaches a browser
 * first must already know the number. The counter itself is shared — it lives
 * on `globalThis` (apps/worker/src/autoapply/browser-limit.ts) — so these calls
 * all write the same value to the same place, and the operation is idempotent.
 */
function applyBrowserLimit(config: AppConfig): void {
  configureBrowserLimit(config.autoapplyMaxConcurrentBrowsers);
}

/**
 * Both halves of the cap, in the order that costs least (roadmap, "Carried
 * beyond P6 → Operational").
 *
 * `acquireBrowserSlot` bounds this PROCESS; `acquireHostBrowserSlot`
 * (packages/db/src/host-lock.ts) bounds the HOST, because `web` and `worker`
 * are two processes with two counters and the demo box's RAM budget was sized
 * against a bounded number of Chromiums, not a bounded number per container.
 * The inner one is kept, not replaced: it costs no I/O, and it is the one that
 * still holds if the database is briefly unreachable.
 *
 * Local first, then host: a process that is already busy should not spend a
 * database round trip, nor deny the other container a host slot for the
 * microseconds before it discovers it has no room of its own. Neither lock ever
 * waits — `pg_try_advisory_lock` returns false rather than queueing, exactly as
 * the in-process counter throws rather than queueing — so taking them in this
 * order (and releasing in the reverse) cannot deadlock against a caller doing
 * the opposite.
 *
 * A refusal from either half is thrown, unwrapped: `site-submission.ts`
 * recognises `BrowserBusyError` and `HostBrowserBusyError` structurally by
 * `name` and maps both to the same pre-token "busy, try again" refusal.
 */
async function acquireBothSlots(config: AppConfig): Promise<HeldSlots> {
  const inProcess = acquireBrowserSlot();
  let host: HostBrowserSlot;
  try {
    host = await acquireHostBrowserSlot(config.databaseUrl, config.autoapplyMaxConcurrentBrowsers);
  } catch (err) {
    // The local slot goes straight back: holding it after the host refused
    // would make this process refuse ITSELF for the rest of its life.
    inProcess();
    throw err;
  }
  let released = false;
  return {
    slot: inProcess,
    release: async () => {
      if (released) return;
      released = true;
      // Nested, so a host release that rejects — the lock connection dropped —
      // still gives the in-process slot back. A leaked in-process slot refuses
      // every later visitor for the lifetime of the container.
      try { await host(); } finally { inProcess(); }
    },
  };
}

interface HeldSlots {
  /** The in-process slot, to hand to `openSession({ slot })` so it neither takes nor releases its own. */
  slot: BrowserSlot;
  /** Gives both back, host first. Idempotent, because both halves are. */
  release: () => Promise<void>;
}

/** The scoped form, for the callers whose browser use is exactly one function call. */
async function withBothSlots<T>(config: AppConfig, use: (slot: BrowserSlot) => Promise<T>): Promise<T> {
  const held = await acquireBothSlots(config);
  try {
    return await use(held.slot);
  } finally {
    await held.release();
  }
}

/**
 * The real `SiteDeps.capture`: opens a fresh headless Chromium session,
 * reads the page once, and closes it. A session per call rather than one
 * held open for the process lifetime — this runs inside Next.js server
 * actions, whose process may reload (dev) or run several workers (prod), so
 * there is no single lifetime to pin a shared browser handle to. Pooling a
 * browser across calls for throughput is Task 13's concern (the worker's own
 * background jobs), not the interactive review screen's.
 */
export function makeSiteCapture(
  config: AppConfig,
): (url: string, policy: CaptureTargetPolicy) => Promise<RawFormPage> {
  applyBrowserLimit(config);
  return async (url: string, policy: CaptureTargetPolicy) => {
    // Defence in depth, not the primary gate: `prepareSiteApplication` already
    // refused everything but http(s) on an allowed host before it called this
    // (`refuseCaptureTarget`). Repeating the protocol check here means a future
    // caller wired straight to the driver still cannot make the server read
    // `file:///…` — the hole the P6 task-2 review proved. Deliberately kept as
    // its own layer rather than collapsed into the orchestrator's check.
    if (safeExternalHref(url) === null) {
      throw new Error("refusing to open a non-http(s) URL");
    }
    return withBothSlots(config, async (slot) => {
      const session = await openSession({ slot });
      try {
        return await capturePage(session, url, {
          timeoutMs: config.autoapplyBrowserTimeoutMs,
          // The orchestrator's policy, carried down to where the redirects
          // happen: the same object it judged `url` with judges every hop.
          isNavigationAllowed: (target) => allowsCaptureTarget(target, policy),
          // …and the same object judges what each hop's host RESOLVES to, so a
          // name pointing at a private address is refused and the connection is
          // pinned to the addresses that were judged. Passed explicitly because
          // the driver's default cannot know that this workspace's allow-listed
          // target is a Docker service name whose private address is the point
          // (`demo-ats`) — see `defaultAddressPolicy`.
          isResolvedAddressAllowed: (target, address) => allowsResolvedAddress(target, address, policy),
        });
      } finally {
        await session.close();
      }
    });
  };
}

/**
 * One confirm's claim on the process's single browser (spec P6 §3).
 *
 * The bug this shape exists to close (P6 task-5 review, BLOCKING 1): the probe
 * used to take the concurrency slot and give it straight back, so a second
 * visitor could win it in the gap before `submit`'s own `openSession` — and
 * THAT refusal arrives after `beginSubmission`, i.e. after the confirmation
 * token is burned. Reproduced deterministically: the loser's attempt went
 * FAILED, its token came back `token_consumed`, and a FAILED attempt cannot be
 * re-previewed, so their only recovery was a whole new prepare. A refusal must
 * never cost a visitor their confirmation — the P5 H1(b) property.
 *
 * So the slot is taken ONCE, by the probe, and HELD across `beginSubmission`
 * and `submit`: whoever loses the race loses it at the probe, before the token,
 * and simply confirms again.
 *
 * The reservation is request-scoped — one per server action, closed over a
 * local, with no module or global state of its own (the COUNTER it draws on is
 * the global one, in apps/worker's browser-limit.ts, which is where "global"
 * belongs). `withSiteBrowserReservation` below is the only way to get one, so
 * the `finally` that gives the slot back cannot be forgotten at a call site; it
 * is also what covers the orchestrator's early returns between probe and submit
 * (`begin_refused` and friends).
 *
 * Note what is NOT here: `SiteDeps` is unchanged and `site-submission.ts` still
 * knows nothing about browsers or slots. The orchestrator only ever sees two
 * plain functions, exactly as before.
 */
export interface ReservedSiteDriver {
  /** `SiteDeps.probeDriver`: acquires the slot and KEEPS it. Throws `BrowserBusyError` when there is no room. */
  probeDriver: () => Promise<void>;
  /** `SiteDeps.submit`: drives the browser on the held slot (or takes its own if no probe ran). */
  submit: (args: SiteSubmitArgs) => Promise<SiteSubmitResult>;
}

/**
 * Runs `use` with a reserved driver and gives the slot back afterwards — on
 * every path, including a throw and every early return the orchestrator makes
 * between probe and submit. A caller that never probes releases nothing.
 */
export async function withSiteBrowserReservation<T>(
  config: AppConfig,
  use: (reserved: ReservedSiteDriver) => Promise<T>,
): Promise<T> {
  const reservation = siteBrowserReservation(config);
  try {
    return await use(reservation);
  } finally {
    await reservation.release();
  }
}

interface SiteBrowserReservation extends ReservedSiteDriver {
  /** Gives both slots back. Idempotent, and a no-op when nothing was ever acquired. */
  release: () => Promise<void>;
}

function siteBrowserReservation(config: AppConfig): SiteBrowserReservation {
  applyBrowserLimit(config);
  let held: HeldSlots | null = null;
  return {
    /**
     * A launch/close round trip that touches no page and no network, so
     * `confirmAndSubmitSite` learns whether this process can drive a browser
     * BEFORE it burns the confirmation token — an image without Chromium
     * refuses honestly instead of throwing inside `submit` and parking the
     * attempt for a click that never happened.
     *
     * `acquireBothSlots` answers the other half — "is there ROOM?", in this
     * process AND on this host — and its `BrowserBusyError` /
     * `HostBrowserBusyError` leaves here unwrapped, which is what
     * `confirmAndSubmitSite` maps to a pre-token refusal. Cheap by browser
     * standards, and paid once per confirm: a human-initiated action, not a hot
     * path.
     *
     * Both halves are taken HERE, at the probe, for the reason the whole
     * reservation exists: a refusal must land before `beginSubmission`. A host
     * slot taken later — inside `submit` — would put a `worker` container's
     * Chromium in a position to refuse a confirm whose token was already spent.
     */
    probeDriver: async () => {
      // A second probe on the same reservation reuses the slots rather than
      // deadlocking against itself (the host lock is re-entrant per connection,
      // so a second acquire would take a SECOND slot and never give it back).
      held ??= await acquireBothSlots(config);
      const session = await openSession({ slot: held.slot });
      await session.close();
    },
    // A caller that wires `submit` without ever probing still gets both halves
    // of the cap — taken for this call and given back after it. Without this
    // branch that path would fall through to the per-process counter alone,
    // which is precisely the gap the host lock exists to close.
    submit: (args) => (
      held
        ? runSiteSubmit(config, args, held.slot)
        : withBothSlots(config, (slot) => runSiteSubmit(config, args, slot))
    ),
    release: async () => {
      const reserved = held;
      held = null;
      await reserved?.release();
    },
  };
}

/**
 * The real `SiteDeps.submit`: fills the form, clicks Submit exactly once, and
 * stores the confirmation screenshot under `fileStorageDir` — the driver
 * itself only returns the PNG bytes, never touches disk.
 *
 * Standalone (no reservation), for callers that drive a submission without the
 * confirm path's probe — the full-stack suite in site-e2e.test.ts. The
 * interactive path goes through `siteBrowserReservation` above.
 */
export function makeSiteSubmit(config: AppConfig): (args: SiteSubmitArgs) => Promise<SiteSubmitResult> {
  applyBrowserLimit(config);
  // Takes both halves of the cap for exactly this call: with no reservation
  // above it there is no confirmation token in flight, so a busy refusal here
  // costs nothing and the scoped form is the right shape.
  return (args: SiteSubmitArgs) => withBothSlots(config, (slot) => runSiteSubmit(config, args, slot));
}

/** Drives the browser on the caller's slot, and leaves releasing it — both halves — to them. */
async function runSiteSubmit(
  config: AppConfig,
  args: SiteSubmitArgs,
  slot: BrowserSlot,
): Promise<SiteSubmitResult> {
  const session = await openSession({ slot });
  try {
    const result = await fillAndSubmit(session, {
      url: args.url,
      form: args.form,
      answers: args.answers,
      files: args.files,
      deps: {
        timeoutMs: config.autoapplyBrowserTimeoutMs,
        isNavigationAllowed: (target) => allowsCaptureTarget(target, args.policy),
        isResolvedAddressAllowed: (target, address) => allowsResolvedAddress(target, address, args.policy),
      },
    });

    // The demo's ceiling on this store is NOT checked here, on purpose.
    //
    // This line runs after the submit click: the application is already in, so
    // a refusal at this point would either throw away the only evidence of a
    // real submission or leave an attempt whose receipt names a screenshot
    // that was never written. The check belongs where nothing has been spent —
    // `confirmAndSubmitSite`'s `reserveEvidenceScreenshot`, which runs before
    // the token is burned and before the browser is asked for a page, and
    // which also reclaims the orphans this directory accumulates across the
    // six-hourly demo reset (`@careerhq/core/storage`). This write is
    // unconditional by design.
    const dir = path.join(config.fileStorageDir, "site-screenshots");
    await mkdir(dir, { recursive: true });
    const screenshotPath = path.join(dir, `${randomUUID()}.png`);
    await writeFile(screenshotPath, result.screenshotPng);

    return {
      confirmationId: result.confirmationId,
      finalUrl: result.finalUrl,
      screenshotPath,
      pageText: result.pageText,
    };
  } finally {
    await session.close();
  }
}
