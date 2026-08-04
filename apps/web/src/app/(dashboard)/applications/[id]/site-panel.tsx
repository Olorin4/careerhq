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

/** Brief §10.2.8's exact badge labels, in `ANSWER_SOURCES` order. */
const SOURCE_LABELS: Record<AnswerSource, string> = {
  fact: "Fact",
  saved_answer: "Saved answer",
  profile: "Profile",
  ai: "AI — not yet approved",
  user: "You",
  document: "Document",
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

function statusBadgeClass(status: ApplicationAttempt["status"]): string {
  if (status === "SUBMITTED") return "badge badge-ok";
  if (status === "FAILED" || status === "BLOCKED") return "badge badge-error";
  if (status === "NEEDS_RECONCILE") return "badge badge-reconcile";
  return "badge";
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
  const [now, setNow] = useState(() => Date.now());

  // Drives the expiry countdown on the confirm screen; only ticks while a live token is on screen.
  useEffect(() => {
    if (!preview) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [preview]);

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
      const outcome = await prepareSiteApplicationAction({ applicationId, url: trimmedUrl, overrideDuplicate });
      setPrepareOutcome(outcome);
      setConfirmOutcome(null);
      if (outcome.status !== "failed") router.refresh();
    });
  }

  function handlePreview() {
    if (!readyState) return;
    setError(null);
    startTransition(async () => {
      const outcome = await previewSiteSubmissionAction({ applicationId, attemptId: readyState.attemptId });
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
    if (!preview || !readyState) return;
    setError(null);
    startTransition(async () => {
      const outcome = await confirmAndSubmitSiteAction({
        applicationId, attemptId: readyState.attemptId, presentedToken: preview.token, retypedTarget,
      });
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
      // review_required, …) leaves the token unconsumed — keep the preview on screen so the user can
      // retry once the underlying condition is fixed.
    });
  }

  const canStartNewAttempt = currentAttempt !== null || !alreadySubmitted;

  return (
    <section className="site-panel">
      <h2>Auto-apply (company site)</h2>

      {alreadySubmitted && !currentAttempt && (
        <p className="site-hint">This application already has a submitted attempt.</p>
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
          now={now}
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
        <div className="site-url-form">
          <label>
            Application page URL
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={isPending}
              placeholder="https://boards.greenhouse.io/…"
              autoComplete="off"
            />
          </label>
          <button type="button" onClick={() => handlePrepare()} disabled={isPending}>
            {isPending ? "Reading the page…" : "Prepare"}
          </button>
        </div>
      )}

      {error && <p className="site-error">{error}</p>}

      {!readyState && prepareOutcome && prepareOutcome.status !== "ready" && (
        <PrepareOutcomePane
          outcome={prepareOutcome}
          url={url}
          isPending={isPending}
          onRetry={() => handlePrepare()}
          onOverride={() => handlePrepare(true)}
        />
      )}

      <h3>Attempt history</h3>
      <SiteAttemptHistory applicationId={applicationId} attempts={siteAttempts} />
    </section>
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
    return (
      <div className="site-outcome site-outcome-blocked">
        <p>Paused — {humanize(outcome.kind)}</p>
        <p>{outcome.detail}</p>
        <p className="site-outcome-hint">
          This is a pause, not a failure: nothing was submitted.{" "}
          {url.trim() && (
            <a href={url.trim()} target="_blank" rel="noreferrer">Open the application in your browser</a>
          )}{" "}
          to finish it yourself.{BLOCKER_HINT[outcome.kind] ? ` ${BLOCKER_HINT[outcome.kind]}` : ""}
        </p>
        <button type="button" onClick={onRetry} disabled={isPending}>
          {isPending ? "Retrying…" : "Retry prepare"}
        </button>
      </div>
    );
  }
  if (outcome.status === "duplicate") {
    return (
      <div className="site-outcome site-outcome-blocked">
        <p>A submitted attempt for this requisition already exists.</p>
        <p>
          <a href={`/applications/${outcome.existingApplicationId}`}>View the existing application</a>
        </p>
        <button type="button" onClick={onOverride} disabled={isPending}>
          {isPending ? "Applying…" : "Apply anyway"}
        </button>
      </div>
    );
  }
  return (
    <div className="site-outcome site-outcome-failed">
      <p>{outcome.reason}</p>
    </div>
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
      const result = await updatePlannedAnswerAction({ applicationId, snapshotId, fieldId, value });
      if (!result.ok) setSaveError(result.reason);
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

  return (
    <div className="site-review">
      <p className="site-review-url">
        Reviewing <a href={reviewUrl} target="_blank" rel="noreferrer">{reviewUrl}</a>
      </p>

      <p className="site-cv-line">
        CV that will be attached: <strong>{attachedVariant ? attachedVariant.label : "No CV variant selected"}</strong>{" "}
        <a href="#cv-select">change</a>
      </p>

      <p className="site-summary">
        {form.fields.length} fields · {blocking.length} need you
      </p>

      {steps.map((step) => (
        <section key={step} className="site-step">
          <h4>Step {step + 1} of {form.totalSteps}</h4>
          <table className="site-field-table">
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
        </section>
      ))}

      {saveError && <p className="site-error">{saveError}</p>}

      <button type="button" onClick={onPreview} disabled={isPending || blocking.length > 0}>
        {isPending ? "Working…" : "Preview"}
      </button>
      {blocking.length > 0 && (
        <p className="site-hint">Still need you: {blockingLabels.join(", ")}</p>
      )}
    </div>
  );
}

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

  const sensitive = isSensitiveField(field);
  const rowClass = answer.needsUser ? "site-field-row site-field-needs-you" : "site-field-row";

  return (
    <tr className={rowClass}>
      <td className="site-field-label">
        {field.label || field.id}
        {field.required && <span className="site-field-required" title="Required">*</span>}
      </td>
      <td className="site-field-value">
        <FieldInput field={field} answer={answer} cvVariants={cvVariants} onCommit={onCommit} disabled={disabled} />
      </td>
      <td className="site-field-meta">
        <span className={`badge site-badge-source-${answer.source}`}>{SOURCE_LABELS[answer.source]}</span>
        <span className="site-field-confidence">{Math.round(answer.confidence * 100)}%</span>
        {sensitive && (
          <span className="badge badge-sensitivity" title="CareerHQ never fills this automatically">
            🔒 Sensitive
          </span>
        )}
        {answer.needsUser && <span className="badge site-badge-needs-you">Needs your answer</span>}
        {answer.differsFromApproved && (
          <span className="badge site-badge-differs">Differs from approved</span>
        )}
        {answer.note && <span className="site-field-note">{answer.note}</span>}
      </td>
      <td className="site-field-actions">
        {field.kind !== "file" && !field.required && (
          <button type="button" onClick={() => onCommit(field.id, "")} disabled={disabled}>
            Skip / leave blank
          </button>
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
  const rowClass = answer.needsUser
    ? "site-field-row site-field-consent site-field-needs-you"
    : "site-field-row site-field-consent";

  return (
    <tr className={rowClass}>
      <td className="site-field-consent-cell" colSpan={4}>
        <p className="site-field-consent-statement">
          {field.label || field.id}
          {field.required && <span className="site-field-required" title="Required">*</span>}
        </p>
        <p className="site-field-consent-copy">{CONSENT_COPY}</p>
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
          <button
            type="button"
            className="site-consent-decline"
            onClick={() => onCommit(field.id, "")}
            disabled={disabled}
          >
            Decline / leave unticked
          </button>
        )}
        <div className="site-field-meta">
          <span className={`badge site-badge-source-${answer.source}`}>{SOURCE_LABELS[answer.source]}</span>
          <span className="site-field-confidence">{Math.round(answer.confidence * 100)}%</span>
          {answer.needsUser && <span className="badge site-badge-needs-you">Needs your answer</span>}
          {answer.differsFromApproved && (
            <span className="badge site-badge-differs">Differs from approved</span>
          )}
          {/* The planner's CONSENT_NOTE ("you must answer this yourself for each
              application") lands here — the row's own explanation of why no
              saved answer was reused. */}
          {answer.note && <span className="site-field-note">{answer.note}</span>}
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
      <label className="site-consent-checkbox">
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
    if (variant) return <span>{variant.label}</span>;
    if (field.canonicalField === "resume_file") return <span>No CV attached</span>;
    if (answer.value) return <span>{answer.value}</span>;
    return <span>{answer.needsUser ? "No file attached yet — attach this in your browser" : "No file attached"}</span>;
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
      <select value={answer.value} onChange={(e) => onCommit(field.id, e.target.value)} disabled={disabled}>
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
    />
  );
}

function SitePreviewPane({
  preview, now, retypedTarget, setRetypedTarget, isPending, onBack, onConfirm,
}: {
  preview: Preview;
  now: number;
  retypedTarget: string;
  setRetypedTarget: (value: string) => void;
  isPending: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const { payload } = preview;
  return (
    <div className="site-preview">
      <h3>Review before submitting</h3>
      <dl className="site-preview-fields">
        <dt>Site</dt>
        <dd>{payload.host}</dd>
        <dt>Requisition</dt>
        <dd><code>{payload.requisitionKey}</code></dd>
        <dt>Answers</dt>
        <dd>{payload.answers.length} fields</dd>
        {payload.attachments.length > 0 && (
          <>
            <dt>{payload.attachments.length === 1 ? "Attachment" : "Attachments"}</dt>
            <dd>
              <ul className="site-preview-attachments">
                {payload.attachments.map((attachment) => (
                  <li key={attachment.fieldId}>
                    {attachment.filename} — sha256 <code>{attachment.sha256.slice(0, 12)}…</code>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt>Fingerprint</dt>
        <dd><code>{preview.fingerprint.slice(0, 16)}…</code></dd>
        <dt>Expires</dt>
        <dd><ExpiryCountdown expiresAt={preview.expiresAt} now={now} /></dd>
      </dl>

      <label className="site-retype-label">
        Type the site&apos;s host ({payload.host}) exactly to confirm submitting
        <input
          type="text"
          value={retypedTarget}
          onChange={(e) => setRetypedTarget(e.target.value)}
          disabled={isPending}
          autoComplete="off"
        />
      </label>

      <div className="site-preview-actions">
        <button type="button" onClick={onBack} disabled={isPending}>Back to edit</button>
        <button type="button" onClick={onConfirm} disabled={isPending || retypedTarget.trim().length === 0}>
          {isPending ? "Submitting…" : "Confirm and submit"}
        </button>
      </div>
    </div>
  );
}

function ExpiryCountdown({ expiresAt, now }: { expiresAt: string; now: number }) {
  const remainingMs = Math.max(0, new Date(expiresAt).getTime() - now);
  if (remainingMs <= 0) {
    return <span className="site-expired">Expired — go back and preview again</span>;
  }
  const totalSeconds = Math.floor(remainingMs / 1000);
  const mm = Math.floor(totalSeconds / 60);
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return <span>{mm}:{ss}</span>;
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
    case "submitted":
      return (
        <div className="site-outcome site-outcome-submitted">
          <p>Submitted — confirmation <code>{outcome.confirmationId ?? "(none reported by the site)"}</code></p>
          <p><a href={outcome.finalUrl} target="_blank" rel="noreferrer">{outcome.finalUrl}</a></p>
          {outcome.screenshotPath && (
            <p className="site-outcome-hint">Evidence saved to <code>{outcome.screenshotPath}</code></p>
          )}
        </div>
      );
    case "blocked":
      return (
        <div className="site-outcome site-outcome-blocked">
          <p>Blocked ({outcome.code}): {outcome.reason}</p>
          {outcome.code === "gate_closed" && (
            <p className="site-outcome-hint">
              Live company-site submission is off. Set <code>SUBMISSIONS_LIVE_COMPANY_SITE=true</code> to
              enable submitting.
            </p>
          )}
          {outcome.code === "sandbox_blocked" && (
            <p className="site-outcome-hint">
              Sandbox workspaces may only submit to the host named by <code>SANDBOX_SITE_ALLOWED_HOST</code>.
            </p>
          )}
          {outcome.code === "application_not_ready" && (
            <p className="site-outcome-hint">
              This application is no longer in a state that can be submitted from. Re-typing the host
              won&apos;t fix this — use the transition buttons above to walk it back to Ready for review,
              then confirm again.
            </p>
          )}
          {outcome.code === "driver_unavailable" && (
            <p className="site-outcome-hint">
              The auto-apply browser isn&apos;t available in this process right now — this is a pause, not a
              failure: nothing was typed into the form. Try confirming again shortly.
            </p>
          )}
          {outcome.code === "review_required" && (
            <p className="site-outcome-hint">
              Go back to the review screen, settle every field still needing you, then preview again.
            </p>
          )}
        </div>
      );
    case "failed":
      return (
        <div className="site-outcome site-outcome-failed">
          <p>Submission failed: {outcome.reason}</p>
        </div>
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
    <div className="site-outcome site-outcome-reconcile">
      <p>Needs reconciliation: {reason}</p>
      <p className="site-outcome-hint">
        The submission&apos;s outcome is uncertain — check the site directly and the stored screenshot, then
        resolve manually.
      </p>
      <label>
        Evidence note (optional)
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} disabled={isPending} />
      </label>
      <div className="site-reconcile-actions">
        <button type="button" disabled={isPending} onClick={() => resolve("submitted")}>
          Mark submitted (with evidence note)
        </button>
        <button type="button" disabled={isPending} onClick={() => resolve("failed")}>
          Mark failed
        </button>
      </div>
      {error && <p className="site-error">{error}</p>}
    </div>
  );
}

function SiteAttemptHistory({ applicationId, attempts }: { applicationId: string; attempts: ApplicationAttempt[] }) {
  if (attempts.length === 0) return <p className="site-empty">No auto-apply attempts yet.</p>;
  return (
    <ul className="site-attempt-list">
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
    <li className={highlighted ? "site-attempt-row site-attempt-row-reconcile" : "site-attempt-row"}>
      <div className="site-attempt-meta">
        <span className={statusBadgeClass(attempt.status)}>{humanize(attempt.status)}</span>
        <span className="site-attempt-date">{attempt.startedAt.toLocaleString()}</span>
        {draft?.url && <span className="site-attempt-url">{draft.url}</span>}
      </div>
      {blocked && <p className="site-error">{humanize(blocked.kind)}: {blocked.detail}</p>}
      {!blocked && attempt.failureReason && <p className="site-error">{attempt.failureReason}</p>}
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
