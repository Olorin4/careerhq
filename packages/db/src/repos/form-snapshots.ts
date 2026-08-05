import { and, asc, desc, eq } from "drizzle-orm";
import type { CanonicalForm, PlannedAnswer } from "@careerhq/contracts";
import type { Db, DbOrTx } from "../client.js";
import { applicationAttempts, applications, formSnapshots } from "../schema/index.js";
import type { FormSnapshot } from "../index.js";

/**
 * Records the form as parsed and the answers planned for it, at the point the
 * autoapply driver is about to start acting on the live page. Each save is a
 * new row (never an update-in-place): `getLatestSnapshot` reads the newest one
 * by `captured_at`, so a re-parse after a crash/retry leaves the earlier
 * snapshot as history rather than clobbering it.
 */
export async function saveFormSnapshot(db: DbOrTx, input: {
  attemptId: string; form: CanonicalForm; answers: PlannedAnswer[];
}): Promise<FormSnapshot> {
  const [snapshot] = await db.insert(formSnapshots).values({
    attemptId: input.attemptId,
    atsType: input.form.atsType,
    url: input.form.url,
    requisitionKey: input.form.requisitionKey,
    parserVersion: input.form.parserVersion,
    canonicalForm: input.form,
    plannedAnswers: input.answers,
  }).returning();
  return snapshot!;
}

/** The most recently captured snapshot for the attempt, or `null` if none exists yet. */
export async function getLatestSnapshot(db: Db, attemptId: string): Promise<FormSnapshot | null> {
  const [snapshot] = await db.select().from(formSnapshots)
    .where(eq(formSnapshots.attemptId, attemptId))
    // `id` last so "the most recent" is one row, not either of two captured in
    // the same instant.
    .orderBy(desc(formSnapshots.capturedAt), asc(formSnapshots.id))
    .limit(1);
  return snapshot ?? null;
}

/**
 * Replaces (not merges) the planned-answers array on a snapshot — the driver
 * calls this after a user edits an answer or a re-plan runs, so the stored
 * array always reflects the current plan in full.
 */
export async function updateSnapshotAnswers(
  db: Db,
  snapshotId: string,
  answers: PlannedAnswer[],
): Promise<FormSnapshot | null> {
  const [updated] = await db.update(formSnapshots)
    .set({ plannedAnswers: answers })
    .where(eq(formSnapshots.id, snapshotId))
    .returning();
  return updated ?? null;
}

/**
 * Persists non-secret per-step progress so a crashed/retried driver run can
 * resume from where it left off instead of restarting the whole form.
 */
export async function updateRecoveryState(
  db: Db,
  snapshotId: string,
  currentStep: number,
  recoveryState: unknown,
): Promise<void> {
  await db.update(formSnapshots)
    .set({ currentStep, recoveryState })
    .where(eq(formSnapshots.id, snapshotId));
}

/**
 * The duplicate-requisition check for the company-site channel: joins
 * form_snapshots→application_attempts→applications so the lookup can be
 * scoped to the caller's workspace. Only an attempt that actually reached
 * SUBMITTED counts as a duplicate — a FAILED or BLOCKED prior attempt at the
 * same requisition left nothing submitted, so it must not stop a fresh try.
 */
export async function findRequisitionAttempt(
  db: Db,
  workspaceId: string,
  requisitionKey: string,
): Promise<{ attemptId: string; applicationId: string } | null> {
  const [row] = await db.select({
    attemptId: applicationAttempts.id,
    applicationId: applicationAttempts.applicationId,
  })
    .from(formSnapshots)
    .innerJoin(applicationAttempts, eq(applicationAttempts.id, formSnapshots.attemptId))
    .innerJoin(applications, eq(applications.id, applicationAttempts.applicationId))
    .where(and(
      eq(applications.workspaceId, workspaceId),
      eq(formSnapshots.requisitionKey, requisitionKey),
      eq(applicationAttempts.status, "SUBMITTED"),
    ))
    .orderBy(desc(formSnapshots.capturedAt), asc(formSnapshots.id))
    .limit(1);
  return row ?? null;
}
