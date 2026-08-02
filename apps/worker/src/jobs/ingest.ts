import {
  getScoringProfile,
  listWatchlist,
  markExpiredJobs,
  recordIngestRun,
  scoreInboxJobs,
  upsertNormalizedJobs,
  type Db,
} from "@careerhq/db";
import {
  arbeitnowFetcher,
  contentHashOf,
  fetchJson,
  fetchText,
  makeAtsBoardsFetcher,
  remoteokFetcher,
  remotiveFetcher,
  themuseFetcher,
  wwrFetcher,
  type FetchContext,
  type JobFetcher,
} from "@careerhq/ingest";

/** The always-on fetchers. The ATS-boards fetcher is built per-run from the workspace's watchlist. */
export const ALL_FETCHERS: JobFetcher[] = [
  remotiveFetcher,
  remoteokFetcher,
  arbeitnowFetcher,
  wwrFetcher,
  themuseFetcher,
];

const DEFAULT_FETCH_CTX: FetchContext = { fetchJson, fetchText };

export interface IngestSummary {
  runs: number;
  inserted: number;
  updated: number;
  duplicates: number;
  errors: number;
}

/**
 * Runs every source fetcher for `workspaceId` sequentially, upserting whatever each one
 * returns and recording one `ingest_runs` row per source. A fetcher throwing is recorded
 * as an errored run (with the message) and does not stop the remaining sources — ingestion
 * is best-effort per source, not all-or-nothing. Once every source has run, expired jobs
 * are marked and the inbox is (re)scored against the workspace's scoring profile.
 */
export async function runIngestOnce(
  db: Db,
  workspaceId: string,
  opts?: { fetchers?: JobFetcher[]; fetchCtx?: FetchContext },
): Promise<IngestSummary> {
  const fetchCtx = opts?.fetchCtx ?? DEFAULT_FETCH_CTX;
  const fetchers = [...(opts?.fetchers ?? ALL_FETCHERS)];

  const watchlist = await listWatchlist(db, workspaceId);
  if (watchlist.length > 0) {
    fetchers.push(
      makeAtsBoardsFetcher(
        watchlist.map((entry) => ({
          atsType: entry.atsType,
          boardSlug: entry.boardSlug,
          companyName: entry.companyName,
        })),
      ),
    );
  }

  const summary: IngestSummary = { runs: 0, inserted: 0, updated: 0, duplicates: 0, errors: 0 };

  for (const fetcher of fetchers) {
    const startedAt = new Date();
    summary.runs += 1;

    try {
      const fetched = await fetcher.fetch(fetchCtx);
      const items = fetched.map((job) => ({ job, contentHash: contentHashOf(job) }));
      const result = await upsertNormalizedJobs(db, workspaceId, items);

      await recordIngestRun(db, {
        workspaceId,
        source: fetcher.source,
        startedAt,
        finishedAt: new Date(),
        fetched: fetched.length,
        inserted: result.inserted,
        updated: result.updated,
        duplicates: result.duplicates,
      });

      summary.inserted += result.inserted;
      summary.updated += result.updated;
      summary.duplicates += result.duplicates;
    } catch (err) {
      summary.errors += 1;
      await recordIngestRun(db, {
        workspaceId,
        source: fetcher.source,
        startedAt,
        finishedAt: new Date(),
        fetched: 0,
        inserted: 0,
        updated: 0,
        duplicates: 0,
        errors: [{ message: err instanceof Error ? err.message : String(err) }],
      });
    }
  }

  await markExpiredJobs(db, workspaceId);
  const profile = await getScoringProfile(db, workspaceId);
  await scoreInboxJobs(db, workspaceId, profile);

  return summary;
}
