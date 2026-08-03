"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { emailDraftSchema, type EmailDraft } from "@careerhq/contracts";
import type {
  ApplicationAttempt, CvVariant, EmailConnection, GeneratedDocument,
} from "@careerhq/db";
import type { ConfirmOutcome, PreviewOutcome } from "../../../../lib/email-submission.js";
import {
  confirmAndSendAction, createEmailAttemptAction, previewSubmissionAction,
  resolveReconcileAction, updateEmailDraftAction,
} from "./email-actions.js";

/** The successful half of `PreviewOutcome` — what the review screen renders from. */
type Preview = Extract<PreviewOutcome, { status: "ok" }>;

/** Statuses an attempt may still be edited/previewed from (mirrors the repo/orchestrator). */
const EDITABLE_STATUSES = new Set<ApplicationAttempt["status"]>(["DRAFT", "READY", "PENDING_CONFIRMATION"]);

/** Blocked codes where the confirmation token itself is spent or stale — nothing to retry, a fresh preview is required. */
const REQUIRES_FRESH_PREVIEW = new Set(["fingerprint_mismatch", "token_expired", "token_consumed", "token_invalid"]);

/** What `createEmailAttempt`/`updateEmailDraft` store in `draft_payload`; re-validated, never trusted, same as the orchestrator's own parse. */
const attemptDraftSchema = z.object({ draft: emailDraftSchema, connectionId: z.string().uuid() });

