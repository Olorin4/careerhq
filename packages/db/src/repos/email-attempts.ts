import { eq } from "drizzle-orm";
import type { AttemptStatus, EmailDraft } from "@careerhq/contracts";
import { canAttemptTransition } from "@careerhq/core";
import type { Db } from "../client.js";
import { applicationAttempts } from "../schema/index.js";
import type { ApplicationAttempt } from "../index.js";

/** Shape stored in `application_attempts.draft_payload` for email attempts. */
export interface EmailAttemptDraft {
  draft: EmailDraft;
  connectionId: string;
}

/** Statuses an email draft may still be edited in (spec §11). */
const EDITABLE: readonly AttemptStatus[] = ["DRAFT", "READY", "PENDING_CONFIRMATION"];

export async function createEmailAttempt(db: Db, input: {
  applicationId: string; draft: EmailDraft; connectionId: string;
}): Promise<ApplicationAttempt> {
  const draftPayload: EmailAttemptDraft = { draft: input.draft, connectionId: input.connectionId };
  const [attempt] = await db.insert(applicationAttempts).values({
    applicationId: input.applicationId, channel: "email", status: "DRAFT", draftPayload,
  }).returning();
  return attempt!;
}

/**
 * Replaces the draft and walks the attempt back to DRAFT through the real
 * guarded edges (PENDING_CONFIRMATION→READY→DRAFT). Editing after a preview
 * must invalidate that preview: the stored fingerprints are cleared, so an
 * outstanding confirmation can no longer match, and the status reset means the
 * PENDING_CONFIRMATION→SUBMITTING edge is closed until a fresh preview runs.
 *
 * Returns `null` when the attempt is unknown or past editing (SUBMITTING and
 * beyond) — nothing is written in that case.
 */
export async function updateEmailDraft(
  db: Db,
  attemptId: string,
  draft: EmailDraft,
  connectionId: string,
): Promise<ApplicationAttempt | null> {
  return db.transaction(async (tx) => {
    const [attempt] = await tx.select().from(applicationAttempts)
      .where(eq(applicationAttempts.id, attemptId)).for("update");
    if (!attempt || !EDITABLE.includes(attempt.status)) return null;

    // Walk the guarded path back to DRAFT rather than assuming it exists; if
    // core ever closes one of those edges this degrades to "not editable"
    // instead of silently bypassing the state machine.
    let status = attempt.status;
    for (const step of ["READY", "DRAFT"] as const) {
      if (status === "DRAFT") break;
      if (status === step) continue;
      if (!canAttemptTransition(status, step).ok) return null;
      status = step;
    }

    const draftPayload: EmailAttemptDraft = { draft, connectionId };
    const [updated] = await tx.update(applicationAttempts).set({
      status: "DRAFT", draftPayload, payloadFingerprint: null, targetFingerprint: null,
    }).where(eq(applicationAttempts.id, attemptId)).returning();
    return updated!;
  });
}

// Every channel-agnostic attempt-state helper (recordPreview, beginSubmission,
// completeSubmission, failSubmission, markNeedsReconcile, resolveReconcile,
// hasBlockingAttempt, getActiveConfirmation, getLatestConfirmation,
// listAttemptsForApplication, getAttempt, createSiteAttempt, ...) now lives in
// ./attempts.ts. Re-exported here so every existing import of this module
// keeps working unchanged.
export * from "./attempts.js";
// `getAttempt` is the channel-agnostic name in attempts.ts; this module's own
// historical name for the same lookup was `getEmailAttempt` — kept as an alias
// so callers (and this repo's own tests) do not need to change.
export { getAttempt as getEmailAttempt } from "./attempts.js";
