"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import {
  canonicalFormSchema, plannedAnswerSchema,
  type AnswerSource, type BlockerKind, type CanonicalForm, type CanonicalFormField, type PlannedAnswer,
} from "@careerhq/contracts";
import { isConsentOnlyField, isSensitiveField, requiresUserBeforeSubmit } from "@careerhq/core";
import type { ApplicationAttempt, CvVariant, FormSnapshot, SiteAttemptDraft } from "@careerhq/db";
import type { PrepareOutcome, SiteConfirmOutcome, SitePreviewOutcome } from "../../../../lib/site-submission.js";
import { safeExternalHref } from "../../../../lib/safe-url.js";
import { formatTimestamp } from "../../../../lib/time.js";
import { Badge, type BadgeTone } from "../../../../components/badge.js";
import { Button } from "../../../../components/button.js";
import { CONTROL_CLASSES, Field } from "../../../../components/field.js";
import { Countdown } from "../../../../components/countdown.js";
import { OutcomePanel } from "../../../../components/outcome-panel.js";
import { ReconcilePanel } from "../../../../components/reconcile-panel.js";
import { Section } from "../../../../components/section.js";
import { ATTEMPT_TONE } from "../../../../lib/application-state.js";
import { resolveReconcileAction } from "./email-actions.js";
import {
  confirmAndSubmitSiteAction, prepareSiteApplicationAction, previewSiteSubmissionAction,
  updatePlannedAnswerAction,
} from "./site-actions.js";

/** The successful half of `SitePreviewOutcome` — what the confirm screen renders from. */
type Preview = Extract<SitePreviewOutcome, { status: "ok" }>;

/** The form + answers the review screen edits, whichever produced it: a fresh prepare or a reloaded snapshot. */
interface ReadyState {
  attemptId: string;
  snapshotId: string;
  form: CanonicalForm;
  answers: PlannedAnswer[];
}

/** Statuses a site attempt may still be edited/previewed from (mirrors the repo/orchestrator). */
const EDITABLE_STATUSES = new Set<ApplicationAttempt["status"]>(["DRAFT", "READY", "PENDING_CONFIRMATION"]);

/** Blocked codes where the confirmation token itself is spent or stale — nothing to retry, a fresh preview is required. */
const REQUIRES_FRESH_PREVIEW = new Set([
  "fingerprint_mismatch", "token_expired", "token_consumed", "token_invalid", "token_missing",
]);

/**
 * What a server action THROWING looks like to the visitor (P6 final review, A4).
 *
 * Every handler below awaits a server action that answers with an outcome
 * object, and every failure worth telling a user about arrives that way. But an
 * action can still throw: `prepareSiteApplication` resolves the application,
 * captures the page for several seconds and only then inserts the attempt, so a
 * demo reset committing inside that window makes the insert violate a foreign
 * key — and an uncaught throw out of a server action reaches the browser as the
 * full-page "Application error" overlay, which is the same thing an oversized
 * upload used to do (BLOCKING 2) and tells the visitor nothing.
 *
 * The thrown value is deliberately NOT rendered: React replaces a server
 * action's error with an opaque digest in production, so there is no message to
 * show, and the raw one would be a stack or a Postgres constraint name.
 */
const ACTION_THREW = "Something went wrong on the server. Nothing was submitted — try again in a moment.";

/**
 * The same accident during the confirm, where "nothing happened" is not a claim
 * this code is entitled to make: `confirmAndSubmitSite` classifies everything
 * the driver does itself, so a throw that escapes it comes from around that —
 * and the honest instruction is to look before confirming again, never to
 * retry blind. Attempt history below the panel is where the answer is.
 */
const CONFIRM_THREW =
  "The server did not answer this confirmation. Do not confirm again until you have checked the attempt "
  + "history below — it records whether the submission started.";

/** Brief §10.2.8's exact badge labels, in `ANSWER_SOURCES` order. */
const SOURCE_LABELS: Record<AnswerSource, string> = {
  fact: "Fact",
  saved_answer: "Saved answer",
  profile: "Profile",
  ai: "AI — not yet approved",
  user: "You",
  document: "Document",
};

/**
 * Colour per answer source: a verified fact, a reused prior answer, a
 * profile field or a source document are all the applicant's own vetted
 * data (`ok`); an AI guess is exactly the design vocabulary's
 * "AI-generated — not yet approved" example (`warn`); a value the user
 * typed themselves is neither verified-and-done nor pending review, so it
 * stays `neutral`.
 */
const SOURCE_TONE: Record<AnswerSource, BadgeTone> = {
  fact: "ok",
  saved_answer: "ok",
  profile: "ok",
  document: "ok",
  ai: "warn",
  user: "neutral",
};

const plannedAnswersSchema = z.array(plannedAnswerSchema);