function parseAttemptDraft(value: unknown): { draft: EmailDraft; connectionId: string } | null {
  const parsed = attemptDraftSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function humanizeStatus(status: string): string {
  const lower = status.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function statusBadgeClass(status: ApplicationAttempt["status"]): string {
  if (status === "SUBMITTED") return "badge badge-ok";
  if (status === "FAILED" || status === "BLOCKED") return "badge badge-error";
  if (status === "NEEDS_RECONCILE") return "badge badge-reconcile";
  return "badge";
}

interface EmailPanelProps {
  applicationId: string;
  /** Mailbox connections this workspace can send through; empty means the panel only links to /settings/email. */
  connections: EmailConnection[];
  /** All email attempts for this application, oldest first (as returned by `listAttemptsForApplication`). */
  attempts: ApplicationAttempt[];
  /** For "Use approved email draft" — the newest APPROVED `email_body` document, if any, is offered. */
  documents: GeneratedDocument[];
  /** The application's currently selected CV variant (Task 3's selector state) — the email attachment always follows it. */
  cvVariantId: string | null;
  cvVariants: CvVariant[];
}

/**
 * The email submission panel: a draft editor, a full-payload preview/confirm
 * step, and the resulting outcome, plus the attempt history below it.
 *
 * The confirmation token returned by `previewSubmissionAction` lives ONLY in
 * this component's `preview` state for the lifetime of the confirm
 * round-trip — it is never persisted, never logged, and never rendered; it
 * is read once, from state, to build the `confirmAndSendAction` request.
 */
export function EmailPanel({
  applicationId, connections, attempts, documents, cvVariantId, cvVariants,
}: EmailPanelProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // The attempt currently open for editing: the most recently started one
  // still in an editable status. Everything before it in the array is
  // history (SUBMITTED/FAILED/NEEDS_RECONCILE/BLOCKED are all terminal or
  // human-resolved, never re-entered here).
  const currentAttempt = [...attempts].reverse().find((a) => EDITABLE_STATUSES.has(a.status)) ?? null;
  const alreadySubmitted = attempts.some((a) => a.status === "SUBMITTED");
  const savedDraft = currentAttempt ? parseAttemptDraft(currentAttempt.draftPayload) : null;

  const [attemptId, setAttemptId] = useState<string | null>(currentAttempt?.id ?? null);
  const [to, setTo] = useState(savedDraft?.draft.to ?? "");
  const [subject, setSubject] = useState(savedDraft?.draft.subject ?? "");
  const [body, setBody] = useState(savedDraft?.draft.body ?? "");
  const [connectionId, setConnectionId] = useState(savedDraft?.connectionId ?? connections[0]?.id ?? "");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmOutcome, setConfirmOutcome] = useState<ConfirmOutcome | null>(null);
  const [retypedTarget, setRetypedTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Drives the expiry countdown on the review screen; only ticks while a
  // preview (and therefore a live token) is on screen.
  useEffect(() => {
    if (!preview) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [preview]);

  if (connections.length === 0) {
    return (
      <section className="email-panel">
        <h2>Email submission</h2>
        <p className="email-empty">
          No mailbox connected yet. <a href="/settings/email">Connect a mailbox</a> to submit by email.
        </p>
        <AttemptHistory applicationId={applicationId} attempts={attempts} />
      </section>
    );
  }

  const approvedEmailDoc = documents.find((d) => d.kind === "email_body" && d.approval === "approved") ?? null;
  const selectedVariant = cvVariantId ? cvVariants.find((v) => v.id === cvVariantId) : undefined;

  function handleUseApprovedDraft() {
    if (approvedEmailDoc) setBody(approvedEmailDoc.contentMd);
  }

  function handlePreview() {
    setError(null);
    const trimmedTo = to.trim();
    const trimmedSubject = subject.trim();
    const trimmedBody = body.trim();
    if (!trimmedTo || !trimmedSubject || !trimmedBody) {
      setError("To, subject and body are all required.");
      return;
    }
    if (!connectionId) {
      setError("Choose a mailbox connection to send from.");
      return;
    }

    const draft: EmailDraft = {
      to: trimmedTo, subject: trimmedSubject, body: trimmedBody,
      cvVariantId: cvVariantId ?? undefined,
    };

    startTransition(async () => {
      const saved = attemptId
        ? await updateEmailDraftAction({ applicationId, attemptId, connectionId, draft })
        : await createEmailAttemptAction({ applicationId, connectionId, draft });
      if (!saved.ok) {
        setError(saved.reason);
        return;
      }
      setAttemptId(saved.attemptId);

      const outcome = await previewSubmissionAction({ applicationId, attemptId: saved.attemptId });
      if (outcome.status === "ok") {
        setPreview(outcome);
        setConfirmOutcome(null);
        setRetypedTarget("");
      } else {
        setError(outcome.reason);
      }
    });
  }

  function handleBackToEdit() {
    setPreview(null);
    setConfirmOutcome(null);
    setRetypedTarget("");
  }

  function handleConfirm() {
    if (!preview || !attemptId) return;
    setError(null);
    startTransition(async () => {
      const outcome = await confirmAndSendAction({
        applicationId, attemptId, presentedToken: preview.token, retypedTarget,
      });
      setConfirmOutcome(outcome);

      if (outcome.status === "submitted") {
        setPreview(null);
        router.refresh();
      } else if (outcome.status === "failed" || outcome.status === "needs_reconcile") {
        // The token was already consumed inside `beginSubmission` by this
        // point — nothing left to retry with.
        setPreview(null);
        router.refresh();
      } else if (REQUIRES_FRESH_PREVIEW.has(outcome.code)) {
        // The token/fingerprint itself is stale; only a fresh preview can fix it.
        setPreview(null);
      }
      // Any other blocked code (target_mismatch, gate_closed, sandbox_blocked,
      // connection_unavailable, …) leaves the token unconsumed — keep the
      // preview on screen so the user can correct the retype and try again.
    });
  }

  const canStartNewAttempt = currentAttempt !== null || !alreadySubmitted;

  return (
    <section className="email-panel">
      <h2>Email submission</h2>

      {alreadySubmitted && (
        <p className="email-hint">This application already has a submitted attempt.</p>
      )}

      {!canStartNewAttempt ? null : preview ? (
        <div className="email-preview">
          <h3>Review before sending</h3>
          <dl className="email-preview-fields">
            <dt>To</dt>
            <dd>{preview.payload.to}</dd>
            <dt>Subject</dt>
            <dd>{preview.payload.subject}</dd>
            <dt>Body</dt>
            <dd><pre className="email-preview-body">{preview.payload.body}</pre></dd>
            {preview.payload.attachments[0] && (
              <>
                <dt>Attachment</dt>
                <dd>
                  {preview.payload.attachments[0].filename} — sha256{" "}
                  <code>{preview.payload.attachments[0].sha256.slice(0, 12)}…</code>
                </dd>
              </>
            )}
            <dt>Fingerprint</dt>
            <dd><code>{preview.fingerprint.slice(0, 16)}…</code></dd>
            <dt>Expires</dt>
            <dd>
              <ExpiryCountdown expiresAt={preview.expiresAt} now={now} />
            </dd>
          </dl>

          <label className="email-retype-label">
            Type the recipient address exactly to confirm sending
            <input
              type="text"
              value={retypedTarget}
              onChange={(e) => setRetypedTarget(e.target.value)}
              disabled={isPending}
              autoComplete="off"
            />
          </label>

          <div className="email-preview-actions">
            <button type="button" onClick={handleBackToEdit} disabled={isPending}>
              Back to edit
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={isPending || retypedTarget.trim().length === 0}
            >
              {isPending ? "Sending…" : "Confirm and send"}
            </button>
          </div>

          {confirmOutcome && attemptId && (
            <ConfirmOutcomePane
              outcome={confirmOutcome}
              applicationId={applicationId}
              attemptId={attemptId}
              onResolved={() => setConfirmOutcome(null)}
            />
          )}
        </div>
      ) : (
        <div className="email-editor">
          <label>
            Send from
            <select
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
              disabled={isPending}
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>{c.label} ({c.fromAddress})</option>
              ))}
            </select>
          </label>

          <label>
            To
            <input type="email" value={to} onChange={(e) => setTo(e.target.value)} disabled={isPending} required />
          </label>
          <label>
            Subject
            <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={isPending} required />
          </label>
          <label>
            Body
            <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} disabled={isPending} required />
          </label>
          <button type="button" onClick={handleUseApprovedDraft} disabled={isPending || !approvedEmailDoc}>
            Use approved email draft
          </button>

          <p className="email-attachment-line">
            Attachment: {selectedVariant ? selectedVariant.label : "No CV selected"}{" "}
            <a href="#cv-select">change</a>
          </p>

          {error && <p className="email-error">{error}</p>}
          {confirmOutcome && attemptId && (
            <ConfirmOutcomePane
              outcome={confirmOutcome}
              applicationId={applicationId}
              attemptId={attemptId}
              onResolved={() => setConfirmOutcome(null)}
            />
          )}

          <button type="button" onClick={handlePreview} disabled={isPending}>
            {isPending ? "Working…" : "Preview"}
          </button>
        </div>
      )}

      <h3>Attempt history</h3>
      <AttemptHistory applicationId={applicationId} attempts={attempts} />
    </section>
  );
}

