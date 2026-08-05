"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { TEXT_LIMITS } from "@careerhq/contracts";
import { loadConfig } from "@careerhq/config";
import { getDb } from "../../../../lib/db.js";
import { describeZodIssue } from "../../../../lib/form-state.js";
import { demoRateLimit } from "../../../../lib/rate-limit.js";
import { makeSiteCapture, withSiteBrowserReservation } from "../../../../lib/site-driver.js";
import { getActiveWorkspace } from "../../../../lib/workspace.js";
import {
  confirmAndSubmitSite, prepareSiteApplication, previewSiteSubmission, updatePlannedAnswer,
  type PrepareOutcome, type SiteConfirmOutcome, type SiteDeps, type SitePreviewOutcome,
} from "../../../../lib/site-submission.js";

/**
 * Thin, zod-validated wrappers around the Task 11 orchestrator, for the
 * client panel to call as server actions. None of these add business logic
 * of their own — every real decision (planning, gates, receipts) lives in
 * the functions they wrap. `resolveReconcileAction` is reused as-is from the
 * email channel (`email-actions.ts`) — it is already channel-agnostic.
 *
 * The one thing they do add is the demo rate limit (spec P6 §3), checked first
 * so a throttled call never reaches a browser, a confirmation token or
 * `beginSubmission`. It is an extra layer on top of the gate matrix, never a
 * substitute for any part of it, and a no-op outside demo mode.
 */

function applicationPath(applicationId: string): string {
  return `/applications/${applicationId}`;
}

/**
 * `capture`/`submit` are only ever needed for prepare and confirm — the two
 * steps that touch a live page.
 *
 * Scoped rather than assembled, because the browser slot's lifetime is the
 * REQUEST's, not any one session's: `probeDriver` takes the process's single
 * slot and holds it through `beginSubmission` and `submit`, so a second visitor
 * is refused while the first's confirmation token is still unburned (P6 task-5
 * review, BLOCKING 1). `withSiteBrowserReservation` owns the `finally` that
 * gives it back — on a throw, and on every early return the orchestrator makes
 * between probe and submit — so no action here has one to get wrong. The
 * prepare path never probes and therefore releases nothing.
 */
async function withSiteDeps<T>(use: (deps: SiteDeps) => Promise<T>): Promise<T> {
  const config = loadConfig();
  return withSiteBrowserReservation(config, (reserved) => use({
    db: getDb(),
    config,
    capture: makeSiteCapture(config),
    // `submit`, and the `probeDriver` checked before the confirmation token is
    // burned so a process that cannot launch Chromium — or has no room for one
    // — says so instead of parking the attempt for a human.
    ...reserved,
  }));
}

const prepareInputSchema = z.object({
  applicationId: z.string().uuid(),
  url: z.string().url().max(TEXT_LIMITS.url),
  overrideDuplicate: z.boolean().optional(),
});

export async function prepareSiteApplicationAction(raw: unknown): Promise<PrepareOutcome> {
  const parsedInput = prepareInputSchema.safeParse(raw);
  if (!parsedInput.success) {
    return { status: "failed", reason: describeZodIssue(parsedInput.error, "invalid application URL") };
  }
  const { applicationId, url, overrideDuplicate } = parsedInput.data;
  // Ahead of `withSiteDeps`, so a throttled prepare never launches Chromium.
  const limited = demoRateLimit("prepareSiteApplication");
  if (limited) return { status: "failed", reason: limited };
  return withSiteDeps(async (deps) => {
    const ws = await getActiveWorkspace(deps.db);
    const outcome = await prepareSiteApplication(deps, {
      workspaceId: ws.id, applicationId, url, overrideDuplicate,
    });
    revalidatePath(applicationPath(applicationId));
    return outcome;
  });
}

const updateAnswerInputSchema = z.object({
  applicationId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  fieldId: z.string().min(1).max(TEXT_LIMITS.name),
  // What the visitor typed into one of the ATS form's fields. A single answer,
  // not a document — even a long "why this company" box fits inside `detail`.
  value: z.string().max(TEXT_LIMITS.detail),
});

export type UpdatePlannedAnswerResult = { ok: true } | { ok: false; reason: string };

export async function updatePlannedAnswerAction(raw: unknown): Promise<UpdatePlannedAnswerResult> {
  const parsedInput = updateAnswerInputSchema.safeParse(raw);
  if (!parsedInput.success) {
    return { ok: false, reason: describeZodIssue(parsedInput.error, "invalid answer") };
  }
  const { applicationId, snapshotId, fieldId, value } = parsedInput.data;
  const limited = demoRateLimit("updatePlannedAnswer");
  if (limited) return { ok: false, reason: limited };
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  const result = await updatePlannedAnswer({ db, config: loadConfig() }, {
    workspaceId: ws.id, snapshotId, fieldId, value,
  });
  revalidatePath(applicationPath(applicationId));
  return result;
}

const previewInputSchema = z.object({ applicationId: z.string().uuid(), attemptId: z.string().uuid() });

export async function previewSiteSubmissionAction(raw: unknown): Promise<SitePreviewOutcome> {
  const { applicationId, attemptId } = previewInputSchema.parse(raw);
  const limited = demoRateLimit("previewSiteSubmission");
  if (limited) return { status: "blocked", reason: limited };
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  const outcome = await previewSiteSubmission({ db, config: loadConfig() }, { workspaceId: ws.id, attemptId });
  revalidatePath(applicationPath(applicationId));
  return outcome;
}

const confirmInputSchema = z.object({
  applicationId: z.string().uuid(),
  attemptId: z.string().uuid(),
  presentedToken: z.string().min(1).max(TEXT_LIMITS.name),
  // Both are typed by hand into the confirmation box; the target is a URL here.
  retypedTarget: z.string().max(TEXT_LIMITS.url),
});

export async function confirmAndSubmitSiteAction(raw: unknown): Promise<SiteConfirmOutcome> {
  const parsedInput = confirmInputSchema.safeParse(raw);
  if (!parsedInput.success) {
    return {
      status: "blocked",
      code: "invalid_input",
      reason: describeZodIssue(parsedInput.error, "invalid confirmation"),
    };
  }
  const { applicationId, attemptId, presentedToken, retypedTarget } = parsedInput.data;
  // Before `confirmAndSubmitSite` and therefore before the token is burned,
  // before `beginSubmission` and before the driver is ever asked for a browser.
  const limited = demoRateLimit("confirmAndSubmitSite");
  if (limited) return { status: "blocked", code: "rate_limited", reason: limited };
  // The browser slot is held from `probeDriver` until this call returns —
  // across `beginSubmission` and `submit` — so a racing visitor is refused
  // BEFORE the token is burned rather than after it.
  return withSiteDeps(async (deps) => {
    const ws = await getActiveWorkspace(deps.db);
    const outcome = await confirmAndSubmitSite(deps, {
      workspaceId: ws.id, attemptId, presentedToken, retypedTarget,
    });
    revalidatePath(applicationPath(applicationId));
    return outcome;
  });
}
