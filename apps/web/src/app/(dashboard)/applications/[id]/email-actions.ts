"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { emailDraftSchema } from "@careerhq/contracts";
import {
  createEmailAttempt, resolveReconcile, updateEmailDraft,
} from "@careerhq/db";
import { loadConfig } from "@careerhq/config";
import { getDb } from "../../../../lib/db.js";
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
  const { applicationId, connectionId, draft } = draftInputSchema.parse(raw);
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
  const { applicationId, attemptId, connectionId, draft } = updateInputSchema.parse(raw);
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
  presentedToken: z.string().min(1),
  retypedTarget: z.string(),
});

export async function confirmAndSendAction(raw: unknown): Promise<ConfirmOutcome> {
  const { applicationId, attemptId, presentedToken, retypedTarget } = confirmInputSchema.parse(raw);
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
  evidenceNote: z.string().trim().optional(),
});

export type ReconcileActionResult = { ok: true } | { ok: false; reason: string };

export async function resolveReconcileAction(raw: unknown): Promise<ReconcileActionResult> {
  const { applicationId, attemptId, resolution, evidenceNote } = reconcileInputSchema.parse(raw);
  const db = getDb();
  const result = await resolveReconcile(db, {
    attemptId,
    resolution,
    evidence: evidenceNote ? { note: evidenceNote } : undefined,
  });
  revalidatePath(applicationPath(applicationId));
  return result;
}