function humanize(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function parseSiteDraft(value: unknown): SiteAttemptDraft | null {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const url = record && typeof record.url === "string" ? record.url : null;
  return url ? { url } : null;
}

function parseSnapshot(
  snapshot: FormSnapshot,
): { id: string; form: CanonicalForm; answers: PlannedAnswer[] } | null {
  const form = canonicalFormSchema.safeParse(snapshot.canonicalForm);
  const answers = plannedAnswersSchema.safeParse(snapshot.plannedAnswers);
  if (!form.success || !answers.success) return null;
  return { id: snapshot.id, form: form.data, answers: answers.data };
}

/** `failureReason` on a blocked attempt is stored as `${kind}: ${detail}` (see `prepareSiteApplication`). */
function splitBlockedReason(reason: string): { kind: string; detail: string } {
  const sep = reason.indexOf(": ");
  return sep === -1 ? { kind: reason, detail: "" } : { kind: reason.slice(0, sep), detail: reason.slice(sep + 2) };
}

interface SitePanelProps {
  applicationId: string;
  /** Every attempt for this application, oldest first — filtered here to the company-site channel. */
  attempts: ApplicationAttempt[];
  /** The latest form snapshot for the current editable attempt, if any (server-fetched, see page.tsx). */
  latestSnapshot: FormSnapshot | null;
  /** The application's currently selected CV variant (Task 3's selector) — the resume field's fallback chain starts here. */
  cvVariantId: string | null;
  cvVariants: CvVariant[];
}

/**
 * The auto-apply review screen: a URL/prepare form, the field-by-field
 * review grid with per-answer provenance, the payload preview/confirm step,
 * and the resulting outcome, plus attempt history below it.
 *
 * The confirmation token returned by `previewSiteSubmissionAction` lives ONLY
 * in this component's `preview` state for the lifetime of the confirm
 * round-trip — never persisted, never logged, never rendered.
 */
export function SitePanel({ applicationId, attempts, latestSnapshot, cvVariantId, cvVariants }: SitePanelProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const siteAttempts = useMemo(() => attempts.filter((a) => a.channel === "company_site"), [attempts]);
  const currentAttempt = [...siteAttempts].reverse().find((a) => EDITABLE_STATUSES.has(a.status)) ?? null;
  const alreadySubmitted = siteAttempts.some((a) => a.status === "SUBMITTED");
  const savedDraft = currentAttempt ? parseSiteDraft(currentAttempt.draftPayload) : null;
  const parsedSnapshot =
    currentAttempt && latestSnapshot && latestSnapshot.attemptId === currentAttempt.id
      ? parseSnapshot(latestSnapshot)
      : null;

  const [url, setUrl] = useState(savedDraft?.url ?? "");
  const [prepareOutcome, setPrepareOutcome] = useState<PrepareOutcome | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmOutcome, setConfirmOutcome] = useState<SiteConfirmOutcome | null>(null);
  const [retypedTarget, setRetypedTarget] = useState("");
  const [error, setError] = useState<string | null>(null);

  const readyState: ReadyState | null = useMemo(() => {
    if (prepareOutcome?.status === "ready") {
      return {
        attemptId: prepareOutcome.attemptId, snapshotId: prepareOutcome.snapshotId,
        form: prepareOutcome.form, answers: prepareOutcome.answers,
      };
    }
    if (currentAttempt && parsedSnapshot) {
      return {
        attemptId: currentAttempt.id, snapshotId: parsedSnapshot.id,
        form: parsedSnapshot.form, answers: parsedSnapshot.answers,
      };
    }
    return null;
  }, [prepareOutcome, currentAttempt, parsedSnapshot]);

  function handlePrepare(overrideDuplicate?: boolean) {
    setError(null);
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setError("Enter the application page URL.");
      return;
    }
    startTransition(async () => {
      try {
        const outcome = await prepareSiteApplicationAction({ applicationId, url: trimmedUrl, overrideDuplicate });
        setPrepareOutcome(outcome);
        setConfirmOutcome(null);
        if (outcome.status !== "failed") router.refresh();
      } catch {
        setError(ACTION_THREW);
      }
    });
  }

  function handlePreview() {
    if (!readyState) return;
    setError(null);
    startTransition(async () => {
      try {
        const outcome = await previewSiteSubmissionAction({ applicationId, attemptId: readyState.attemptId });
        if (outcome.status === "ok") {
          setPreview(outcome);
          setConfirmOutcome(null);
          setRetypedTarget("");
        } else {
          setError(outcome.reason);
        }
      } catch {
        setError(ACTION_THREW);
      }
    });
  }

  function handleBackToEdit() {
    setPreview(null);
    setConfirmOutcome(null);
    setRetypedTarget("");
  }

  function handleConfirm() {
    if (!preview || !readyState) return;
    setError(null);
    startTransition(async () => {
      let outcome;
      try {
        outcome = await confirmAndSubmitSiteAction({
          applicationId, attemptId: readyState.attemptId, presentedToken: preview.token, retypedTarget,
        });
      } catch {
        // Not `setConfirmOutcome`: there IS no outcome, and the panel must not
        // imply one. The preview stays on screen with the warning above it.
        setError(CONFIRM_THREW);
        router.refresh();
        return;
      }
      setConfirmOutcome(outcome);

      if (outcome.status === "submitted") {
        setPreview(null);
        setPrepareOutcome(null);
        router.refresh();
      } else if (outcome.status === "failed" || outcome.status === "needs_reconcile") {
        // The token was already consumed inside `beginSubmission` by this point — nothing left to retry with.
        setPreview(null);
        router.refresh();
      } else if (REQUIRES_FRESH_PREVIEW.has(outcome.code)) {
        // The token/fingerprint itself is stale; only a fresh preview can fix it.
        setPreview(null);
      }
      // Any other blocked code (gate_closed, sandbox_blocked, driver_unavailable, application_not_ready,
      // review_required, driver_refused, …) leaves the token unconsumed — keep the preview on screen so
      // the user can retry once the underlying condition is fixed. `driver_refused` is the one that
      // reaches this branch from AFTER `beginSubmission`: the driver refused before it clicked anything,
      // so the orchestrator gave the confirmation back and the preview on screen is still redeemable.
    });
  }

  const canStartNewAttempt = currentAttempt !== null || !alreadySubmitted;

  return (
    <Section title="Auto-apply (company site)" testId="site-panel">
      {alreadySubmitted && !currentAttempt && (
        <p className="m-0 text-sm text-muted">This application already has a submitted attempt.</p>
      )}

      {confirmOutcome && readyState && (
        <SiteConfirmOutcomePane
          outcome={confirmOutcome}
          applicationId={applicationId}
          attemptId={readyState.attemptId}
          onResolved={() => setConfirmOutcome(null)}
        />
      )}

      {!canStartNewAttempt ? null : preview ? (
        <SitePreviewPane
          preview={preview}
          retypedTarget={retypedTarget}
          setRetypedTarget={setRetypedTarget}
          isPending={isPending}
          onBack={handleBackToEdit}
          onConfirm={handleConfirm}
        />
      ) : readyState ? (
        <ReviewForm
          applicationId={applicationId}
          readyState={readyState}
          cvVariantId={cvVariantId}
          cvVariants={cvVariants}
          reviewUrl={savedDraft?.url ?? url}
          isPending={isPending}
          startTransition={startTransition}
          onPreview={handlePreview}
        />
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-card">
          <Field label="Application page URL">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={isPending}
              placeholder="https://boards.greenhouse.io/…"
              autoComplete="off"
              className={CONTROL_CLASSES}
              data-testid="site-url-input"
            />
          </Field>
          <div>
            <Button type="button" tone="primary" onClick={() => handlePrepare()} disabled={isPending}>
              {isPending ? "Reading the page…" : "Prepare"}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p className="m-0 text-sm text-bad" role="alert">
          {error}
        </p>
      )}

      {!readyState && prepareOutcome && prepareOutcome.status !== "ready" && (
        <PrepareOutcomePane
          outcome={prepareOutcome}
          url={url}
          isPending={isPending}
          onRetry={() => handlePrepare()}
          onOverride={() => handlePrepare(true)}
        />
      )}

      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-sm font-semibold text-ink">Attempt history</h3>
        <SiteAttemptHistory applicationId={applicationId} attempts={siteAttempts} />
      </div>
    </Section>
  );
}