function ExpiryCountdown({ expiresAt, now }: { expiresAt: string; now: number }) {
  const remainingMs = Math.max(0, new Date(expiresAt).getTime() - now);
  if (remainingMs <= 0) {
    return <span className="email-expired">Expired — go back and preview again</span>;
  }
  const totalSeconds = Math.floor(remainingMs / 1000);
  const mm = Math.floor(totalSeconds / 60);
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return <span>{mm}:{ss}</span>;
}

function ConfirmOutcomePane({
  outcome, applicationId, attemptId, onResolved,
}: {
  outcome: ConfirmOutcome;
  applicationId: string;
  attemptId: string;
  onResolved: () => void;
}) {
  switch (outcome.status) {
    case "submitted":
      return (
        <div className="email-outcome email-outcome-submitted">
          <p>Submitted — Message-ID <code>{outcome.messageId}</code></p>
        </div>
      );
    case "blocked":
      return (
        <div className="email-outcome email-outcome-blocked">
          <p>Blocked ({outcome.code}): {outcome.reason}</p>
          {outcome.code === "gate_closed" && (
            <p className="email-outcome-hint">
              Live email submission is off. Set <code>SUBMISSIONS_LIVE_EMAIL=true</code> (and, for a sandbox
              workspace, <code>SANDBOX_SMTP_ALLOWED_HOST</code>) to enable sending.
            </p>
          )}
        </div>
      );
    case "failed":
      return (
        <div className="email-outcome email-outcome-failed">
          <p>Send failed: {outcome.reason}</p>
          <p className="email-outcome-hint">The draft is retained — start a new attempt to retry.</p>
        </div>
      );
    case "needs_reconcile":
      return (
        <ReconcilePane
          applicationId={applicationId}
          attemptId={attemptId}
          reason={outcome.reason}
          onResolved={onResolved}
        />
      );
  }
}

