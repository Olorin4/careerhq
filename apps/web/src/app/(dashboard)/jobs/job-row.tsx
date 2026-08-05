"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { dismissJobAction, promoteJobAction } from "./actions.js";
import { safeExternalHref } from "../../../lib/safe-url.js";

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

  return (
    <article className="job-row" data-testid="job-row">
      <header className="job-row-header">
        {safeUrl ? (
          <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="job-row-link" data-testid="job-row-link">
            <strong>{job.title}</strong> · {job.company}
          </a>
        ) : (
          <span className="job-row-link" data-testid="job-row-link">
            <strong>{job.title}</strong> · {job.company}
          </span>
        )}
        {job.remoteMode && <span className="badge">{job.remoteMode}</span>}
        {job.location && <span className="job-row-location">{job.location}</span>}
      </header>

      <div className="job-row-scores">
        <span>keyword score: {job.keywordScore ?? "–"}</span>
        {job.llmScore != null && <span>llm score: {job.llmScore}</span>}
      </div>

      {job.llmRationale && <p className="job-row-rationale" data-testid="job-row-rationale">{job.llmRationale}</p>}

      {job.llmRedFlags.length > 0 && (
        <div className="job-row-flags" data-testid="job-row-flags">
          {job.llmRedFlags.map((flag) => (
            <span key={flag} className="badge badge-stale">{flag}</span>
          ))}
        </div>
      )}

      {job.breakdown.length > 0 && (
        <details className="job-row-breakdown" data-testid="job-row-breakdown">
          <summary>Score breakdown</summary>
          <ul>
            {job.breakdown.map((entry) => (
              <li key={`${entry.kind}:${entry.term}:${entry.points}:${entry.inTitle}`}>
                {entry.term} ({entry.kind}
                {entry.inTitle ? ", in title" : ""}): {entry.points} pts
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="job-row-actions">
        {applicationId ? (
          <a href={`/applications/${applicationId}`}>View application</a>
        ) : (
          <>
            <button type="button" disabled={isPending} onClick={handlePromote}>Promote</button>
            <button type="button" disabled={isPending} onClick={handleDismiss}>Dismiss</button>
          </>
        )}
      </div>
      {error && <p className="job-row-error">{error}</p>}
    </article>
  );
}
