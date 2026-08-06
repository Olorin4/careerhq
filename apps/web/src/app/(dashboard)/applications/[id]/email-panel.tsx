"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { emailDraftSchema, type EmailDraft } from "@careerhq/contracts";
import type {
  ApplicationAttempt, CvVariant, EmailConnection, GeneratedDocument,
} from "@careerhq/db";
import type { ConfirmOutcome, PreviewOutcome } from "../../../../lib/email-submission.js";
import { formatTimestamp } from "../../../../lib/time.js";
import { Badge } from "../../../../components/badge.js";
import { Button } from "../../../../components/button.js";
import { CONTROL_CLASSES, Field } from "../../../../components/field.js";
import { Countdown } from "../../../../components/countdown.js";
import { EmptyState } from "../../../../components/empty-state.js";
import { OutcomePanel } from "../../../../components/outcome-panel.js";
import { ReconcilePanel } from "../../../../components/reconcile-panel.js";
import { Section } from "../../../../components/section.js";
import { ATTEMPT_TONE } from "../../../../lib/application-state.js";
import {
  confirmAndSendAction, createEmailAttemptAction, previewSubmissionAction,
  resolveReconcileAction, updateEmailDraftAction,
} from "./email-actions.js";

/** The successful half of `PreviewOutcome` — what the review screen renders from. */
type Preview = Extract<PreviewOutcome, { status: "ok" }>;

/** Statuses an attempt may still be edited/previewed from (mirrors the repo/orchestrator). */
const EDITABLE_STATUSES = new Set<ApplicationAttempt["status"]>(["DRAFT", "READY", "PENDING_CONFIRMATION"]);