const BLOCKER_HINT: Partial<Record<BlockerKind, string>> = {
  login_required: "A sign-in or account-creation wall usually clears in seconds — finish it, then Retry.",
};

function PrepareOutcomePane({
  outcome, url, isPending, onRetry, onOverride,
}: {
  outcome: Exclude<PrepareOutcome, { status: "ready" }>;
  url: string;
  isPending: boolean;
  onRetry: () => void;
  onOverride: () => void;
}) {
  if (outcome.status === "blocked") {
    const safeUrl = safeExternalHref(url.trim());
    return (
      <OutcomePanel tone="warn" testId="site-outcome">
        <p className="m-0 font-medium">Paused — {humanize(outcome.kind)}</p>
        <p className="m-0">{outcome.detail}</p>
        <p className="m-0 text-xs text-muted">
          This is a pause, not a failure: nothing was submitted.{" "}
          {safeUrl && (
            <a href={safeUrl} target="_blank" rel="noreferrer" className="font-medium text-ink underline">
              Open the application in your browser
            </a>
          )}{" "}
          to finish it yourself.{BLOCKER_HINT[outcome.kind] ? ` ${BLOCKER_HINT[outcome.kind]}` : ""}
        </p>
        <div>
          <Button type="button" onClick={onRetry} disabled={isPending}>
            {isPending ? "Retrying…" : "Retry prepare"}
          </Button>
        </div>
      </OutcomePanel>
    );
  }
  if (outcome.status === "duplicate") {
    return (
      <OutcomePanel tone="warn" testId="site-outcome">
        <p className="m-0">A submitted attempt for this requisition already exists.</p>
        <p className="m-0">
          <a href={`/applications/${outcome.existingApplicationId}`} className="font-medium text-ink underline">
            View the existing application
          </a>
        </p>
        <div>
          <Button type="button" onClick={onOverride} disabled={isPending}>
            {isPending ? "Applying…" : "Apply anyway"}
          </Button>
        </div>
      </OutcomePanel>
    );
  }
  return (
    <OutcomePanel tone="bad" testId="site-outcome">
      <p className="m-0">{outcome.reason}</p>
    </OutcomePanel>
  );
}

