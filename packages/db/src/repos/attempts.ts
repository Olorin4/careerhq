import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { AttemptStatus } from "@careerhq/contracts";
import { canAttemptTransition } from "@careerhq/core";
import { payloadFingerprint } from "@careerhq/core/gates";
import type { Db, DbOrTx, Tx } from "../client.js";
import { applicationAttempts, attemptConfirmations, formSnapshots } from "../schema/index.js";
import type { ApplicationAttempt, AttemptConfirmation, NewApplicationAttempt } from "../index.js";
import { transitionApplicationTx } from "./applications.js";

/** Every state-machine mutation answers with this instead of throwing on a refusal. */
export type AttemptOutcome = { ok: true } | { ok: false; reason: string };

/**
 * "In flight" matches `evaluateSubmissionGates`' `attemptInFlight` input exactly:
 * an attempt that has already begun a real submission and has not landed. A
 * PENDING_CONFIRMATION attempt has not touched the outside world yet, so it does
 * not block a sibling attempt.
 */
const IN_FLIGHT: readonly AttemptStatus[] = ["SUBMITTING", "NEEDS_RECONCILE"];

/**
 * Thrown inside a transaction to abort it with a caller-facing reason; the
 * `refusable` wrapper converts it to `{ ok: false, reason }` after the rollback.
 * Never escapes this module.
 */
class AttemptRefusal extends Error {}

/**
 * `postgres` surfaces server errors as a `PostgresError` carrying the raw
 * SQLSTATE in `.code`; drizzle wraps that in a `DrizzleQueryError` whose own
 * `.code` is undefined, so the SQLSTATE only appears on `.cause.code`. Checked
 * at both levels by hand since neither library exports a type guard.
 */
function isUniqueViolation(err: unknown): boolean {
  const codeOf = (value: unknown): unknown =>
    (typeof value === "object" && value !== null && "code" in value ? (value as { code?: unknown }).code : undefined);
  const cause = typeof err === "object" && err !== null && "cause" in err ? (err as { cause?: unknown }).cause : undefined;
  return codeOf(err) === "23505" || codeOf(cause) === "23505";
}

/**
 * Runs a transaction whose refusals are expected outcomes rather than faults.
 * An `AttemptRefusal` rolls the transaction back and comes out as a reason; so
 * does the `attempts_one_submitted_per_application` partial unique index, which
 * is the last line of defence against a duplicate submission slipping past the
 * gate matrix. Anything else still throws — a broken database is not a refusal.
 */
async function refusable(run: () => Promise<void>): Promise<AttemptOutcome> {
  try {
    await run();
    return { ok: true };
  } catch (err) {
    if (err instanceof AttemptRefusal) return { ok: false, reason: err.message };
    if (isUniqueViolation(err)) {
      return { ok: false, reason: "another attempt for this application is already submitted" };
    }
    throw err;
  }
}

/** Locks the attempt row for the rest of the transaction, refusing if it is gone. */
async function lockAttempt(tx: Tx, attemptId: string): Promise<ApplicationAttempt> {
  const [attempt] = await tx.select().from(applicationAttempts)
    .where(eq(applicationAttempts.id, attemptId)).for("update");
  if (!attempt) throw new AttemptRefusal(`attempt not found: ${attemptId}`);
  return attempt;
}

/**
 * The single choke point for attempt status changes: `canAttemptTransition`
 * decides, and an illegal edge aborts the transaction with its reason. Returns
 * the new status so callers can chain steps (DRAFT→READY→PENDING_CONFIRMATION).
 */
async function advance(
  tx: Tx,
  attemptId: string,
  from: AttemptStatus,
  to: AttemptStatus,
  set: Partial<NewApplicationAttempt> = {},
): Promise<AttemptStatus> {
  const check = canAttemptTransition(from, to);
  if (!check.ok) throw new AttemptRefusal(check.reason);
  await tx.update(applicationAttempts)
    .set({ ...set, status: to })
    .where(eq(applicationAttempts.id, attemptId));
  return to;
}

/** Shape stored in `application_attempts.draft_payload` for company-site attempts. */
export interface SiteAttemptDraft {
  url: string;
}

export async function createSiteAttempt(db: DbOrTx, input: {
  applicationId: string; url: string;
}): Promise<ApplicationAttempt> {
  const draftPayload: SiteAttemptDraft = { url: input.url };
  const [attempt] = await db.insert(applicationAttempts).values({
    applicationId: input.applicationId, channel: "company_site", status: "DRAFT", draftPayload,
  }).returning();
  return attempt!;
}

