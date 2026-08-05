"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { emailDraftSchema, TEXT_LIMITS } from "@careerhq/contracts";
import {
  createEmailAttempt, resolveReconcile, updateEmailDraft,
} from "@careerhq/db";
import { loadConfig } from "@careerhq/config";
import { getDb } from "../../../../lib/db.js";
import { describeZodIssue } from "../../../../lib/form-state.js";
import { demoRateLimit } from "../../../../lib/rate-limit.js";
import { getActiveWorkspace } from "../../../../lib/workspace.js";
import {
  confirmAndSend, previewSubmission, type ConfirmOutcome, type PreviewOutcome,
} from "../../../../lib/email-submission.js";

/**
 * Thin, zod-validated wrappers around the Task 7 attempt repo and Task 9
 * orchestrator (`previewSubmission`/`confirmAndSend`), for the client panel
 * to call as server actions. None of these add business logic of their own —
 * every real decision (editability, gate checks, receipts) lives in the
 * functions they wrap.
 *
 * The one thing they do add is the demo rate limit (spec P6 §3): it is checked
 * first, before any state is read and long before anything irreversible, so a
 * throttled call leaves the attempt exactly as it found it. It composes with
 * the gate matrix rather than replacing any part of it — outside demo mode
 * `demoRateLimit` is a no-op and nothing below changes at all.
 */

function applicationPath(applicationId: string): string {
  return `/applications/${applicationId}`;
}

const draftInputSchema = z.object({
  applicationId: z.string().uuid(),
  connectionId: z.string().uuid(),
  draft: emailDraftSchema,
});

export type DraftActionResult =
  | { ok: true; attemptId: string }
  | { ok: false; reason: string };

export async function createEmailAttemptAction(raw: unknown): Promise<DraftActionResult> {
  // safeParse, not parse: `emailDraftSchema` caps the subject and body a person
  // typed, and the panel already renders `{ ok: false, reason }` — a throw here
  // would be the full-page error overlay instead.
  const parsedInput = draftInputSchema.safeParse(raw);
  if (!parsedInput.success) {
    return { ok: false, reason: describeZodIssue(parsedInput.error, "invalid draft") };
  }
  const { applicationId, connectionId, draft } = parsedInput.data;
  const limited = demoRateLimit("createEmailAttempt");
  if (limited) return { ok: false, reason: limited };
  const db = getDb();
  const attempt = await createEmailAttempt(db, { applicationId, draft, connectionId });
  revalidatePath(applicationPath(applicationId));
  return { ok: true, attemptId: attempt.id };
}

const updateInputSchema = z.object({
  applicationId: z.string().uuid(),
  attemptId: z.string().uuid(),
  connectionId: z.string().uuid(),
  draft: emailDraftSchema,
});

export async function updateEmailDraftAction(raw: unknown): Promise<DraftActionResult> {
  const parsedInput = updateInputSchema.safeParse(raw);
  if (!parsedInput.success) {
    return { ok: false, reason: describeZodIssue(parsedInput.error, "invalid draft") };
  }
  const { applicationId, attemptId, connectionId, draft } = parsedInput.data;
  const limited = demoRateLimit("updateEmailDraft");
  if (limited) return { ok: false, reason: limited };
  const db = getDb();
  const updated = await updateEmailDraft(db, attemptId, draft, connectionId);
  revalidatePath(applicationPath(applicationId));
  return updated
    ? { ok: true, attemptId: updated.id }
    : { ok: false, reason: "this draft can no longer be edited — start a new attempt" };
}

const previewInputSchema = z.object({ applicationId: z.string().uuid(), attemptId: z.string().uuid() });

export async function previewSubmissionAction(raw: unknown): Promise<PreviewOutcome> {
  const { applicationId, attemptId } = previewInputSchema.parse(raw);
  const limited = demoRateLimit("previewSubmission");
  if (limited) return { status: "blocked", reason: limited };
  const db = getDb();
  const config = loadConfig();
  const ws = await getActiveWorkspace(db);
  const outcome = await previewSubmission({ db, config }, { workspaceId: ws.id, attemptId });
  revalidatePath(applicationPath(applicationId));
  return outcome;
}

const confirmInputSchema = z.object({
  applicationId: z.string().uuid(),
  attemptId: z.string().uuid(),
  presentedToken: z.string().min(1).max(TEXT_LIMITS.name),
  // Both are typed by hand into the confirmation box; the target is an address here.
  retypedTarget: z.string().max(TEXT_LIMITS.emailAddress),
});

export async function confirmAndSendAction(raw: unknown): Promise<ConfirmOutcome> {
  const parsedInput = confirmInputSchema.safeParse(raw);
  if (!parsedInput.success) {
    return {
      status: "blocked",
      code: "invalid_input",
      reason: describeZodIssue(parsedInput.error, "invalid confirmation"),
    };
  }
  const { applicationId, attemptId, presentedToken, retypedTarget } = parsedInput.data;
  // Before `confirmAndSend` and therefore before the token is burned, before
  // `beginSubmission` and before any transport is built.
  const limited = demoRateLimit("confirmAndSend");
  if (limited) return { status: "blocked", code: "rate_limited", reason: limited };
  const db = getDb();
  const config = loadConfig();
  const ws = await getActiveWorkspace(db);
  const outcome = await confirmAndSend(
    { db, config },
    { workspaceId: ws.id, attemptId, presentedToken, retypedTarget },
  );
  revalidatePath(applicationPath(applicationId));
  return outcome;
}

const reconcileInputSchema = z.object({
  applicationId: z.string().uuid(),
  attemptId: z.string().uuid(),
  resolution: z.enum(["submitted", "failed"]),
  evidenceNote: z.string().trim().max(TEXT_LIMITS.note).optional(),
});

export type ReconcileActionResult = { ok: true } | { ok: false; reason: string };

export async function resolveReconcileAction(raw: unknown): Promise<ReconcileActionResult> {
  const parsedInput = reconcileInputSchema.safeParse(raw);
  if (!parsedInput.success) {
    return { ok: false, reason: describeZodIssue(parsedInput.error, "invalid resolution") };
  }
  const { applicationId, attemptId, resolution, evidenceNote } = parsedInput.data;
  const limited = demoRateLimit("resolveReconcile");
  if (limited) return { ok: false, reason: limited };
  const db = getDb();
  const result = await resolveReconcile(db, {
    attemptId,
    resolution,
    evidence: evidenceNote ? { note: evidenceNote } : undefined,
  });
  revalidatePath(applicationPath(applicationId));
  return result;
}