interface ReviewFormProps {
  applicationId: string;
  readyState: ReadyState;
  cvVariantId: string | null;
  cvVariants: CvVariant[];
  reviewUrl: string;
  isPending: boolean;
  startTransition: (fn: () => Promise<void> | void) => void;
  onPreview: () => void;
}

/**
 * The field-by-field review grid: every planned answer, grouped by step, each
 * editable with its provenance shown, plus the summary bar and the gated
 * Preview button (spec §10.2.8 — the phase's showpiece).
 */
function ReviewForm({
  applicationId, readyState, cvVariantId, cvVariants, reviewUrl, isPending, startTransition, onPreview,
}: ReviewFormProps) {
  const { snapshotId, form, answers: initialAnswers } = readyState;
  const [answers, setAnswers] = useState<PlannedAnswer[]>(initialAnswers);
  const [saveError, setSaveError] = useState<string | null>(null);

  // A fresh snapshot (a new prepare, or Retry-prepare) replaces the local edit buffer wholesale.
  useEffect(() => setAnswers(initialAnswers), [snapshotId, initialAnswers]);

  const answerByFieldId = useMemo(() => new Map(answers.map((a) => [a.fieldId, a])), [answers]);
  const blocking = useMemo(() => requiresUserBeforeSubmit(answers, form), [answers, form]);
  const blockingLabels = useMemo(
    () => blocking.map((id) => form.fields.find((f) => f.id === id)?.label || id),
    [blocking, form],
  );

  function commitAnswer(fieldId: string, value: string) {
    setSaveError(null);
    setAnswers((prev) => prev.map((a) => {
      if (a.fieldId !== fieldId) return a;
      // Blanking a REQUIRED field still blocks Preview (`requiresUserBeforeSubmit` checks
      // required-and-empty ahead of `needsUser`) — clearing the badge here would make the
      // row look resolved while it still blocks. Only clear it when there is a value, or
      // the field was never required in the first place.
      const field = form.fields.find((f) => f.id === fieldId);
      const stillNeedsUser = value.trim() === "" && (field?.required ?? false);
      return {
        ...a, value, source: "user", confidence: 1,
        needsUser: stillNeedsUser, differsFromApproved: false, note: "",
      };
    }));
    startTransition(async () => {
      try {
        const result = await updatePlannedAnswerAction({ applicationId, snapshotId, fieldId, value });
        if (!result.ok) setSaveError(result.reason);
      } catch {
        // The row above already shows the new value optimistically, so a silent
        // throw would leave the user believing an answer was saved that was not.
        setSaveError(ACTION_THREW);
      }
    });
  }

  const steps = useMemo(
    () => [...new Set(form.fields.map((f) => f.step))].sort((a, b) => a - b),
    [form.fields],
  );

  const resumeField = form.fields.find((f) => f.kind === "file" && f.canonicalField === "resume_file");
  const resumeAnswer = resumeField ? answerByFieldId.get(resumeField.id) : undefined;
  const attachedVariant = resumeAnswer?.value
    ? cvVariants.find((v) => v.id === resumeAnswer.value)
    : cvVariantId
      ? cvVariants.find((v) => v.id === cvVariantId)
      : undefined;
  const safeReviewUrl = safeExternalHref(reviewUrl);

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4 shadow-card" data-testid="site-review">
      <div className="flex flex-col gap-1">
        <p className="m-0 text-sm text-muted">
          Reviewing {safeReviewUrl ? (
            <a href={safeReviewUrl} target="_blank" rel="noreferrer" className="font-medium text-ink underline">
              {reviewUrl}
            </a>
          ) : (
            reviewUrl
          )}
        </p>

        <p className="m-0 text-sm text-ink">
          CV that will be attached:{" "}
          <strong>{attachedVariant ? attachedVariant.label : "No CV variant selected"}</strong>{" "}
          <a href="#cv-select" className="font-medium text-ink underline">change</a>
        </p>

        <p className="m-0 text-sm font-semibold text-ink">
          {form.fields.length} fields · {blocking.length} need you
        </p>
      </div>

      {steps.map((step) => (
        <section key={step} className="flex flex-col gap-2" data-testid="site-step">
          <h4 className="m-0 text-sm font-semibold text-ink">Step {step + 1} of {form.totalSteps}</h4>
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="w-full border-collapse text-sm">
              <tbody>
                {form.fields
                  .filter((f) => f.step === step && f.kind !== "hidden")
                  .map((field) => {
                    const answer = answerByFieldId.get(field.id);
                    if (!answer) return null;
                    return (
                      <FieldRow
                        key={field.id}
                        field={field}
                        answer={answer}
                        cvVariants={cvVariants}
                        onCommit={commitAnswer}
                        disabled={isPending}
                      />
                    );
                  })}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {saveError && (
        <p className="m-0 text-sm text-bad" role="alert">
          {saveError}
        </p>
      )}

      <div className="flex flex-col gap-1">
        <div>
          <Button type="button" tone="primary" onClick={onPreview} disabled={isPending || blocking.length > 0}>
            {isPending ? "Working…" : "Preview"}
          </Button>
        </div>
        {blocking.length > 0 && (
          <p className="m-0 text-xs text-warn">Still need you: {blockingLabels.join(", ")}</p>
        )}
      </div>
    </div>
  );
}

const FIELD_CELL = "border-b border-line px-3 py-2 align-top";

function FieldRow({
  field, answer, cvVariants, onCommit, disabled,
}: {
  field: CanonicalFormField;
  answer: PlannedAnswer;
  cvVariants: CvVariant[];
  onCommit: (fieldId: string, value: string) => void;
  disabled: boolean;
}) {
  // A consent-only field (legal_attestation / criminal_history, by canonical field OR by
  // label — see isConsentOnlyField) is never satisfied by a saved answer from another
  // application, so it always needs a *fresh* tick from this user, on this application.
  // It gets its own row shape — full statement text, explicit consent copy, a control that
  // is provably never pre-ticked — rather than reusing the generic sensitive-lock row, which
  // would bury the statement being agreed to in a truncatable label column.
  if (isConsentOnlyField(field)) {
    return <ConsentFieldRow field={field} answer={answer} cvVariants={cvVariants} onCommit={onCommit} disabled={disabled} />;
  }

  // `isSensitiveField` is a static category (never AI-answerable), independent
  // of whether THIS row still needs the user right now — a non-stale saved
  // answer can satisfy it. The lock badge is therefore `info` (a standing
  // note about the field), kept visually distinct from the `warn` "Needs
  // your answer" badge below, which only appears when `needsUser` is true.
  const sensitive = isSensitiveField(field);
  const rowClass = answer.needsUser ? "bg-warn-soft" : "";

  return (
    <tr className={rowClass} data-testid={answer.needsUser ? "site-field-needs-you" : undefined}>
      <td className={`${FIELD_CELL} w-[22%] font-medium text-ink`}>
        {field.label || field.id}
        {field.required && <span className="ml-0.5 text-bad" title="Required">*</span>}
      </td>
      <td className={`${FIELD_CELL} w-[30%]`}>
        <FieldInput field={field} answer={answer} cvVariants={cvVariants} onCommit={onCommit} disabled={disabled} />
      </td>
      <td className={FIELD_CELL}>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={SOURCE_TONE[answer.source]}>{SOURCE_LABELS[answer.source]}</Badge>
          <span className="text-xs text-soft">{Math.round(answer.confidence * 100)}%</span>
          {sensitive && (
            <Badge tone="info" testId="badge-sensitivity" title="CareerHQ never fills this automatically">
              🔒 Sensitive
            </Badge>
          )}
          {answer.needsUser && <Badge tone="warn">Needs your answer</Badge>}
          {answer.differsFromApproved && <Badge tone="warn">Differs from approved</Badge>}
          {answer.note && <span className="basis-full text-xs italic text-muted">{answer.note}</span>}
        </div>
      </td>
      <td className={FIELD_CELL}>
        {field.kind !== "file" && !field.required && (
          <Button type="button" tone="ghost" onClick={() => onCommit(field.id, "")} disabled={disabled}>
            Skip / leave blank
          </Button>
        )}
      </td>
    </tr>
  );
}

const CONSENT_COPY = "You must tick this yourself — CareerHQ never agrees to legal statements on your behalf.";

/**
 * The consent row: a legal attestation or criminal-history disclosure, keyed off
 * `isConsentOnlyField` (not `isSensitiveField`'s generic lock icon). The statement's full
 * label text is shown in full above the control — it is what the user is agreeing to, so it
 * is never truncated — followed by the consent copy and then the control itself.
 */
function ConsentFieldRow({
  field, answer, cvVariants, onCommit, disabled,
}: {
  field: CanonicalFormField;
  answer: PlannedAnswer;
  cvVariants: CvVariant[];
  onCommit: (fieldId: string, value: string) => void;
  disabled: boolean;
}) {
  const rowClass = answer.needsUser ? "bg-warn-soft" : "";
  const rowTestId = answer.needsUser ? "site-field-consent site-field-needs-you" : "site-field-consent";

  return (
    <tr className={rowClass} data-testid={rowTestId}>
      <td className={`${FIELD_CELL} border-l-4 border-anchor`} colSpan={4}>
        <div className="flex flex-col gap-2">
          <p className="m-0 font-semibold text-ink">
            {field.label || field.id}
            {field.required && <span className="ml-0.5 text-bad" title="Required">*</span>}
          </p>
          <p className="m-0 text-xs italic text-muted">{CONSENT_COPY}</p>
          <ConsentControl field={field} answer={answer} cvVariants={cvVariants} onCommit={onCommit} disabled={disabled} />
          {/*
            Declining is an ANSWER, not an omission, and it must not require
            tick-then-untick to express. This commits exactly what the untick path
            commits — "" — so a declined row and an untouched one are the same
            bytes in the fingerprinted payload, both readable as "no consent
            given". Optional rows only: a required consent field cannot be cleared
            and still previewed, so offering it there would be a dead button.
          */}
          {!field.required && (
            <div>
              <Button type="button" tone="ghost" onClick={() => onCommit(field.id, "")} disabled={disabled}>
                Decline / leave unticked
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={SOURCE_TONE[answer.source]}>{SOURCE_LABELS[answer.source]}</Badge>
            <span className="text-xs text-soft">{Math.round(answer.confidence * 100)}%</span>
            {answer.needsUser && <Badge tone="warn">Needs your answer</Badge>}
            {answer.differsFromApproved && <Badge tone="warn">Differs from approved</Badge>}
            {/* The planner's CONSENT_NOTE ("you must answer this yourself for each
                application") lands here — the row's own explanation of why no
                saved answer was reused. */}
            {answer.note && <span className="text-xs italic text-muted">{answer.note}</span>}
          </div>
        </div>
      </td>
    </tr>
  );
}

/**
 * The consent control proper.
 *
 * `checkbox`: an explicit tick, rendered purely from the planned answer's own value — "true"
 * means ticked, anything else (including "" on first render, even when the source page's HTML
 * had the box pre-checked; the planner never carries that value through, see plan.ts's
 * `userDraft`) means unticked. Ticking commits "true"; unticking commits "" — never "false" —
 * so an untouched field and a deliberately-unticked field are indistinguishable in the
 * fingerprinted payload, both readable as "no consent given".
 *
 * Non-checkbox consent fields (criminal_history selects/text) keep the ordinary FieldInput.
 *
 * Native `<label>` + `<input type="checkbox">`, unchanged from before this
 * screen's redesign: this is what makes the control reachable by Tab and
 * operable with Space alone, with no `onClick`/`tabIndex` reimplementation to
 * get wrong.
 */
function ConsentControl({
  field, answer, cvVariants, onCommit, disabled,
}: {
  field: CanonicalFormField;
  answer: PlannedAnswer;
  cvVariants: CvVariant[];
  onCommit: (fieldId: string, value: string) => void;
  disabled: boolean;
}) {
  if (field.kind === "checkbox") {
    return (
      <label className="flex items-center gap-2 text-sm font-medium text-ink">
        <input
          type="checkbox"
          checked={answer.value === "true"}
          onChange={(e) => onCommit(field.id, e.target.checked ? "true" : "")}
          disabled={disabled}
        />
        I agree to this statement
      </label>
    );
  }
  return <FieldInput field={field} answer={answer} cvVariants={cvVariants} onCommit={onCommit} disabled={disabled} />;
}

function FieldInput({
  field, answer, cvVariants, onCommit, disabled,
}: {
  field: CanonicalFormField;
  answer: PlannedAnswer;
  cvVariants: CvVariant[];
  onCommit: (fieldId: string, value: string) => void;
  disabled: boolean;
}) {
  if (field.kind === "file") {
    // File fields are set by the CV selector, never by typing — `updatePlannedAnswer`
    // refuses an edit here (see site-submission.ts), so this row is display-only. Only
    // the resume/CV field (or a value that happens to resolve to a known CV variant)
    // is a CV — a different file field (e.g. `cover_letter_file`) has no CV to show and
    // must not be mislabeled "No CV attached".
    const variant = answer.value ? cvVariants.find((v) => v.id === answer.value) : undefined;
    if (variant) return <span className="text-sm text-ink">{variant.label}</span>;
    if (field.canonicalField === "resume_file") return <span className="text-sm text-soft">No CV attached</span>;
    if (answer.value) return <span className="text-sm text-ink">{answer.value}</span>;
    return (
      <span className="text-sm text-soft">
        {answer.needsUser ? "No file attached yet — attach this in your browser" : "No file attached"}
      </span>
    );
  }
  if (field.kind === "checkbox") {
    return (
      <input
        type="checkbox"
        checked={answer.value.toLowerCase() === "true" || answer.value.toLowerCase() === "yes"}
        onChange={(e) => onCommit(field.id, e.target.checked ? "true" : "false")}
        disabled={disabled}
      />
    );
  }
  if (field.kind === "select" || field.kind === "radio") {
    return (
      <select
        value={answer.value}
        onChange={(e) => onCommit(field.id, e.target.value)}
        disabled={disabled}
        className={CONTROL_CLASSES}
      >
        <option value="">— Select —</option>
        {field.options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label || opt.value}</option>
        ))}
      </select>
    );
  }
  if (field.kind === "multiselect") {
    const selected = new Set(answer.value ? answer.value.split(",") : []);
    return (
      <select
        multiple
        value={[...selected]}
        onChange={(e) => onCommit(field.id, [...e.target.selectedOptions].map((o) => o.value).join(","))}
        disabled={disabled}
        className={CONTROL_CLASSES}
      >
        {field.options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label || opt.value}</option>
        ))}
      </select>
    );
  }
  if (field.kind === "textarea") {
    return <TextLikeInput as="textarea" field={field} answer={answer} onCommit={onCommit} disabled={disabled} />;
  }
  const type = field.kind === "hidden" ? "text" : field.kind;
  return <TextLikeInput as="input" inputType={type} field={field} answer={answer} onCommit={onCommit} disabled={disabled} />;
}

