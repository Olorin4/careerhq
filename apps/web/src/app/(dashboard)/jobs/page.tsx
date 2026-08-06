import { inArray } from "drizzle-orm";
import {
  companies as companiesTable, countInboxDuplicates, listInboxJobs, type Job,
} from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { readWorkspaceSnapshot } from "../../../lib/workspace.js";
import { EmptyState } from "../../../components/empty-state.js";
import { JobRow, type JobRowData, type ScoreBreakdownRow } from "./job-row.js";
import { IngestHealth } from "./health.js";

// Every render reads the database, so there is nothing to prerender: without
// this Next would build these pages statically (baking in build-time data and
// requiring a reachable database at build time, which the container image has
// no reason to have).
export const dynamic = "force-dynamic";

interface KeywordBreakdown {
  breakdown?: ScoreBreakdownRow[];
  excludedBy?: string[];
  remoteFiltered?: boolean;
}

function toRowData(job: Job, company: string): JobRowData {
  const kb = (job.keywordBreakdown ?? null) as KeywordBreakdown | null;
  return {
    id: job.id,
    title: job.title,
    company,
    location: job.location,
    remoteMode: job.remoteMode,
    url: job.url,
    keywordScore: job.keywordScore,
    breakdown: kb?.breakdown ?? [],
    excludedBy: kb?.excludedBy ?? [],
    remoteFiltered: kb?.remoteFiltered ?? false,
    llmScore: job.llmScore,
    llmRationale: job.llmRationale,
    llmRedFlags: (job.llmRedFlags as string[] | null) ?? [],
  };
}

export default async function JobsPage() {
  // One snapshot: the inbox, the duplicate count reported beside it and the
  // companies those jobs name are one workspace generation, never a mix of two
  // across a demo reset (see `readWorkspaceSnapshot`).
  const { workspaceId, inbox, duplicateCount, companyRows } = await readWorkspaceSnapshot(
    getDb(),
    async (tx, ws) => {
      const jobs = await listInboxJobs(tx, ws.id);
      const duplicates = await countInboxDuplicates(tx, ws.id);
      const companyIds = [...new Set(jobs.map((j) => j.companyId).filter((id): id is string => Boolean(id)))];
      const companies = companyIds.length
        ? await tx.select().from(companiesTable).where(inArray(companiesTable.id, companyIds))
        : [];
      return { workspaceId: ws.id, inbox: jobs, duplicateCount: duplicates, companyRows: companies };
    },
  );
  const companyName = (id: string | null) => companyRows.find((c) => c.id === id)?.name ?? "?";

  // Re-ranking/filtering annotates rather than deletes (spec §5.4): jobs that
  // were excluded by a keyword or filtered out by the remote requirement stay
  // in the inbox with score 0 and get surfaced here with their reasons, never
  // silently dropped.
  const ranked: JobRowData[] = [];
  const filteredOut: JobRowData[] = [];
  for (const job of inbox) {
    const row = toRowData(job, companyName(job.companyId));
    if (row.excludedBy.length > 0 || row.remoteFiltered) {
      filteredOut.push(row);
    } else {
      ranked.push(row);
    }
  }

  return (
    <main className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-ink">Discovery inbox</h1>
        <p className="m-0 text-sm text-muted">
          <span className="font-medium tabular-nums text-ink">{inbox.length}</span> in inbox
          {duplicateCount > 0 && (
            <>
              {" · "}
              <span className="font-medium tabular-nums text-ink">{duplicateCount}</span> hidden duplicates
            </>
          )}
        </p>
      </div>

      <details className="rounded-lg border border-line bg-surface">
        <summary className="cursor-pointer select-none px-4 py-2 text-sm font-medium text-ink">
          Pipeline health
        </summary>
        <div className="border-t border-line p-4">
          <IngestHealth workspaceId={workspaceId} />
        </div>
      </details>

      {ranked.length === 0 ? (
        <EmptyState
          title="No ranked jobs in the inbox"
          hint="New matches appear here once discovery runs."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {ranked.map((job) => <JobRow key={job.id} job={job} />)}
        </div>
      )}

      {filteredOut.length > 0 && (
        <details className="rounded-lg border border-line bg-surface">
          <summary className="cursor-pointer select-none px-4 py-2 text-sm font-medium text-ink">
            Filtered out (<span className="tabular-nums">{filteredOut.length}</span>)
          </summary>
          <div className="flex flex-col gap-3 border-t border-line p-4">
            {filteredOut.map((job) => (
              <div key={job.id} className="flex flex-col gap-1">
                <JobRow job={job} />
                <p className="m-0 text-xs text-muted">
                  {job.remoteFiltered ? "remote filter" : ""}
                  {job.remoteFiltered && job.excludedBy.length > 0 ? " · " : ""}
                  {job.excludedBy.length > 0 ? `excluded by: ${job.excludedBy.join(", ")}` : ""}
                </p>
              </div>
            ))}
          </div>
        </details>
      )}
    </main>
  );
}
