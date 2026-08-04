"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { loadConfig } from "@careerhq/config";
import { getDb } from "../../../../lib/db.js";
import { demoRateLimit } from "../../../../lib/rate-limit.js";
import { makeDriverProbe, makeSiteCapture, makeSiteSubmit } from "../../../../lib/site-driver.js";
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

/** `capture`/`submit` are only ever needed for prepare and confirm — the two steps that touch a live page. */
function siteDepsWithDriver(): SiteDeps {
  const config = loadConfig();
  return {
    db: getDb(),
    config,
    capture: makeSiteCapture(config),
    submit: makeSiteSubmit(config),
    // Checked before the confirmation token is burned, so a process that cannot
    // launch Chromium says so instead of parking the attempt for a human.
    probeDriver: makeDriverProbe(config),
  };
}

const prepareInputSchema = z.object({
  applicationId: z.string().uuid(),
  url: z.string().url(),
  overrideDuplicate: z.boolean().optional(),
});

export async function prepareSiteApplicationAction(raw: unknown): Promise<PrepareOutcome> {
  const { applicationId, url, overrideDuplicate } = prepareInputSchema.parse(raw);
  // Ahead of `siteDepsWithDriver`, so a throttled prepare never launches Chromium.
  const limited = demoRateLimit("prepareSiteApplication");
  if (limited) return { status: "failed", reason: limited };
  const deps = siteDepsWithDriver();
  const ws = await getActiveWorkspace(deps.db);
  const outcome = await prepareSiteApplication(deps, {
    workspaceId: ws.id, applicationId, url, overrideDuplicate,
  });
  revalidatePath(applicationPath(applicationId));
  return outcome;
}

const updateAnswerInputSchema = z.object({
  applicationId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  fieldId: z.string().min(1),
  value: z.string(),
});

export type UpdatePlannedAnswerResult = { ok: true } | { ok: false; reason: string };

export async function updatePlannedAnswerAction(raw: unknown): Promise<UpdatePlannedAnswerResult> {
  const { applicationId, snapshotId, fieldId, value } = updateAnswerInputSchema.parse(raw);
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
  presentedToken: z.string().min(1),
  retypedTarget: z.string(),
});

export async function confirmAndSubmitSiteAction(raw: unknown): Promise<SiteConfirmOutcome> {
  const { applicationId, attemptId, presentedToken, retypedTarget } = confirmInputSchema.parse(raw);
  // Before `confirmAndSubmitSite` and therefore before the token is burned,
  // before `beginSubmission` and before the driver is ever asked for a browser.
  const limited = demoRateLimit("confirmAndSubmitSite");
  if (limited) return { status: "blocked", code: "rate_limited", reason: limited };
  const deps = siteDepsWithDriver();
  const ws = await getActiveWorkspace(deps.db);
  const outcome = await confirmAndSubmitSite(deps, {
    workspaceId: ws.id, attemptId, presentedToken, retypedTarget,
  });
  revalidatePath(applicationPath(applicationId));
  return outcome;
}
