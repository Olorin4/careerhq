"use client";

import { useActionState, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { ApplicationAnswer } from "@careerhq/db";
import { Badge } from "../../../../components/badge.js";
import { Button } from "../../../../components/button.js";
import { CONTROL_CLASSES, Field } from "../../../../components/field.js";
import { ProvenanceChips } from "../../../../components/provenance-chips.js";
import { Section } from "../../../../components/section.js";
import { APPROVAL_TONE } from "../../../../lib/application-state.js";
import { REPLAY_MISS, replayMissMessage } from "../../../../lib/replay-miss.js";
import { formatTimestamp } from "../../../../lib/time.js";
import {
  approveAnswerAction, askQuestionAction, rejectAnswerAction, saveManualAnswerAction,
  type AskQuestionResult,
} from "./qa-actions.js";

function humanize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

interface QaPanelProps {
  applicationId: string;
  answers: ApplicationAnswer[];
  /** Every fact claim in the workspace (including archived), keyed by id, for provenance chip labels. */
  factClaims: Record<string, string>;
  /** Whether this deployment is the hosted demo answering from recorded AI output — decides how a `replay_miss` is worded. */
  replayDemo: boolean;
}

/** Matches `materials.tsx`'s `OutcomePane` — the same refusal vocabulary for the same shape of outcome. */
function OutcomePane({ result, replayDemo }: { result: AskQuestionResult; replayDemo: boolean }) {
  const { outcome } = result;
  switch (outcome.status) {
    case "ok":
      // Handled by the caller (triggers a router.refresh() and clears the
      // pending result instead of ever rendering this state) — kept for
      // exhaustiveness, same convention as materials.tsx's OutcomePane.
      return null;
    case "needs_facts":
      return (
        <div className="flex flex-col gap-2 rounded-md border-l-4 border-warn bg-warn-soft p-3 text-sm text-ink">
          <p className="m-0 font-medium">Not enough verified facts to answer this confidently:</p>
          <ul className="m-0 flex flex-col gap-1 pl-5">
            {outcome.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p className="m-0">
            <a href="/facts" className="font-medium text-ink underline">Add a verified fact</a>, or answer manually
            below.
          </p>
        </div>
      );
    case "sensitive_blocked":
      return (
        <p className="m-0 text-sm text-bad" role="alert">
          This question is sensitive (matched: {outcome.matchedTerms.join(", ")}) — CareerHQ never AI-answers it.
          Answer manually below.
        </p>
      );
    case "ai_unavailable":
      return (
        <>
          <p className="m-0 text-sm text-soft italic">AI is not configured — answer manually below.</p>
          {result.rulesetSensitive && (
            <p className="m-0 text-sm text-bad" role="alert">
              This looks sensitive (matched: {result.rulesetSensitive.matchedTerms.join(", ")}) — CareerHQ will
              never AI-answer it, even once AI is configured. Answer manually below.
            </p>
          )}
        </>
      );
    case "failed":
      // The Q&A box takes free text, so on the hosted demo a miss is the
      // *normal* outcome for anything but the recorded question — see
      // `lib/replay-miss.ts`.
      if (replayDemo && outcome.error === REPLAY_MISS) {
        return <p className="m-0 text-sm text-soft italic">{replayMissMessage("question")}</p>;
      }
      return (
        <p className="m-0 text-sm text-bad" role="alert">
          Could not answer: {outcome.error}
        </p>
      );
  }
}

function ManualAnswerForm({
  applicationId,
  question,
  onQuestionChange,
  sensitive,
}: {
  applicationId: string;
  question: string;
  onQuestionChange: (value: string) => void;
  sensitive: boolean;
}) {
  // Same reasoning as the materials panel's manual draft form: the action
  // reports why it saved nothing rather than throwing or failing silently, and
  // hands the submitted answer back so React's post-action form reset does not
  // empty the textarea. `question` is already controlled by the parent, so it
  // survives on its own.
  const [saveState, saveManualAnswer] = useActionState(saveManualAnswerAction, null);
  return (
    <form
      action={saveManualAnswer}
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4 shadow-card"
    >
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="sensitivity" value={sensitive ? "sensitive" : "normal"} />
      <Field label="Question">
        <input
          type="text"
          name="question"
          value={question}
          onChange={(e) => onQuestionChange(e.target.value)}
          minLength={3}
          required
          className={CONTROL_CLASSES}
        />
      </Field>
      <Field label="Answer">
        <textarea name="answer" defaultValue={saveState?.answer ?? ""} rows={4} required className={CONTROL_CLASSES} />
      </Field>
      <div>
        <Button type="submit">Save manual answer</Button>
      </div>
      {saveState && (
        <p className="m-0 text-sm text-bad" role="alert">
          Not saved — {saveState.reason}. Your answer is still here; try again.
        </p>
      )}
    </form>
  );
}

function AnswerRow({
  answer,
  factClaims,
  isPending,
  onApprove,
  onReject,
}: {
  answer: ApplicationAnswer;
  factClaims: Record<string, string>;
  isPending: boolean;
  onApprove: (id: string, reusable: boolean) => void;
  onReject: (id: string) => void;
}) {
  const [reusable, setReusable] = useState(false);
  // Same combined-badge reasoning as materials.tsx's `aiDraft`: this is the
  // design vocabulary's own "AI-generated — not yet approved" example,
  // distinct from the general (always-neutral) origin label below it. No
  // `data-testid` here deliberately — `[data-testid="badge-sensitivity"]`
  // two rows down is one of the 36 hooks `capture-demo-media.ts` depends on,
  // scoped to `site-panel.tsx`'s own sensitivity badge; this row never
  // carries that hook (see the file's own note on the carried hazard).
  const aiDraft = answer.origin === "ai" && answer.approval === "draft";

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4 shadow-card">
      <p className="m-0 text-sm font-semibold text-ink">{answer.questionRaw}</p>
      <p className="m-0 whitespace-pre-wrap text-sm text-ink">{answer.answer}</p>
      <div className="flex flex-wrap items-center gap-2">
        {aiDraft && <Badge tone="warn">AI-generated — not yet approved</Badge>}
        <Badge tone="neutral">{humanize(answer.origin)}</Badge>
        <Badge tone={APPROVAL_TONE[answer.approval]}>{humanize(answer.approval)}</Badge>
        {answer.sensitivity === "sensitive" && (
          <Badge tone="info" title="CareerHQ never AI-answers this">🔒 Sensitive</Badge>
        )}
        <span className="text-xs text-soft">{formatTimestamp(answer.createdAt)}</span>
      </div>
      {answer.origin === "ai" && (
        <ProvenanceChips factIds={answer.sourceFactIds} factClaims={factClaims} />
      )}
      {answer.approval === "draft" && (
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-2">
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={reusable}
              onChange={(e) => setReusable(e.target.checked)}
            />
            Reusable
          </label>
          <Button type="button" tone="primary" disabled={isPending} onClick={() => onApprove(answer.id, reusable)}>
            Approve
          </Button>
          <Button type="button" disabled={isPending} onClick={() => onReject(answer.id)}>
            Reject
          </Button>
        </div>
      )}
    </li>
  );
}

export function QaPanel({ applicationId, answers, factClaims, replayDemo }: QaPanelProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [question, setQuestion] = useState("");
  const [manualQuestion, setManualQuestion] = useState("");
  const [result, setResult] = useState<AskQuestionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleAsk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = question.trim();
    if (trimmed.length < 3) return;
    setError(null);
    startTransition(async () => {
      const askResult = await askQuestionAction({ applicationId, question: trimmed });
      if (askResult.outcome.status === "ok") {
        setResult(null);
        setQuestion("");
        setManualQuestion("");
        router.refresh();
      } else {
        setResult(askResult);
        setManualQuestion(trimmed);
      }
    });
  }

  function handleApprove(id: string, reusable: boolean) {
    startTransition(async () => {
      const approveResult = await approveAnswerAction({ id, reusable });
      if (approveResult.ok) router.refresh();
      else setError(`Could not approve this answer: ${approveResult.reason}`);
    });
  }

  function handleReject(id: string) {
    startTransition(async () => {
      const rejectResult = await rejectAnswerAction({ id });
      if (rejectResult.ok) router.refresh();
      else setError(`Could not reject this answer: ${rejectResult.reason}`);
    });
  }

  const sensitive = result
    ? result.outcome.status === "sensitive_blocked" || result.rulesetSensitive !== undefined
    : false;

  return (
    <Section title="Questions & answers">
      <form
        className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4 shadow-card"
        onSubmit={handleAsk}
      >
        <Field label="Question">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            minLength={3}
            required
            className={CONTROL_CLASSES}
          />
        </Field>
        <div>
          <Button type="submit" tone="primary" disabled={isPending || question.trim().length < 3}>
            {isPending ? "Asking…" : "Ask"}
          </Button>
        </div>
      </form>

      {error && (
        <p className="m-0 text-sm text-bad" role="alert">
          {error}
        </p>
      )}
      {result && <OutcomePane result={result} replayDemo={replayDemo} />}

      <ManualAnswerForm
        applicationId={applicationId}
        question={manualQuestion}
        onQuestionChange={setManualQuestion}
        sensitive={sensitive}
      />

      {answers.length === 0 ? (
        <p className="m-0 text-sm text-soft">No questions answered yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {answers.map((answer) => (
            <AnswerRow
              key={answer.id}
              answer={answer}
              factClaims={factClaims}
              isPending={isPending}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}