export async function getAttempt(db: Db, attemptId: string): Promise<ApplicationAttempt | null> {
  const [attempt] = await db.select().from(applicationAttempts)
    .where(eq(applicationAttempts.id, attemptId));
  return attempt ?? null;
}

export async function listAttemptsForApplication(
  db: Db,
  applicationId: string,
): Promise<ApplicationAttempt[]> {
  return db.select().from(applicationAttempts)
    .where(eq(applicationAttempts.applicationId, applicationId))
    .orderBy(asc(applicationAttempts.startedAt));
}

/**
 * The attempt is fully planned and nothing is waiting on the user, so it may be
 * previewed. Purely advisory — `recordPreview` walks DRAFT→READY itself — but
 * it lets a review screen tell "still being planned" from "ready when you are"
 * without recomputing the plan. A refusal (already past READY) is an outcome,
 * not a fault.
 */
export async function markAttemptReady(db: Db, attemptId: string): Promise<AttemptOutcome> {
  return refusable(() => db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, attemptId);
    await advance(tx, attempt.id, attempt.status, "READY");
  }));
}

/**
 * Pauses an attempt and hands control back to the user: the page needs a human
 * (captcha, sign-in wall, identity check, assessment, an upload control we
 * cannot drive, a legal attestation). `reason` is stored verbatim as the
 * failure reason and is shown to the user, so callers pass something legible.
 *
 * BLOCKED is not a failure: nothing was submitted, and the caller may not
 * assume the site is unreachable forever — `login_required` in particular
 * fires on account-creation steps that a human clears in seconds. A retry
 * starts a fresh attempt (BLOCKED is terminal by design).
 */
export async function markAttemptBlocked(
  db: Db,
  attemptId: string,
  reason: string,
): Promise<AttemptOutcome> {
  return refusable(() => db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, attemptId);
    await advance(tx, attempt.id, attempt.status, "BLOCKED", { failureReason: reason });
  }));
}

/**
 * Records a reviewed preview: the attempt moves DRAFT→READY→PENDING_CONFIRMATION
 * as two separately guarded steps, its fingerprints are pinned, and a
 * single-use confirmation row is inserted — all in one transaction, so a
 * pending confirmation can never exist for an attempt that is not awaiting one.
 *
 * `target` is the recipient the user must retype at confirm time; only its
 * fingerprint is stored (the plaintext already lives in the draft payload).
 * `tokenHash` must already be `hashConfirmationToken(token)` — the plaintext
 * token is shown to the user once and never persisted.
 *
 * Re-previewing supersedes: every earlier unconsumed confirmation for the
 * attempt is marked consumed before the new row is inserted, so a stale
 * confirmation dialog still holding the previous token cannot redeem it. At
 * most one confirmation for an attempt is ever redeemable.
 */
export async function recordPreview(db: DbOrTx, input: {
  attemptId: string; payloadFingerprint: string; target: string; tokenHash: string; expiresAt: Date;
}): Promise<AttemptOutcome> {
  return refusable(() => db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, input.attemptId);

    const ready = await advance(tx, attempt.id, attempt.status, "READY");
    await advance(tx, attempt.id, ready, "PENDING_CONFIRMATION", {
      payloadFingerprint: input.payloadFingerprint,
      targetFingerprint: payloadFingerprint(input.target.trim().toLowerCase()),
    });

    await tx.update(attemptConfirmations)
      .set({ consumedAt: sql`clock_timestamp()` })
      .where(and(
        eq(attemptConfirmations.attemptId, attempt.id),
        isNull(attemptConfirmations.consumedAt),
      ));

    await tx.insert(attemptConfirmations).values({
      attemptId: attempt.id,
      tokenHash: input.tokenHash,
      payloadFingerprint: input.payloadFingerprint,
      expiresAt: input.expiresAt,
    });
  }));
}

/**
 * The newest confirmation for the attempt whatever its state — consumed,
 * expired or live. The gate matrix needs the row itself to tell
 * `token_consumed`/`token_expired` apart from `token_missing`;
 * `getActiveConfirmation` cannot, because it hides both.
 */
export async function getLatestConfirmation(
  db: Db,
  attemptId: string,
): Promise<AttemptConfirmation | null> {
  const [row] = await db.select().from(attemptConfirmations)
    .where(eq(attemptConfirmations.attemptId, attemptId))
    // `created_at` defaults to now(), which is the transaction timestamp, so
    // two previews could in principle tie. A live row wins that tie: reporting
    // token_consumed for a token that still works would be a false denial.
    .orderBy(
      desc(attemptConfirmations.createdAt),
      asc(sql`(${attemptConfirmations.consumedAt} is not null)`),
    )
    .limit(1);
  return row ?? null;
}

