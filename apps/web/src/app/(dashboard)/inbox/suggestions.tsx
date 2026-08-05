"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ApplicationState, ReplyClassification } from "@careerhq/contracts";
import { formatTimestamp } from "../../../lib/time.js";
import { acceptSuggestionAction, dismissSuggestionAction } from "./actions.js";

export interface SuggestionListItem {
  /** The `email_messages` row id. */
  id: string;
  fromAddr: string;
  subject: string;
  snippet: string;
  /** ISO timestamp — plain data crossing the server/client boundary, not a `Date`. */
  receivedAt: string;
  classification: ReplyClassification | null;
  classificationConfidence: number | null;
  suggestedTransition: ApplicationState | null;
  quotedEvidence: string | null;
  /** null when the reply never matched an application (still shown, just unlinked). */
  application: { id: string; company: string; title: string; state: ApplicationState } | null;
}

function humanize(s: string): string {
  return s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");
}

function classificationBadgeClass(classification: ReplyClassification): string {
  if (classification === "interview" || classification === "offer") return "badge badge-ok";
  if (classification === "rejection") return "badge badge-error";
  return "badge";
}

export function SuggestionQueue({ suggestions }: { suggestions: SuggestionListItem[] }) {
  if (suggestions.length === 0) {
    return <p className="inbox-empty">No pending suggestions — the review queue is clear.</p>;
  }
  return (
    <ul className="inbox-list">
      {suggestions.map((suggestion) => (
        <SuggestionRow key={suggestion.id} suggestion={suggestion} />
      ))}
    </ul>
  );
}

function SuggestionRow({ suggestion }: { suggestion: SuggestionListItem }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleAccept() {
    setError(null);
    startTransition(async () => {
      const result = await acceptSuggestionAction({ messageId: suggestion.id });
      if (result.ok) {
        router.refresh();
      } else {
        // Illegal-transition refusals (and any other reason) surface here,
        // inline, with the row left exactly as it was — still pending.
        setError(result.reason);
      }
    });
  }

  function handleDismiss() {
    setError(null);
    startTransition(async () => {
      const result = await dismissSuggestionAction({ messageId: suggestion.id });
      if (result.ok) router.refresh();
      else setError(result.reason);
    });
  }

  return (
    <li className="inbox-row" data-testid="inbox-row">
      <p className="inbox-row-subject">
        <strong>{suggestion.subject || "(no subject)"}</strong>
      </p>
      <p className="inbox-row-meta">
        From {suggestion.fromAddr} — {formatTimestamp(suggestion.receivedAt)}
      </p>
      <p className="inbox-row-snippet">{suggestion.snippet}</p>

      {suggestion.application && (
        <p className="inbox-row-application">
          <a href={`/applications/${suggestion.application.id}`}>
            {suggestion.application.company} · {suggestion.application.title}
          </a>
          {" — "}
          {humanize(suggestion.application.state)}
        </p>
      )}

      <div className="inbox-row-classification">
        {suggestion.classification && (
          <span className={classificationBadgeClass(suggestion.classification)}>
            {humanize(suggestion.classification)}
            {suggestion.classificationConfidence !== null
              ? ` (${Math.round(suggestion.classificationConfidence * 100)}%)`
              : ""}
          </span>
        )}
        {suggestion.suggestedTransition && (
          <span className="inbox-row-transition">→ {humanize(suggestion.suggestedTransition)}</span>
        )}
      </div>

      {suggestion.quotedEvidence && (
        <blockquote className="inbox-row-evidence" data-testid="inbox-row-evidence">&ldquo;{suggestion.quotedEvidence}&rdquo;</blockquote>
      )}

      <div className="inbox-row-actions">
        <button
          type="button"
          disabled={isPending || !suggestion.application || !suggestion.suggestedTransition}
          onClick={handleAccept}
        >
          Accept
        </button>
        <button type="button" disabled={isPending} onClick={handleDismiss}>
          Dismiss
        </button>
      </div>
      {error && <p className="inbox-row-error">{error}</p>}
    </li>
  );
}
