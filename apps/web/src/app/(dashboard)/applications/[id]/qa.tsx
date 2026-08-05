"use client";

import { useActionState, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { ApplicationAnswer } from "@careerhq/db";
import { ProvenanceChips } from "../../../../components/provenance-chips.js";
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
        <div className="qa-needs-facts">
          <p>Not enough verified facts to answer this confidently:</p>
          <ul>
            {outcome.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p>
            <a href="/facts">Add a verified fact</a>, or answer manually below.
          </p>
        </div>
      );
    case "sensitive_blocked":
      return (
        <p className="qa-error">
          This question is sensitive (matched: {outcome.matchedTerms.join(", ")}) — CareerHQ never
          AI-answers it. Answer manually below.
        </p>
      );
    case "ai_unavailable":
      return (
        <>
          <p className="qa-manual-note">AI is not configured — answer manually below.</p>
          {result.rulesetSensitive && (
            <p className="qa-error">
              This looks sensitive (matched: {result.rulesetSensitive.matchedTerms.join(", ")}) —
              CareerHQ will never AI-answer it, even once AI is configured. Answer manually below.
            </p>
          )}
        </>
      );
    case "failed":
      // The Q&A box takes free text, so on the hosted demo a miss is the
      // *normal* outcome for anything but the recorded question — see
      // `lib/replay-miss.ts`.
      if (replayDemo && outcome.error === REPLAY_MISS) {
        return <p className="qa-manual-note">{replayMissMessage("question")}</p>;
      }
      return <p className="qa-error">Could not answer: {outcome.error}</p>;
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
    <form action={saveManualAnswer} className="qa-manual-form">
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="sensitivity" value={sensitive ? "sensitive" : "normal"} />
      <label>
        Question
        <input
          type="text"
          name="question"
          value={question}
          onChange={(e) => onQuestionChange(e.target.value)}
          minLength={3}
          required
        />
      </label>
      <label>
        Answer
        <textarea name="answer" defaultValue={saveState?.answer ?? ""} rows={4} required />
      </label>
      <button type="submit">Save manual answer</button>
      {saveState && (
        <p className="qa-error">Not saved — {saveState.reason}. Your answer is still here; try again.</p>
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
  return (
    <li className="qa-answer-row">
      <p className="qa-answer-question">
        <strong>{answer.questionRaw}</strong>
      </p>
      <p className="qa-answer-text">{answer.answer}</p>
      <div className="qa-answer-meta">
        <span className="badge">{humanize(answer.origin)}</span>
        <span className="badge">{humanize(answer.approval)}</span>
        {answer.sensitivity === "sensitive" && (
          <span className="badge badge-sensitivity">Sensitive</span>
        )}
        <span className="qa-answer-date">{formatTimestamp(answer.createdAt)}</span>
      </div>
      {answer.origin === "ai" && (
        <ProvenanceChips factIds={answer.sourceFactIds} factClaims={factClaims} />
      )}
      {answer.approval === "draft" && (
        <div className="qa-answer-actions">
          <label className="qa-reusable-checkbox">
            <input
              type="checkbox"
              checked={reusable}
              onChange={(e) => setReusable(e.target.checked)}
            />
            Reusable
          </label>
          <button type="button" disabled={isPending} onClick={() => onApprove(answer.id, reusable)}>
            Approve
          </button>
          <button type="button" disabled={isPending} onClick={() => onReject(answer.id)}>
            Reject
          </button>
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
    <section className="qa">
      <h2>Questions &amp; answers</h2>
      <form className="qa-ask-form" onSubmit={handleAsk}>
        <label>
          Question
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            minLength={3}
            required
          />
        </label>
        <button type="submit" disabled={isPending || question.trim().length < 3}>
          {isPending ? "Asking…" : "Ask"}
        </button>
      </form>

      {error && <p className="qa-error">{error}</p>}
      {result && <OutcomePane result={result} replayDemo={replayDemo} />}

      <ManualAnswerForm
        applicationId={applicationId}
        question={manualQuestion}
        onQuestionChange={setManualQuestion}
        sensitive={sensitive}
      />

      <ul className="qa-answer-list">
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
      {answers.length === 0 && <p className="qa-empty">No questions answered yet.</p>}
    </section>
  );
}
