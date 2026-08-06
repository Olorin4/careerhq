"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { dismissJobAction, promoteJobAction } from "./actions.js";
import { safeExternalHref } from "../../../lib/safe-url.js";
import { Badge } from "../../../components/badge.js";
import { Button } from "../../../components/button.js";

export interface ScoreBreakdownRow {
  term: string;
  kind: "role" | "stack" | "boost" | "exclude";
  inTitle: boolean;
  points: number;
}

export interface JobRowData {
  id: string;
  title: string;
  company: string;
  location: string | null;
  remoteMode: string | null;
  url: string | null;
  keywordScore: number | null;
  breakdown: ScoreBreakdownRow[];
  excludedBy: string[];
  remoteFiltered: boolean;
  llmScore: number | null;
  llmRationale: string | null;
  llmRedFlags: string[];
}

export function JobRow({ job }: { job: JobRowData }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [applicationId, setApplicationId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  function handlePromote() {
    setError(null);
    startTransition(async () => {
      const result = await promoteJobAction({ jobId: job.id });
      if (result.ok) {
        setApplicationId(result.applicationId);
        router.refresh();
      } else {
        setError(result.reason);
      }
    });
  }

  function handleDismiss() {
    setError(null);
    startTransition(async () => {
      const result = await dismissJobAction({ jobId: job.id });
      if (!result.ok) {
        setError(result.reason);
        return;
      }
      setDismissed(true);
      router.refresh();
    });
  }

  if (dismissed) return null;

  const safeUrl = safeExternalHref(job.url);
  const titleBlock = (
    <>
      <strong className="font-semibold">{job.title}</strong>
      <span className="text-muted"> · {job.company}</span>
    </>
  );

  return (
    <article
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-card"
      data-testid="job-row"
    >
      <header className="flex flex-wrap items-center gap-2">
        {safeUrl ? (
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-ink no-underline hover:underline"
            data-testid="job-row-link"
          >
            {titleBlock}
          </a>
        ) : (
          <span className="text-ink" data-testid="job-row-link">
            {titleBlock}
          </span>
        )}
        {/* Remote mode is metadata, not a workflow state — same reasoning
            the fact bank gives sensitivity — so it stays `neutral`
            regardless of value. */}
        {job.remoteMode && <Badge tone="neutral">{job.remoteMode}</Badge>}
        {job.location && <span className="text-sm text-muted">{job.location}</span>}
      </header>

      {/* A fixed label column keeps the score digits themselves lined up
          from row to row down the whole inbox, not just within one row. */}
      <dl className="m-0 grid grid-cols-[6rem_auto] gap-x-3 gap-y-0.5 text-sm text-muted">
        <dt>Keyword</dt>
        <dd className="font-medium tabular-nums text-ink">{job.keywordScore ?? "–"}</dd>
        {job.llmScore != null && (
          <>
            <dt>LLM</dt>
            <dd className="font-medium tabular-nums text-ink">{job.llmScore}</dd>
          </>
        )}
      </dl>

      {job.llmRationale && (
        <p
          className="m-0 rounded-md border border-line bg-canvas p-3 text-sm leading-relaxed text-ink"
          data-testid="job-row-rationale"
        >
          {job.llmRationale}
        </p>
      )}

      {/* A red flag is something the applicant should read and judge for
          themselves, not evidence the pipeline failed — `warn` (the user
          must act), the same reading the fact bank gives a stale fact. */}
      {job.llmRedFlags.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid="job-row-flags">
          {job.llmRedFlags.map((flag) => (
            <Badge key={flag} tone="warn">{flag}</Badge>
          ))}
        </div>
      )}

      {job.breakdown.length > 0 && (
        <details className="rounded-md border border-line" data-testid="job-row-breakdown">
          <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-ink">
            Score breakdown
          </summary>
          <ul className="m-0 flex list-none flex-col gap-1 border-t border-line p-3 text-sm text-ink">
            {job.breakdown.map((entry) => (
              <li
                key={`${entry.kind}:${entry.term}:${entry.points}:${entry.inTitle}`}
                className="flex items-center justify-between gap-3"
              >
                <span>
                  {entry.term}{" "}
                  <span className="text-xs text-muted">
                    ({entry.kind}
                    {entry.inTitle ? ", in title" : ""})
                  </span>
                </span>
                <span className="font-medium tabular-nums">{entry.points} pts</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="flex gap-2">
        {applicationId ? (
          <a href={`/applications/${applicationId}`} className="text-sm font-medium text-ink underline">
            View application
          </a>
        ) : (
          <>
            <Button type="button" tone="primary" disabled={isPending} onClick={handlePromote}>
              Promote
            </Button>
            <Button type="button" tone="default" disabled={isPending} onClick={handleDismiss}>
              Dismiss
            </Button>
          </>
        )}
      </div>
      {error && <p className="m-0 text-sm text-bad">{error}</p>}
    </article>
  );
}