/** Blocked codes where the confirmation token itself is spent or stale — nothing to retry, a fresh preview is required. */
const REQUIRES_FRESH_PREVIEW = new Set([
  "fingerprint_mismatch", "token_expired", "token_consumed", "token_invalid", "token_missing",
]);

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

  if (connections.length === 0) {
    return (
      <Section title="Email submission">
        <EmptyState
          title="No mailbox connected yet"
          hint="Connect a mailbox to submit by email."
        />
        <p className="m-0 text-sm text-muted">
          <a href="/settings/email" className="font-medium text-ink underline">Connect a mailbox</a>
        </p>
        <AttemptHistory applicationId={applicationId} attempts={attempts} />
      </Section>
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
    <Section title="Email submission">
      {alreadySubmitted && (
        <p className="m-0 text-sm text-muted">This application already has a submitted attempt.</p>
      )}

      {!canStartNewAttempt ? null : preview ? (
        <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4 shadow-card">
          <h3 className="m-0 text-sm font-semibold text-ink">Review before sending</h3>
          <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="font-medium text-muted">To</dt>
            <dd className="m-0 text-ink">{preview.payload.to}</dd>
            <dt className="font-medium text-muted">Subject</dt>
            <dd className="m-0 text-ink">{preview.payload.subject}</dd>
            <dt className="font-medium text-muted">Body</dt>
            <dd className="m-0 text-ink">
              <pre className="m-0 whitespace-pre-wrap font-sans">{preview.payload.body}</pre>
            </dd>
            {preview.payload.attachments[0] && (
              <>
                <dt className="font-medium text-muted">Attachment</dt>
                <dd className="m-0 text-ink">
                  {preview.payload.attachments[0].filename} — sha256{" "}
                  <code>{preview.payload.attachments[0].sha256.slice(0, 12)}…</code>
                </dd>
              </>
            )}
            <dt className="font-medium text-muted">Fingerprint</dt>
            <dd className="m-0 text-ink"><code>{preview.fingerprint.slice(0, 16)}…</code></dd>
            <dt className="font-medium text-muted">Expires</dt>
            <dd className="m-0 text-ink tabular-nums">
              <Countdown expiresAt={preview.expiresAt} />
            </dd>
          </dl>
          <p className="m-0 text-xs text-muted">If this expires, go back and preview again.</p>

          <Field label="Type the recipient address exactly to confirm sending">
            <input
              type="text"
              value={retypedTarget}
              onChange={(e) => setRetypedTarget(e.target.value)}
              disabled={isPending}
              autoComplete="off"
              className={CONTROL_CLASSES}
            />
          </Field>

          <div className="flex gap-2">
            <Button type="button" onClick={handleBackToEdit} disabled={isPending}>
              Back to edit
            </Button>
            {/*
              `default` tone, deliberately — the page's single `irreversible`
              control is `site-panel.tsx`'s "Confirm and submit". Email
              sending is a real external action too, but the tone is
              reserved for exactly one control on this page so a user learns
              to recognise it on sight; see that file's own note.
            */}
            <Button
              type="button"
              onClick={handleConfirm}
              disabled={isPending || retypedTarget.trim().length === 0}
            >
              {isPending ? "Sending…" : "Confirm and send"}
            </Button>
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
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-card">
          <Field label="Send from">
            <select
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
              disabled={isPending}
              className={CONTROL_CLASSES}
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>{c.label} ({c.fromAddress})</option>
              ))}
            </select>
          </Field>

          <Field label="To">
            <input
              type="email" value={to} onChange={(e) => setTo(e.target.value)} disabled={isPending} required
              className={CONTROL_CLASSES}
            />
          </Field>
          <Field label="Subject">
            <input
              type="text" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={isPending} required
              className={CONTROL_CLASSES}
            />
          </Field>
          <Field label="Body">
            <textarea
              rows={8} value={body} onChange={(e) => setBody(e.target.value)} disabled={isPending} required
              className={CONTROL_CLASSES}
            />
          </Field>
          <div>
            <Button type="button" onClick={handleUseApprovedDraft} disabled={isPending || !approvedEmailDoc}>
              Use approved email draft
            </Button>
          </div>

          <p className="m-0 text-sm text-muted">
            Attachment: {selectedVariant ? selectedVariant.label : "No CV selected"}{" "}
            <a href="#cv-select" className="font-medium text-ink underline">change</a>
          </p>

          {error && (
            <p className="m-0 text-sm text-bad" role="alert">
              {error}
            </p>
          )}
          {confirmOutcome && attemptId && (
            <ConfirmOutcomePane
              outcome={confirmOutcome}
              applicationId={applicationId}
              attemptId={attemptId}
              onResolved={() => setConfirmOutcome(null)}
            />
          )}

          <div>
            <Button type="button" tone="primary" onClick={handlePreview} disabled={isPending}>
              {isPending ? "Working…" : "Preview"}
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-sm font-semibold text-ink">Attempt history</h3>
        <AttemptHistory applicationId={applicationId} attempts={attempts} />
      </div>
    </Section>
  );
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
        <OutcomePanel tone="ok">
          <p className="m-0">Submitted — Message-ID <code>{outcome.messageId}</code></p>
        </OutcomePanel>
      );
    case "blocked":
      return (
        <OutcomePanel tone="warn">
          <p className="m-0">Blocked ({outcome.code}): {outcome.reason}</p>
          {outcome.code === "gate_closed" && (
            <p className="m-0 text-xs text-muted">
              Live email submission is off. Set <code>SUBMISSIONS_LIVE_EMAIL=true</code> (and, for a sandbox
              workspace, <code>SANDBOX_SMTP_ALLOWED_HOST</code>) to enable sending.
            </p>
          )}
          {outcome.code === "application_not_ready" && (
            <p className="m-0 text-xs text-muted">
              This application is no longer in a state that can be submitted from. Re-typing the address won&apos;t
              fix this — use the transition buttons above to walk it back to Ready for review, then confirm again.
            </p>
          )}
        </OutcomePanel>
      );
    case "failed":
      return (
        <OutcomePanel tone="bad">
          <p className="m-0">Send failed: {outcome.reason}</p>
          <p className="m-0 text-xs text-muted">The draft is retained — start a new attempt to retry.</p>
        </OutcomePanel>
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
    <ReconcilePanel reason={reason}>
      <p className="m-0 text-xs text-muted">
        The send outcome is uncertain — check the mailbox&apos;s Sent folder or any bounce, then resolve manually.
      </p>
      <Field label="Evidence note (optional)">
        <input
          type="text" value={note} onChange={(e) => setNote(e.target.value)} disabled={isPending}
          className={CONTROL_CLASSES}
        />
      </Field>
      <div className="flex gap-2">
        <Button type="button" disabled={isPending} onClick={() => resolve("submitted")}>
          Mark submitted (with evidence note)
        </Button>
        <Button type="button" disabled={isPending} onClick={() => resolve("failed")}>
          Mark failed
        </Button>
      </div>
      {error && (
        <p className="m-0 text-sm text-bad" role="alert">
          {error}
        </p>
      )}
    </ReconcilePanel>
  );
}

function AttemptHistory({ applicationId, attempts }: { applicationId: string; attempts: ApplicationAttempt[] }) {
  if (attempts.length === 0) return <p className="m-0 text-sm text-soft">No submission attempts yet.</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
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
    <li className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-3 shadow-card">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={ATTEMPT_TONE[attempt.status]}>{humanizeStatus(attempt.status)}</Badge>
        <span className="text-xs text-soft">{formatTimestamp(attempt.startedAt)}</span>
        {messageId && <span className="text-xs text-muted">Message-ID: {messageId}</span>}
        {receiptAt && <span className="text-xs text-soft">receipt: {formatTimestamp(receiptAt)}</span>}
      </div>
      {attempt.failureReason && (
        <p className="m-0 text-sm text-bad" role="alert">
          {attempt.failureReason}
        </p>
      )}
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