function TextLikeInput({
  as, inputType, field, answer, onCommit, disabled,
}: {
  as: "input" | "textarea";
  inputType?: string;
  field: CanonicalFormField;
  answer: PlannedAnswer;
  onCommit: (fieldId: string, value: string) => void;
  disabled: boolean;
}) {
  const [value, setValue] = useState(answer.value);
  // The server-held value can change out from under this row (a snapshot reload,
  // a Skip elsewhere) — resync whenever it does, but never clobber an in-progress edit.
  useEffect(() => setValue(answer.value), [answer.value]);

  function commitIfChanged() {
    if (value !== answer.value) onCommit(field.id, value);
  }

  if (as === "textarea") {
    return (
      <textarea
        rows={3}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commitIfChanged}
        disabled={disabled}
        className={CONTROL_CLASSES}
        data-testid="site-field-textarea"
      />
    );
  }
  return (
    <input
      type={inputType ?? "text"}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commitIfChanged}
      disabled={disabled}
      className={CONTROL_CLASSES}
    />
  );
}

function SitePreviewPane({
  preview, retypedTarget, setRetypedTarget, isPending, onBack, onConfirm,
}: {
  preview: Preview;
  retypedTarget: string;
  setRetypedTarget: (value: string) => void;
  isPending: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const { payload } = preview;
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4 shadow-card" data-testid="site-preview">
      <h3 className="m-0 text-sm font-semibold text-ink">Review before submitting</h3>
      <dl
        className="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-sm"
        data-testid="site-preview-fields"
      >
        <dt className="font-medium text-muted">Site</dt>
        <dd className="m-0 text-ink">{payload.host}</dd>
        <dt className="font-medium text-muted">Requisition</dt>
        <dd className="m-0 text-ink"><code>{payload.requisitionKey}</code></dd>
        <dt className="font-medium text-muted">Answers</dt>
        <dd className="m-0 text-ink">{payload.answers.length} fields</dd>
        {payload.attachments.length > 0 && (
          <>
            <dt className="font-medium text-muted">
              {payload.attachments.length === 1 ? "Attachment" : "Attachments"}
            </dt>
            <dd className="m-0 text-ink">
              <ul className="m-0 flex flex-col gap-0.5 pl-4">
                {payload.attachments.map((attachment) => (
                  <li key={attachment.fieldId}>
                    {attachment.filename} — sha256 <code>{attachment.sha256.slice(0, 12)}…</code>
                  </li>
                ))}
              </ul>
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

      <Field label={`Type the site's host (${payload.host}) exactly to confirm submitting`}>
        <input
          type="text"
          value={retypedTarget}
          onChange={(e) => setRetypedTarget(e.target.value)}
          disabled={isPending}
          autoComplete="off"
          className={CONTROL_CLASSES}
          data-testid="site-retype-input"
        />
      </Field>

      <div className="flex gap-2">
        <Button type="button" onClick={onBack} disabled={isPending}>Back to edit</Button>
        {/*
          The one `irreversible`-toned control on this entire page: this is
          the click that touches the outside world (the real company site)
          and cannot be undone. Its colour must be the single reason a user
          can tell it apart from "Back to edit" before reading either label —
          see tokens.css's own reservation note on `--irreversible`.
        */}
        <Button
          type="button"
          tone="irreversible"
          onClick={onConfirm}
          disabled={isPending || retypedTarget.trim().length === 0}
        >
          {isPending ? "Submitting…" : "Confirm and submit"}
        </Button>
      </div>
    </div>
  );
}

function SiteConfirmOutcomePane({
  outcome, applicationId, attemptId, onResolved,
}: {
  outcome: SiteConfirmOutcome;
  applicationId: string;
  attemptId: string;
  onResolved: () => void;
}) {
  switch (outcome.status) {
    case "submitted": {
      const safeFinalUrl = safeExternalHref(outcome.finalUrl);
      return (
        <OutcomePanel tone="ok" testId="site-outcome">
          <p className="m-0">
            Submitted — confirmation <code>{outcome.confirmationId ?? "(none reported by the site)"}</code>
          </p>
          <p className="m-0">
            {safeFinalUrl ? (
              <a href={safeFinalUrl} target="_blank" rel="noreferrer" className="font-medium text-ink underline">
                {outcome.finalUrl}
              </a>
            ) : (
              outcome.finalUrl
            )}
          </p>
          {outcome.screenshotPath && (
            <p className="m-0 text-xs text-muted">Evidence saved to <code>{outcome.screenshotPath}</code></p>
          )}
        </OutcomePanel>
      );
    }
    case "blocked":
      return (
        <OutcomePanel tone="warn" testId="site-outcome">
          <p className="m-0">Blocked ({outcome.code}): {outcome.reason}</p>
          {outcome.code === "gate_closed" && (
            <p className="m-0 text-xs text-muted">
              Live company-site submission is off. Set <code>SUBMISSIONS_LIVE_COMPANY_SITE=true</code> to
              enable submitting.
            </p>
          )}
          {outcome.code === "sandbox_blocked" && (
            <p className="m-0 text-xs text-muted">
              Sandbox workspaces may only submit to the host named by <code>SANDBOX_SITE_ALLOWED_HOST</code>.
            </p>
          )}
          {outcome.code === "application_not_ready" && (
            <p className="m-0 text-xs text-muted">
              This application is no longer in a state that can be submitted from. Re-typing the host
              won&apos;t fix this — use the transition buttons above to walk it back to Ready for review,
              then confirm again.
            </p>
          )}
          {outcome.code === "driver_unavailable" && (
            <p className="m-0 text-xs text-muted">
              The auto-apply browser isn&apos;t available in this process right now — this is a pause, not a
              failure: nothing was typed into the form. Try confirming again shortly.
            </p>
          )}
          {outcome.code === "review_required" && (
            <p className="m-0 text-xs text-muted">
              Go back to the review screen, settle every field still needing you, then preview again.
            </p>
          )}
        </OutcomePanel>
      );
    case "failed":
      return (
        <OutcomePanel tone="bad" testId="site-outcome">
          <p className="m-0">Submission failed: {outcome.reason}</p>
        </OutcomePanel>
      );
    case "needs_reconcile":
      return (
        <SiteReconcilePane
          applicationId={applicationId}
          attemptId={attemptId}
          reason={outcome.reason}
          onResolved={onResolved}
        />
      );
  }
}

function SiteReconcilePane({
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
      try {
        const result = await resolveReconcileAction({
          applicationId, attemptId, resolution, evidenceNote: note.trim() || undefined,
        });
        if (result.ok) {
          onResolved?.();
          router.refresh();
        } else {
          setError(result.reason);
        }
      } catch {
        setError(ACTION_THREW);
      }
    });
  }

  return (
    <div data-testid="site-outcome">
      <ReconcilePanel reason={reason}>
        <p className="m-0 text-xs text-muted">
          The submission&apos;s outcome is uncertain — check the site directly and the stored screenshot, then
          resolve manually.
        </p>
        <Field label="Evidence note (optional)">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={isPending}
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
    </div>
  );
}

