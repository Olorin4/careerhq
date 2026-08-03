import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "@careerhq/config";
import type { RawFormPage } from "@careerhq/autoapply";
// Task 8's Playwright driver lives in the worker app (its Docker image is the
// one built with Chromium's browser binaries); this reaches across the app
// boundary by relative path rather than duplicating ~300 lines of extraction
// and fill logic a second time. Nothing here re-implements the driver — it
// only shapes `openSession`/`capturePage`/`fillAndSubmit`'s results into the
// `SiteDeps.capture`/`submit` contract `site-submission.ts` expects, and
// writes the raw screenshot buffer to disk (the one adapter step the
// orchestrator explicitly leaves to its caller — see Task 11's report).
import { capturePage, fillAndSubmit, openSession } from "../../../worker/src/autoapply/driver.js";
import type { SiteSubmitArgs, SiteSubmitResult } from "./site-submission.js";

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
  return async (url: string) => {
    const session = await openSession();
    try {
      return await capturePage(session, url, { timeoutMs: config.autoapplyBrowserTimeoutMs });
    } finally {
      await session.close();
    }
  };
}

/**
 * The real `SiteDeps.submit`: fills the form, clicks Submit exactly once, and
 * stores the confirmation screenshot under `fileStorageDir` — the driver
 * itself only returns the PNG bytes, never touches disk.
 */
export function makeSiteSubmit(config: AppConfig): (args: SiteSubmitArgs) => Promise<SiteSubmitResult> {
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