/** The newest confirmation for the attempt that is neither consumed nor expired. */
export async function getActiveConfirmation(
  db: DbOrTx,
  attemptId: string,
): Promise<AttemptConfirmation | null> {
  const [row] = await db.select().from(attemptConfirmations)
    .where(and(
      eq(attemptConfirmations.attemptId, attemptId),
      isNull(attemptConfirmations.consumedAt),
      gt(attemptConfirmations.expiresAt, sql`now()`),
    ))
    .orderBy(desc(attemptConfirmations.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * The write that happens BEFORE the mutation: burns the confirmation, moves the
 * attempt PENDING_CONFIRMATION→SUBMITTING and stores the pending receipt, in
 * one transaction. If the process dies mid-send the attempt is left SUBMITTING
 * with evidence of what was about to be sent — the NEEDS_RECONCILE path exists
 * for exactly that.
 *
 * The confirmation is consumed with a conditional UPDATE (`consumed_at IS NULL`),
 * so two concurrent callers cannot both win the token even if they read it at
 * the same instant.
 */
export async function beginSubmission(db: DbOrTx, input: {
  attemptId: string; confirmationId: string; pendingReceipt: unknown;
}): Promise<AttemptOutcome> {
  return refusable(() => db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, input.attemptId);

    const [confirmation] = await tx.select().from(attemptConfirmations)
      .where(and(
        eq(attemptConfirmations.id, input.confirmationId),
        eq(attemptConfirmations.attemptId, input.attemptId),
      )).for("update");
    if (!confirmation) throw new AttemptRefusal("confirmation not found for this attempt");
    if (confirmation.consumedAt) throw new AttemptRefusal("confirmation already consumed");
    if (confirmation.expiresAt.getTime() <= Date.now()) {
      throw new AttemptRefusal("confirmation expired");
    }
    // Belt and braces alongside the gate matrix's fingerprint check: an edit
    // after the preview clears the attempt's fingerprint, so a confirmation
    // issued for the older payload can never be redeemed here.
    if (attempt.payloadFingerprint !== confirmation.payloadFingerprint) {
      throw new AttemptRefusal("payload changed since the confirmation was issued");
    }

    const consumed = await tx.update(attemptConfirmations)
      .set({ consumedAt: sql`clock_timestamp()` })
      .where(and(
        eq(attemptConfirmations.id, confirmation.id),
        isNull(attemptConfirmations.consumedAt),
      ))
      .returning({ id: attemptConfirmations.id });
    if (consumed.length === 0) throw new AttemptRefusal("confirmation already consumed");

    await advance(tx, attempt.id, attempt.status, "SUBMITTING", {
      pendingReceipt: input.pendingReceipt,
    });
  }));
}

/**
 * Records a successful submission: attempt SUBMITTING→SUBMITTED with its
 * confirmed receipt and `submitted_at`, plus the genuine guarded
 * READY_FOR_REVIEW→SUBMITTED application transition (trigger "attempt",
 * `hasConfirmedAttempt: true`) — one transaction, so the application can never
 * claim SUBMITTED without the attempt receipt that justifies it, or vice versa.
 *
 * Refusals (illegal edge, application transition rejected, or the
 * one-submitted-attempt index firing) roll everything back and leave the
 * attempt SUBMITTING — in flight, blocking, and visible to a human via
 * `markNeedsReconcile`/`resolveReconcile`.
 */
export async function completeSubmission(db: DbOrTx, input: {
  attemptId: string; confirmedReceipt: unknown;
}): Promise<AttemptOutcome> {
  return refusable(() => db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, input.attemptId);
    await advance(tx, attempt.id, attempt.status, "SUBMITTED", {
      confirmedReceipt: input.confirmedReceipt,
      submittedAt: new Date(),
    });
    const moved = await transitionApplicationTx(tx, {
      applicationId: attempt.applicationId, to: "SUBMITTED", trigger: "attempt",
      ctx: { hasConfirmedAttempt: true },
    });
    if (!moved.ok) throw new AttemptRefusal(moved.reason);
  }));
}

/**
 * The send failed outright and nothing was delivered. Throws on an illegal
 * edge: unlike the gated paths above, this is only ever called by code that
 * just observed a failed send on an attempt it moved to SUBMITTING itself, so a
 * refusal here is a programming error, not a user-facing outcome.
 */
