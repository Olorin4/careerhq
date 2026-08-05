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
    const session = await openSession();
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
    reservation.release();
  }
}

interface SiteBrowserReservation extends ReservedSiteDriver {
  /** Gives the slot back. Idempotent, and a no-op when nothing was ever acquired. */
  release: () => void;
}

function siteBrowserReservation(config: AppConfig): SiteBrowserReservation {
  applyBrowserLimit(config);
  let slot: BrowserSlot | null = null;
  return {
    /**
     * A launch/close round trip that touches no page and no network, so
     * `confirmAndSubmitSite` learns whether this process can drive a browser
     * BEFORE it burns the confirmation token — an image without Chromium
     * refuses honestly instead of throwing inside `submit` and parking the
     * attempt for a click that never happened.
     *
     * `acquireBrowserSlot` answers the other half — "is there ROOM?" — and its
     * `BrowserBusyError` leaves here unwrapped, which is what
     * `confirmAndSubmitSite` maps to a pre-token refusal. Cheap by browser
     * standards, and paid once per confirm: a human-initiated action, not a hot
     * path.
     */
    probeDriver: async () => {
      // `??=`: a second probe on the same reservation reuses the slot rather
      // than deadlocking against itself.
      slot ??= acquireBrowserSlot();
      const session = await openSession({ slot });
      await session.close();
    },
    submit: (args) => runSiteSubmit(config, args, slot),
    release: () => {
      const held = slot;
      slot = null;
      held?.();
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
  return (args: SiteSubmitArgs) => runSiteSubmit(config, args, null);
}

/** `slot` non-null → drive the browser on the caller's reservation and leave releasing it to them. */
async function runSiteSubmit(
  config: AppConfig,
  args: SiteSubmitArgs,
  slot: BrowserSlot | null,
): Promise<SiteSubmitResult> {
  const session = await openSession(slot ? { slot } : {});
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