function SiteAttemptHistory({ applicationId, attempts }: { applicationId: string; attempts: ApplicationAttempt[] }) {
  if (attempts.length === 0) return <p className="m-0 text-sm text-soft">No auto-apply attempts yet.</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {[...attempts].reverse().map((attempt) => (
        <SiteAttemptRow key={attempt.id} applicationId={applicationId} attempt={attempt} />
      ))}
    </ul>
  );
}

function SiteAttemptRow({ applicationId, attempt }: { applicationId: string; attempt: ApplicationAttempt }) {
  const draft = parseSiteDraft(attempt.draftPayload);
  const highlighted = attempt.status === "NEEDS_RECONCILE";
  const blocked = attempt.status === "BLOCKED" && attempt.failureReason
    ? splitBlockedReason(attempt.failureReason)
    : null;

  return (
    <li
      className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-3 shadow-card"
      data-testid="site-attempt-row"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={ATTEMPT_TONE[attempt.status]}>{humanize(attempt.status)}</Badge>
        <span className="text-xs text-soft">{formatTimestamp(attempt.startedAt)}</span>
        {draft?.url && <span className="text-xs text-muted">{draft.url}</span>}
      </div>
      {blocked && (
        <p className="m-0 text-sm text-bad" role="alert">
          {humanize(blocked.kind)}: {blocked.detail}
        </p>
      )}
      {!blocked && attempt.failureReason && (
        <p className="m-0 text-sm text-bad" role="alert">
          {attempt.failureReason}
        </p>
      )}
      {highlighted && (
        <SiteReconcilePane
          applicationId={applicationId}
          attemptId={attempt.id}
          reason={attempt.failureReason ?? "the submission outcome is uncertain"}
        />
      )}
    </li>
  );
}