export async function failSubmission(db: Db, attemptId: string, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, attemptId);
    await advance(tx, attempt.id, attempt.status, "FAILED", { failureReason: reason });
  });
}

/**
 * The send's outcome is unknown (timeout after DATA, ambiguous server reply):
 * park the attempt for a human. Throws on an illegal edge for the same reason
 * as `failSubmission`.
 */
export async function markNeedsReconcile(db: Db, attemptId: string, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, attemptId);
    await advance(tx, attempt.id, attempt.status, "NEEDS_RECONCILE", { failureReason: reason });
  });
}

/**
 * The human-only exit from NEEDS_RECONCILE. "submitted" records the same
 * receipt + application transition as `completeSubmission` (the evidence is
 * whatever the human found — a Sent-folder copy, a bounce, a reply); "failed"
 * closes the attempt out. Nothing else may call this: the machine cannot know
 * which way an ambiguous send went.
 */
export async function resolveReconcile(db: Db, input: {
  attemptId: string; resolution: "submitted" | "failed"; evidence?: unknown;
}): Promise<AttemptOutcome> {
  return refusable(() => db.transaction(async (tx) => {
    const attempt = await lockAttempt(tx, input.attemptId);
    const receipt = {
      source: "manual_reconcile",
      resolution: input.resolution,
      evidence: input.evidence ?? null,
      resolvedAt: new Date().toISOString(),
    };

    if (input.resolution === "failed") {
      await advance(tx, attempt.id, attempt.status, "FAILED", {
        confirmedReceipt: receipt,
        failureReason: "reconciled as failed by the owner",
      });
      return;
    }

    await advance(tx, attempt.id, attempt.status, "SUBMITTED", {
      confirmedReceipt: receipt,
      submittedAt: new Date(),
    });
    const moved = await transitionApplicationTx(tx, {
      applicationId: attempt.applicationId, to: "SUBMITTED", trigger: "attempt",
      ctx: { hasConfirmedAttempt: true },
    });
    if (!moved.ok) throw new AttemptRefusal(moved.reason);
  }));
}

/**
 * The duplicate/in-flight inputs the submission gate matrix needs, in one round
 * trip: `confirmed` means this application already has a submitted attempt,
 * `inFlight` means another attempt is mid-submission (SUBMITTING/NEEDS_RECONCILE).
 */
export async function hasBlockingAttempt(db: Db, applicationId: string): Promise<{
  confirmed: boolean; inFlight: boolean;
}> {
  const rows = await db.select({ status: applicationAttempts.status })
    .from(applicationAttempts)
    .where(and(
      eq(applicationAttempts.applicationId, applicationId),
      inArray(applicationAttempts.status, ["SUBMITTED", ...IN_FLIGHT]),
    ));
  return {
    confirmed: rows.some((r) => r.status === "SUBMITTED"),
    inFlight: rows.some((r) => IN_FLIGHT.includes(r.status)),
  };
}

/**
 * Every evidence-screenshot path the database still points at, across all
 * workspaces — the live set for the demo's screenshot collector
 * (`@careerhq/core/storage`'s `reserveEvidenceScreenshot`).
 *
 * Deliberately NOT workspace-scoped, for exactly the reason `listCvFilePaths`
 * is not: the collector deletes whatever it does not see here, so scoping it
 * would delete another workspace's evidence. It is also deliberately the union
 * of BOTH writers' references, because the two of them share one store:
 *
 *   - `application_attempts.confirmed_receipt->>'screenshotPath'` — what
 *     apps/web's `completeSubmission` records for an interactive submission
 *     (and what `seedDemoWorkspace` records for the seeded one), and
 *   - `form_snapshots.recovery_state->>'screenshotPath'` — what the worker's
 *     `runSubmitJob` records for the queue variant.
 *
 * `pending_receipt` carries no screenshot path (nothing has been captured when
 * it is written), so it is not read; a receipt shape that grows one must be
 * added here in the same commit, or its file becomes collectable.
 */
export async function listEvidenceScreenshotPaths(db: Db): Promise<string[]> {
  const [receipts, recoveries] = await Promise.all([
    db.select({ p: sql<string | null>`${applicationAttempts.confirmedReceipt}->>'screenshotPath'` })
      .from(applicationAttempts),
    db.select({ p: sql<string | null>`${formSnapshots.recoveryState}->>'screenshotPath'` })
      .from(formSnapshots),
  ]);
  return [...receipts, ...recoveries]
    .map((row) => row.p)
    .filter((p): p is string => typeof p === "string" && p.length > 0);
}