function ReconcilePane({
  applicationId, attemptId, reason, onResolved,
}: {
  applicationId: string;
  attemptId: string;
  reason: string;
  onResolved?: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function resolve(resolution: "submitted" | "failed") {
    setError(null);
    startTransition(async () => {
      const result = await resolveReconcileAction({
        applicationId, attemptId, resolution, evidenceNote: note.trim() || undefined,
      });
      if (result.ok) {
        onResolved?.();
        router.refresh();
      } else {
        setError(result.reason);
      }
    });
  }

  return (
    <div className="email-outcome email-outcome-reconcile">
      <p>Needs reconciliation: {reason}</p>
      <p className="email-outcome-hint">
        The send outcome is uncertain — check the mailbox&apos;s Sent folder or any bounce, then resolve manually.
      </p>
      <label>
        Evidence note (optional)
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} disabled={isPending} />
      </label>
      <div className="email-reconcile-actions">
        <button type="button" disabled={isPending} onClick={() => resolve("submitted")}>
          Mark submitted (with evidence note)
        </button>
        <button type="button" disabled={isPending} onClick={() => resolve("failed")}>
          Mark failed
        </button>
      </div>
      {error && <p className="email-error">{error}</p>}
    </div>
  );
}

function AttemptHistory({ applicationId, attempts }: { applicationId: string; attempts: ApplicationAttempt[] }) {
  if (attempts.length === 0) return <p className="email-empty">No submission attempts yet.</p>;
  return (
    <ul className="email-attempt-list">
      {[...attempts].reverse().map((attempt) => (
        <AttemptRow key={attempt.id} applicationId={applicationId} attempt={attempt} />
      ))}
    </ul>
  );
}

function AttemptRow({ applicationId, attempt }: { applicationId: string; attempt: ApplicationAttempt }) {
  const confirmed = asRecord(attempt.confirmedReceipt);
  const messageId = confirmed ? str(confirmed.messageId) : undefined;
  const receiptAt = confirmed ? (str(confirmed.acceptedAt) ?? str(confirmed.resolvedAt)) : undefined;
  const highlighted = attempt.status === "NEEDS_RECONCILE";

  return (
    <li className={highlighted ? "email-attempt-row email-attempt-row-reconcile" : "email-attempt-row"}>
      <div className="email-attempt-meta">
        <span className={statusBadgeClass(attempt.status)}>{humanizeStatus(attempt.status)}</span>
        <span className="email-attempt-date">{attempt.startedAt.toLocaleString()}</span>
        {messageId && <span className="email-attempt-message-id">Message-ID: {messageId}</span>}
        {receiptAt && <span className="email-attempt-date">receipt: {new Date(receiptAt).toLocaleString()}</span>}
      </div>
      {attempt.failureReason && <p className="email-error">{attempt.failureReason}</p>}
      {highlighted && (
        <ReconcilePane
          applicationId={applicationId}
          attemptId={attempt.id}
          reason={attempt.failureReason ?? "the send outcome is uncertain"}
        />
      )}
    </li>
  );
}
