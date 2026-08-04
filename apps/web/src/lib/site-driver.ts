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
import { capturePage, configureBrowserLimit, fillAndSubmit, openSession } from "@careerhq/worker/autoapply";
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
export function makeSiteCapture(config: AppConfig): (url: string) => Promise<RawFormPage> {
  applyBrowserLimit(config);
  return async (url: string) => {
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
      return await capturePage(session, url, { timeoutMs: config.autoapplyBrowserTimeoutMs });
    } finally {
      await session.close();
    }
  };
}

/**
 * The real `SiteDeps.probeDriver`: launches a browser and closes it again,
 * touching no page and no network. It exists so `confirmAndSubmitSite` can find
 * out whether this process can drive a browser BEFORE it burns the confirmation
 * token — the same `openSession()` call `makeSiteSubmit` makes, just early
 * enough that its failure is a plain refusal instead of an attempt parked
 * NEEDS_RECONCILE for a click that never happened.
 *
 * Cheap by browser standards (a launch/close round trip, no navigation) and
 * paid once per confirm, which is a human-initiated action, not a hot path.
 *
 * It also answers "is there ROOM for a browser?", because `openSession` takes
 * the concurrency slot before it launches: a busy process fails this probe with
 * `BrowserBusyError`, which `confirmAndSubmitSite` turns into a refusal while
 * the confirmation token is still unburned. `config` is taken only to apply the
 * configured cap — the probe reads nothing else from it.
 */
export function makeDriverProbe(config: AppConfig): () => Promise<void> {
  applyBrowserLimit(config);
  return async () => {
    const session = await openSession();
    await session.close();
  };
}

/**
 * The real `SiteDeps.submit`: fills the form, clicks Submit exactly once, and
 * stores the confirmation screenshot under `fileStorageDir` — the driver
 * itself only returns the PNG bytes, never touches disk.
 */
export function makeSiteSubmit(config: AppConfig): (args: SiteSubmitArgs) => Promise<SiteSubmitResult> {
  applyBrowserLimit(config);
  return async (args: SiteSubmitArgs) => {
    const session = await openSession();
    try {
      const result = await fillAndSubmit(session, {
        url: args.url,
        form: args.form,
        answers: args.answers,
        files: args.files,
        deps: { timeoutMs: config.autoapplyBrowserTimeoutMs },
      });

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
  };
}
