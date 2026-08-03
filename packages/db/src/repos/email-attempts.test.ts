import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { EmailDraft } from "@careerhq/contracts";
import { hashConfirmationToken, payloadFingerprint } from "@careerhq/core/gates";
import { createDb, type Db, workspaces } from "../index.js";
import { attemptConfirmations } from "../schema/index.js";
import { createApplication, getApplicationDetail, transitionApplication } from "./applications.js";
import {
  beginSubmission, completeSubmission, createEmailAttempt, failSubmission, getActiveConfirmation,
  getEmailAttempt, hasBlockingAttempt, listAttemptsForApplication, markNeedsReconcile, recordPreview,
  resolveReconcile, updateEmailDraft,
} from "./email-attempts.js";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

let db: Db;
let workspaceId: string;
const connectionId = randomUUID();

const draft: EmailDraft = { to: "careers@acme.test", subject: "Application: Engineer", body: "Hello there." };

beforeAll(async () => {
  if (!url) return;
  db = createDb(url);
  const [ws] = await db.insert(workspaces).values({ name: `t-att-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;
});

afterAll(async () => {
  if (!url) return;
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.$client.end();
});

/** An application walked to READY_FOR_REVIEW through the real guarded transitions. */
async function readyApplication(companyName: string): Promise<string> {
  const app = await createApplication(db, { workspaceId, companyName, jobTitle: "Engineer" });
  const shortlisted = await transitionApplication(db, { applicationId: app.id, to: "SHORTLISTED", trigger: "user" });
  expect(shortlisted.ok).toBe(true);
  const preparing = await transitionApplication(db, { applicationId: app.id, to: "PREPARING", trigger: "user" });
  expect(preparing.ok).toBe(true);
  const ready = await transitionApplication(db, {
    applicationId: app.id, to: "READY_FOR_REVIEW", trigger: "user", ctx: { hasMaterials: true },
  });
  expect(ready.ok).toBe(true);
  return app.id;
}

interface PreviewedAttempt { applicationId: string; attemptId: string; confirmationId: string; fingerprint: string }

/** create → (optional edit) → recordPreview, returning the ids the gate flow needs. */
async function previewed(companyName: string): Promise<PreviewedAttempt> {
  const applicationId = await readyApplication(companyName);
  const attempt = await createEmailAttempt(db, { applicationId, draft, connectionId });
  const fingerprint = payloadFingerprint({ applicationId, connectionId, ...draft });
  const preview = await recordPreview(db, {
    attemptId: attempt.id, payloadFingerprint: fingerprint, target: draft.to,
    tokenHash: hashConfirmationToken(`token-${attempt.id}`),
    expiresAt: new Date(Date.now() + 600_000),
  });
  expect(preview.ok).toBe(true);
  const confirmation = await getActiveConfirmation(db, attempt.id);
  expect(confirmation).not.toBeNull();
  return { applicationId, attemptId: attempt.id, confirmationId: confirmation!.id, fingerprint };
}

d("email attempts repo", () => {
  it("runs the full lifecycle: draft → preview → begin → complete, landing the application at SUBMITTED", async () => {
    const applicationId = await readyApplication("Lifecycle Co");

    const attempt = await createEmailAttempt(db, { applicationId, draft, connectionId });
    expect(attempt.channel).toBe("email");
    expect(attempt.status).toBe("DRAFT");
    expect(attempt.draftPayload).toEqual({ draft, connectionId });

    const edited: EmailDraft = { ...draft, subject: "Application: Senior Engineer" };
    const updated = await updateEmailDraft(db, attempt.id, edited, connectionId);
    expect(updated?.status).toBe("DRAFT");
    expect(updated?.draftPayload).toEqual({ draft: edited, connectionId });

    const fingerprint = payloadFingerprint({ applicationId, connectionId, ...edited });
    const tokenHash = hashConfirmationToken("a-real-looking-token");
    const preview = await recordPreview(db, {
      attemptId: attempt.id, payloadFingerprint: fingerprint, target: edited.to,
      tokenHash, expiresAt: new Date(Date.now() + 600_000),
    });
    expect(preview).toEqual({ ok: true });

    const previewed = await getEmailAttempt(db, attempt.id);
    expect(previewed?.status).toBe("PENDING_CONFIRMATION");
    expect(previewed?.payloadFingerprint).toBe(fingerprint);
    expect(previewed?.targetFingerprint).toBeTruthy();

    const confirmation = await getActiveConfirmation(db, attempt.id);
    expect(confirmation?.tokenHash).toBe(tokenHash);
    expect(confirmation?.payloadFingerprint).toBe(fingerprint);
    expect(confirmation?.consumedAt).toBeNull();

    const begun = await beginSubmission(db, {
      attemptId: attempt.id, confirmationId: confirmation!.id,
      pendingReceipt: { startedAt: "2026-08-03T00:00:00.000Z", fingerprint },
    });
    expect(begun).toEqual({ ok: true });

    const submitting = await getEmailAttempt(db, attempt.id);
    expect(submitting?.status).toBe("SUBMITTING");
    expect(submitting?.pendingReceipt).toEqual({ startedAt: "2026-08-03T00:00:00.000Z", fingerprint });
    const [consumed] = await db.select().from(attemptConfirmations)
      .where(eq(attemptConfirmations.id, confirmation!.id));
    expect(consumed!.consumedAt).toBeInstanceOf(Date);
    expect(await getActiveConfirmation(db, attempt.id)).toBeNull();

    const completed = await completeSubmission(db, {
      attemptId: attempt.id, confirmedReceipt: { messageId: "<abc@test>", acceptedAt: "2026-08-03T00:00:05.000Z" },
    });
    expect(completed).toEqual({ ok: true });

    const submitted = await getEmailAttempt(db, attempt.id);
    expect(submitted?.status).toBe("SUBMITTED");
    expect(submitted?.confirmedReceipt).toEqual({ messageId: "<abc@test>", acceptedAt: "2026-08-03T00:00:05.000Z" });
    expect(submitted?.submittedAt).toBeInstanceOf(Date);

    const detail = await getApplicationDetail(db, applicationId);
    expect(detail?.application.state).toBe("SUBMITTED");
    expect(detail?.application.submittedAt).toBeInstanceOf(Date);
    expect(detail?.events.at(-1)?.trigger).toBe("attempt");
    expect(detail?.events.at(-1)?.toState).toBe("SUBMITTED");

    const attempts = await listAttemptsForApplication(db, applicationId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.id).toBe(attempt.id);
  });

  it("consumes a confirmation exactly once — a second beginSubmission refuses", async () => {
    const { attemptId, confirmationId } = await previewed("Single Use Co");

    const first = await beginSubmission(db, { attemptId, confirmationId, pendingReceipt: { n: 1 } });
    expect(first).toEqual({ ok: true });

    const second = await beginSubmission(db, { attemptId, confirmationId, pendingReceipt: { n: 2 } });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/consumed/i);

    const attempt = await getEmailAttempt(db, attemptId);
    expect(attempt?.status).toBe("SUBMITTING");
    expect(attempt?.pendingReceipt).toEqual({ n: 1 });
  });

  it("refuses beginSubmission when an expired confirmation is presented", async () => {
    const applicationId = await readyApplication("Expired Co");
    const attempt = await createEmailAttempt(db, { applicationId, draft, connectionId });
    const preview = await recordPreview(db, {
      attemptId: attempt.id, payloadFingerprint: "fp-expired", target: draft.to,
      tokenHash: hashConfirmationToken("stale"), expiresAt: new Date(Date.now() - 1_000),
    });
    expect(preview).toEqual({ ok: true });
    expect(await getActiveConfirmation(db, attempt.id)).toBeNull();

    const [row] = await db.select().from(attemptConfirmations)
      .where(eq(attemptConfirmations.attemptId, attempt.id));
    const begun = await beginSubmission(db, {
      attemptId: attempt.id, confirmationId: row!.id, pendingReceipt: {},
    });
    expect(begun.ok).toBe(false);
    if (!begun.ok) expect(begun.reason).toMatch(/expired/i);
    expect((await getEmailAttempt(db, attempt.id))?.status).toBe("PENDING_CONFIRMATION");
  });

  it("resets an edited attempt to DRAFT, clearing fingerprints so a stale confirmation cannot apply", async () => {
    const { attemptId, confirmationId } = await previewed("Edited Co");

    const edited = await updateEmailDraft(db, attemptId, { ...draft, body: "Different body." }, connectionId);
    expect(edited?.status).toBe("DRAFT");
    expect(edited?.payloadFingerprint).toBeNull();
    expect(edited?.targetFingerprint).toBeNull();

    const begun = await beginSubmission(db, { attemptId, confirmationId, pendingReceipt: {} });
    expect(begun.ok).toBe(false);
    if (!begun.ok) expect(begun.reason).toMatch(/changed|no attempt transition/i);
  });

  it("refuses to edit or preview an attempt that is already submitting", async () => {
    const { attemptId, confirmationId } = await previewed("Locked Co");
    expect(await beginSubmission(db, { attemptId, confirmationId, pendingReceipt: {} })).toEqual({ ok: true });

    expect(await updateEmailDraft(db, attemptId, draft, connectionId)).toBeNull();

    const preview = await recordPreview(db, {
      attemptId, payloadFingerprint: "fp", target: draft.to,
      tokenHash: hashConfirmationToken("late"), expiresAt: new Date(Date.now() + 600_000),
    });
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.reason).toMatch(/no attempt transition/i);
  });

  it("records a failed submission with its reason and refuses an illegal fail transition", async () => {
    const { attemptId, confirmationId, applicationId } = await previewed("Failure Co");
    expect(await beginSubmission(db, { attemptId, confirmationId, pendingReceipt: {} })).toEqual({ ok: true });

    await failSubmission(db, attemptId, "connection refused");
    const failed = await getEmailAttempt(db, attemptId);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.failureReason).toBe("connection refused");

    const detail = await getApplicationDetail(db, applicationId);
    expect(detail?.application.state).toBe("READY_FOR_REVIEW");

    const fresh = await createEmailAttempt(db, { applicationId, draft, connectionId });
    await expect(failSubmission(db, fresh.id, "too early")).rejects.toThrow(/no attempt transition/i);
  });

  it("resolves a NEEDS_RECONCILE attempt as submitted, moving the application", async () => {
    const { attemptId, applicationId, confirmationId } = await previewed("Reconcile Submitted Co");
    expect(await beginSubmission(db, { attemptId, confirmationId, pendingReceipt: {} })).toEqual({ ok: true });

    await markNeedsReconcile(db, attemptId, "smtp timed out after DATA");
    const stuck = await getEmailAttempt(db, attemptId);
    expect(stuck?.status).toBe("NEEDS_RECONCILE");
    expect(stuck?.failureReason).toBe("smtp timed out after DATA");

    const resolved = await resolveReconcile(db, {
      attemptId, resolution: "submitted", evidence: { note: "found in Sent folder" },
    });
    expect(resolved).toEqual({ ok: true });

    const attempt = await getEmailAttempt(db, attemptId);
    expect(attempt?.status).toBe("SUBMITTED");
    expect(attempt?.submittedAt).toBeInstanceOf(Date);
    expect(attempt?.confirmedReceipt).toMatchObject({ resolution: "submitted", evidence: { note: "found in Sent folder" } });
    expect((await getApplicationDetail(db, applicationId))?.application.state).toBe("SUBMITTED");
  });

  it("resolves a NEEDS_RECONCILE attempt as failed, leaving the application alone", async () => {
    const { attemptId, applicationId, confirmationId } = await previewed("Reconcile Failed Co");
    expect(await beginSubmission(db, { attemptId, confirmationId, pendingReceipt: {} })).toEqual({ ok: true });
    await markNeedsReconcile(db, attemptId, "unknown outcome");

    const resolved = await resolveReconcile(db, {
      attemptId, resolution: "failed", evidence: { note: "nothing in Sent folder" },
    });
    expect(resolved).toEqual({ ok: true });

    const attempt = await getEmailAttempt(db, attemptId);
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.failureReason).toMatch(/reconcil/i);
    expect(attempt?.confirmedReceipt).toMatchObject({ resolution: "failed" });
    expect((await getApplicationDetail(db, applicationId))?.application.state).toBe("READY_FOR_REVIEW");
  });

  it("refuses to resolve an attempt that is not awaiting reconciliation", async () => {
    const { attemptId } = await previewed("Not Stuck Co");
    const resolved = await resolveReconcile(db, { attemptId, resolution: "submitted" });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toMatch(/no attempt transition/i);
    expect((await getEmailAttempt(db, attemptId))?.status).toBe("PENDING_CONFIRMATION");
  });

  it("reports blocking attempts: in-flight while submitting, confirmed once submitted", async () => {
    const { attemptId, applicationId, confirmationId } = await previewed("Blocking Co");
    expect(await hasBlockingAttempt(db, applicationId)).toEqual({ confirmed: false, inFlight: false });

    expect(await beginSubmission(db, { attemptId, confirmationId, pendingReceipt: {} })).toEqual({ ok: true });
    expect(await hasBlockingAttempt(db, applicationId)).toEqual({ confirmed: false, inFlight: true });

    expect(await completeSubmission(db, { attemptId, confirmedReceipt: { messageId: "<b@test>" } })).toEqual({ ok: true });
    expect(await hasBlockingAttempt(db, applicationId)).toEqual({ confirmed: true, inFlight: false });
  });

  it("surfaces the one-submitted-attempt index as a refusal, not a throw", async () => {
    const { attemptId, applicationId, confirmationId } = await previewed("Duplicate Co");
    expect(await beginSubmission(db, { attemptId, confirmationId, pendingReceipt: {} })).toEqual({ ok: true });
    expect(await completeSubmission(db, { attemptId, confirmedReceipt: { messageId: "<first@test>" } })).toEqual({ ok: true });

    const second = await createEmailAttempt(db, { applicationId, draft, connectionId });
    const preview = await recordPreview(db, {
      attemptId: second.id, payloadFingerprint: "fp-2", target: draft.to,
      tokenHash: hashConfirmationToken("second"), expiresAt: new Date(Date.now() + 600_000),
    });
    expect(preview).toEqual({ ok: true });
    const secondConfirmation = await getActiveConfirmation(db, second.id);
    expect(await beginSubmission(db, {
      attemptId: second.id, confirmationId: secondConfirmation!.id, pendingReceipt: {},
    })).toEqual({ ok: true });

    const completed = await completeSubmission(db, { attemptId: second.id, confirmedReceipt: { messageId: "<dup@test>" } });
    expect(completed.ok).toBe(false);
    if (!completed.ok) expect(completed.reason).toMatch(/already submitted/i);

    // The refusal rolled the whole transaction back: the duplicate stays in flight
    // for a human to reconcile, and the original receipt is untouched.
    expect((await getEmailAttempt(db, second.id))?.status).toBe("SUBMITTING");
    const first = await getEmailAttempt(db, attemptId);
    expect(first?.status).toBe("SUBMITTED");
    expect(first?.confirmedReceipt).toEqual({ messageId: "<first@test>" });
  });

  it("returns null for an unknown attempt and refuses transitions on it", async () => {
    const missing = randomUUID();
    expect(await getEmailAttempt(db, missing)).toBeNull();
    expect(await updateEmailDraft(db, missing, draft, connectionId)).toBeNull();
    const preview = await recordPreview(db, {
      attemptId: missing, payloadFingerprint: "fp", target: draft.to,
      tokenHash: hashConfirmationToken("ghost"), expiresAt: new Date(Date.now() + 600_000),
    });
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.reason).toMatch(/not found/i);
  });
});
