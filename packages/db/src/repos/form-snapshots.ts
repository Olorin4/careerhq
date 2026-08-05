import { and, asc, desc, eq, sql } from "drizzle-orm";
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
 * Records the evidence screenshot for a submission whose outcome nobody could
 * confirm, onto the newest snapshot's `recovery_state`.
 *
 * The key is `screenshotPath`, at the top level, because that is where
 * `runSubmitJob`'s `submit_result` already puts it and it is the ONE key
 * `listEvidenceScreenshotPaths` reads for this table — one shape, so a
 * referenced screenshot is a referenced screenshot no matter which path
 * produced it. Without this, `apps/web`'s NEEDS_RECONCILE outcomes persisted
 * their path to no row at all: the receipt is only written by
 * `completeSubmission`, which by definition did not run, so in demo mode the
 * evidence collector reclaimed the file five minutes later while the attempt's
 * reason still told the reader to go and check it.
 *
 * MERGED into whatever is already on the row (`||`), never replacing it. The
 * row can be carrying `runSubmitJob`'s `submit_in_flight` marker — the single
 * durable record that a submit click may already have happened, and the one
 * thing standing between a retried queue job and a second application at the
 * employer. Writing a fresh object here would erase it. A non-object
 * `recovery_state` (nothing writes one today) is treated as absent rather than
 * concatenated, since `jsonb || jsonb` on an array means something else
 * entirely.
 */
export async function recordRecoveryScreenshot(
  db: DbOrTx,
  snapshotId: string,
  screenshotPath: string,
): Promise<void> {
  await db.update(formSnapshots)
    .set({
      recoveryState: sql`case when jsonb_typeof(${formSnapshots.recoveryState}) = 'object'
        then ${formSnapshots.recoveryState} else '{}'::jsonb end
        || jsonb_build_object('screenshotPath', ${screenshotPath}::text)`,
    })
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
