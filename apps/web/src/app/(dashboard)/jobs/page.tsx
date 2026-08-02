import { inArray } from "drizzle-orm";
import {
  companies as companiesTable, countInboxDuplicates, listInboxJobs, type Job,
} from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { getActiveWorkspace } from "../../../lib/workspace.js";
import { JobRow, type JobRowData, type ScoreBreakdownRow } from "./job-row.js";

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
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  const inbox = await listInboxJobs(db, ws.id);
  const duplicateCount = await countInboxDuplicates(db, ws.id);

  const companyIds = [...new Set(inbox.map((j) => j.companyId).filter((id): id is string => Boolean(id)))];
  const companyRows = companyIds.length
    ? await db.select().from(companiesTable).where(inArray(companiesTable.id, companyIds))
    : [];
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
    <main>
      <h1>Discovery inbox</h1>
      <p className="jobs-summary">
        {inbox.length} in inbox
        {duplicateCount > 0 ? ` · ${duplicateCount} hidden duplicates` : ""}
      </p>

      {ranked.length === 0 ? (
        <p>No ranked jobs in the inbox.</p>
      ) : (
        ranked.map((job) => <JobRow key={job.id} job={job} />)
      )}

      {filteredOut.length > 0 && (
        <details className="jobs-filtered-out">
          <summary>Filtered out ({filteredOut.length})</summary>
          {filteredOut.map((job) => (
            <div key={job.id} className="jobs-filtered-out-row">
              <JobRow job={job} />
              <p className="jobs-filtered-out-reason">
                {job.remoteFiltered ? "remote filter" : ""}
                {job.remoteFiltered && job.excludedBy.length > 0 ? " · " : ""}
                {job.excludedBy.length > 0 ? `excluded by: ${job.excludedBy.join(", ")}` : ""}
              </p>
            </div>
          ))}
        </details>
      )}
    </main>
  );
}
