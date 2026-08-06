"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ApplicationState, ReplyClassification } from "@careerhq/contracts";
import { Badge } from "../../../components/badge.js";
import { Button } from "../../../components/button.js";
import { EmptyState } from "../../../components/empty-state.js";
import { Row } from "../../../components/row.js";
import { classificationTone } from "../../../lib/application-state.js";
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

export function SuggestionQueue({ suggestions }: { suggestions: SuggestionListItem[] }) {
  if (suggestions.length === 0) {
    return <EmptyState title="No pending suggestions" hint="The review queue is clear." />;
  }
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {suggestions.map((suggestion) => (
        <li key={suggestion.id}>
          <SuggestionRow suggestion={suggestion} />
        </li>
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
    <Row testId="inbox-row">
      <div className="flex flex-1 flex-col gap-2">
        <p className="m-0 font-semibold text-ink">{suggestion.subject || "(no subject)"}</p>
        <p className="m-0 text-xs text-soft">
          From {suggestion.fromAddr} — {formatTimestamp(suggestion.receivedAt)}
        </p>
        <p className="m-0 text-sm text-ink">{suggestion.snippet}</p>

        {suggestion.application && (
          <p className="m-0 text-sm text-muted">
            <a href={`/applications/${suggestion.application.id}`} className="text-ink underline">
              {suggestion.application.company} · {suggestion.application.title}
            </a>
            {" — "}
            {humanize(suggestion.application.state)}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {suggestion.classification && (
            <Badge tone={classificationTone(suggestion.classification)}>
              {humanize(suggestion.classification)}
              {suggestion.classificationConfidence !== null
                ? ` (${Math.round(suggestion.classificationConfidence * 100)}%)`
                : ""}
            </Badge>
          )}
          {suggestion.suggestedTransition && (
            <span className="text-sm text-muted">→ {humanize(suggestion.suggestedTransition)}</span>
          )}
        </div>

        {suggestion.quotedEvidence && (
          <blockquote
            data-testid="inbox-row-evidence"
            className="m-0 border-l-2 border-line pl-3 text-sm italic text-muted"
          >
            &ldquo;{suggestion.quotedEvidence}&rdquo;
          </blockquote>
        )}

        <div className="flex gap-2">
          <Button
            type="button" tone="primary"
            disabled={isPending || !suggestion.application || !suggestion.suggestedTransition}
            onClick={handleAccept}
          >
            Accept
          </Button>
          <Button type="button" tone="default" disabled={isPending} onClick={handleDismiss}>
            Dismiss
          </Button>
        </div>
        {error && (
          <p className="m-0 text-sm text-bad" role="alert">
            {error}
          </p>
        )}
      </div>
    </Row>
  );
}
