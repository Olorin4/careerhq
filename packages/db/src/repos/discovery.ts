import {
  and, asc, desc, eq, exists, isNotNull, isNull, lt, ne, notInArray, or, sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  DEFAULT_SCORING_PROFILE, scoringProfileSchema,
  type ApplicationState, type AtsType, type NormalizedJob, type RerankResult, type ScoringProfile,
} from "@careerhq/contracts";
import { computeNextAction, scoreJob } from "@careerhq/core";
import type { Db, DbOrTx } from "../client.js";
import {
  applicationEvents, applications, companies, ingestRuns, jobs, scoringProfiles, watchlistCompanies,
} from "../schema/index.js";
import type {
  IngestRun, Job, NewIngestRun, WatchlistCompany,
} from "../index.js";

const EXPIRY_DAYS = 21;
const DEFAULT_INGEST_RUNS_LIMIT = 20;

export interface UpsertResult { inserted: number; updated: number; duplicates: number }

/**
 * `id` overrides the generated primary key on INSERT only (an existing row
 * keeps the id it already has). Exists for one caller — the demo seed, whose
 * listings must keep the same ids across every six-hourly rebuild because the
 * re-rank prompt embeds them verbatim and that prompt is an AI replay
 * fixture's cache key. Real ingest sources never set it.
 */
export interface UpsertJobItem {
  job: NormalizedJob;
  contentHash: string;
  id?: string;
}

export async function upsertNormalizedJobs(
  db: DbOrTx,
  workspaceId: string,
  items: UpsertJobItem[],
): Promise<UpsertResult> {
  return db.transaction(async (tx) => {
    let inserted = 0;
    let updated = 0;
    let duplicates = 0;

    for (const { job, contentHash, id } of items) {
      await tx.insert(companies).values({ workspaceId, name: job.companyName })
        .onConflictDoNothing({ target: [companies.workspaceId, companies.name] });
      const [company] = await tx.select({ id: companies.id }).from(companies)
        .where(and(eq(companies.workspaceId, workspaceId), eq(companies.name, job.companyName)));
      const companyId = company!.id;

      const [existing] = await tx.select().from(jobs).where(and(
        eq(jobs.workspaceId, workspaceId),
        eq(jobs.source, job.source),
        eq(jobs.externalId, job.externalId),
      ));

      if (existing) {
        await tx.update(jobs).set({
          companyId,
          url: job.url,
          title: job.title,
          location: job.location,
          remoteMode: job.remoteMode,
          descriptionMd: job.descriptionMd,
          salaryRaw: job.salaryRaw,
          postedAt: job.postedAt,
          contentHash,
          lastSeenAt: sql`clock_timestamp()`,
          expiredAt: null,
        }).where(eq(jobs.id, existing.id));
        updated += 1;
        continue;
      }

      const [created] = await tx.insert(jobs).values({
        ...(id !== undefined ? { id } : {}),
        workspaceId,
        companyId,
        source: job.source,
        externalId: job.externalId,
        url: job.url,
        title: job.title,
        location: job.location,
        remoteMode: job.remoteMode,
        descriptionMd: job.descriptionMd,
        salaryRaw: job.salaryRaw,
        postedAt: job.postedAt,
        contentHash,
      }).returning();
      inserted += 1;

      const [firstSeen] = await tx.select().from(jobs).where(and(
        eq(jobs.workspaceId, workspaceId),
        eq(jobs.contentHash, contentHash),
        isNull(jobs.expiredAt),
        ne(jobs.id, created!.id),
      // Two rows can share a first_seen_at (clock_timestamp() has microsecond
      // resolution and a seed inserts a batch inside one transaction), and
      // which of them wins decides which listing the inbox hides as a
      // duplicate. `id` makes that choice the same one every time.
      )).orderBy(asc(jobs.firstSeenAt), asc(jobs.id)).limit(1);

      if (firstSeen) {
        await tx.update(jobs).set({ duplicateOfJobId: firstSeen.id })
          .where(eq(jobs.id, created!.id));
        duplicates += 1;
      }
    }

    return { inserted, updated, duplicates };
  });
}

export async function scoreInboxJobs(db: DbOrTx, workspaceId: string, profile: ScoringProfile): Promise<number> {
  const rows = await db.select().from(jobs).where(and(
    eq(jobs.workspaceId, workspaceId),
    eq(jobs.status, "inbox"),
    isNull(jobs.expiredAt),
  ));

  for (const row of rows) {
    const result = scoreJob(
      { title: row.title, descriptionMd: row.descriptionMd, remoteMode: row.remoteMode },
      profile,
    );
    await db.update(jobs).set({ keywordScore: result.score, keywordBreakdown: result })
      .where(eq(jobs.id, row.id));
  }

  return rows.length;
}

export async function markExpiredJobs(db: Db, workspaceId: string, olderThanDays = EXPIRY_DAYS): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const updated = await db.update(jobs).set({ expiredAt: sql`clock_timestamp()` })
    .where(and(
      eq(jobs.workspaceId, workspaceId),
      isNull(jobs.expiredAt),
      lt(jobs.lastSeenAt, cutoff),
    ))
    .returning({ id: jobs.id });
  return updated.length;
}

export async function recordIngestRun(db: DbOrTx, run: NewIngestRun & { finishedAt: Date }): Promise<void> {
  await db.insert(ingestRuns).values(run);
}

export async function listIngestRuns(
  db: Db,
  workspaceId: string,
  limit = DEFAULT_INGEST_RUNS_LIMIT,
): Promise<IngestRun[]> {
  return db.select().from(ingestRuns)
    .where(eq(ingestRuns.workspaceId, workspaceId))
    .orderBy(desc(ingestRuns.startedAt), asc(ingestRuns.id))
    .limit(limit);
}

export async function listInboxJobs(db: Db, workspaceId: string): Promise<Job[]> {
  const canonical = alias(jobs, "canonical_job");
  return db.select().from(jobs).where(and(
    eq(jobs.workspaceId, workspaceId),
    eq(jobs.status, "inbox"),
    isNull(jobs.expiredAt),
    or(
      isNull(jobs.duplicateOfJobId),
      // The canonical job this row was flagged a duplicate of is no longer
      // visible in the inbox (expired or dismissed) — surface the duplicate
      // instead of silently losing the listing.
      exists(
        db.select({ one: sql`1` }).from(canonical).where(and(
          eq(canonical.id, jobs.duplicateOfJobId),
          or(isNotNull(canonical.expiredAt), eq(canonical.status, "dismissed")),
        )),
      ),
    ),
  // `id` last is what makes this a *total* order, and it is load-bearing rather
  // than tidiness. Without it Postgres is free to return equal-scoring listings
  // in whatever order it read them — measured different between two runs over
  // the same rows — so the inbox reshuffles between renders and the demo's
  // screenshots and walkthrough recording stop being reproducible. It also
  // decides which listings survive `topNForLlm` and the order they take in the
  // re-rank prompt, and that prompt is an AI replay fixture's cache key.
  // Ascending, to agree with the same tie-break in the worker's rerank job.
  )).orderBy(sql`${jobs.llmScore} DESC NULLS LAST`, desc(jobs.keywordScore), asc(jobs.id));
}

export async function countInboxDuplicates(db: Db, workspaceId: string): Promise<number> {
  const rows = await db.select({ id: jobs.id }).from(jobs).where(and(
    eq(jobs.workspaceId, workspaceId),
    eq(jobs.status, "inbox"),
    isNull(jobs.expiredAt),
    isNotNull(jobs.duplicateOfJobId),
  ));
  return rows.length;
}

export async function applyRerank(
  db: DbOrTx,
  workspaceId: string,
  results: RerankResult["results"],
): Promise<number> {
  let count = 0;
  for (const r of results) {
    const affected = await db.update(jobs).set({
      llmScore: r.score,
      llmRationale: r.rationale,
      llmRedFlags: r.redFlags,
    }).where(and(eq(jobs.id, r.jobId), eq(jobs.workspaceId, workspaceId)))
      .returning({ id: jobs.id });
    count += affected.length;
  }

  // A rerank batch only ever covers part of the inbox — jobs left out (new
  // arrivals since the last rerank, or ones the LLM skipped) would otherwise
  // keep a stale llm_score that outranks freshly-scored jobs in
  // `listInboxJobs`. Clear it for everyone outside this batch.
  const batchIds = results.map((r) => r.jobId);
  await db.update(jobs).set({
    llmScore: null,
    llmRationale: null,
    llmRedFlags: null,
  }).where(and(
    eq(jobs.workspaceId, workspaceId),
    eq(jobs.status, "inbox"),
    ...(batchIds.length > 0 ? [notInArray(jobs.id, batchIds)] : []),
  ));

  return count;
}

export async function getScoringProfile(db: Db, workspaceId: string): Promise<ScoringProfile> {
  const [row] = await db.select().from(scoringProfiles).where(eq(scoringProfiles.workspaceId, workspaceId));
  if (!row) return DEFAULT_SCORING_PROFILE;
  const parsed = scoringProfileSchema.safeParse(row.profile);
  return parsed.success ? parsed.data : DEFAULT_SCORING_PROFILE;
}

export async function saveScoringProfile(db: DbOrTx, workspaceId: string, profile: ScoringProfile): Promise<void> {
  await db.insert(scoringProfiles).values({ workspaceId, profile })
    .onConflictDoUpdate({
      target: scoringProfiles.workspaceId,
      set: { profile, updatedAt: sql`clock_timestamp()` },
    });
}

export async function listWatchlist(db: Db, workspaceId: string): Promise<WatchlistCompany[]> {
  return db.select().from(watchlistCompanies)
    .where(eq(watchlistCompanies.workspaceId, workspaceId))
    .orderBy(asc(watchlistCompanies.createdAt), asc(watchlistCompanies.id));
}

export async function addWatchlistEntry(
  db: Db,
  e: { workspaceId: string; companyName: string; atsType: AtsType; boardSlug: string },
): Promise<WatchlistCompany> {
  const [entry] = await db.insert(watchlistCompanies).values(e).returning();
  return entry!;
}

export async function removeWatchlistEntry(db: Db, id: string): Promise<void> {
  await db.delete(watchlistCompanies).where(eq(watchlistCompanies.id, id));
}

export type PromoteJobOutcome = { ok: true; applicationId: string } | { ok: false; reason: string };

/**
 * Promotes an inbox job straight into the application pipeline. Unlike
 * `createApplication` (which mints a brand-new manual job row), this links the
 * new application to THIS job row — the company and job already exist from
 * ingest, so there is nothing to recreate. Refuses when the job is missing,
 * not in the inbox, or already has an application (covers "already promoted"
 * and any other terminal/duplicate state) to keep promotion idempotent.
 */
export async function promoteJob(db: DbOrTx, workspaceId: string, jobId: string): Promise<PromoteJobOutcome> {
  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, workspaceId)))
      .for("update");
    if (!job) return { ok: false, reason: "job not found" };
    if (job.status !== "inbox") return { ok: false, reason: `job is not in the inbox (status: ${job.status})` };

    const [existingApp] = await tx.select({ id: applications.id }).from(applications)
      .where(eq(applications.jobId, jobId));
    if (existingApp) return { ok: false, reason: "job already has an application" };

    const state: ApplicationState = "DISCOVERED";
    const next = computeNextAction({ state, submittedAt: null });
    const [app] = await tx.insert(applications).values({
      workspaceId, jobId, state,
      nextAction: next?.label ?? null, nextActionDue: next?.due ?? null,
    }).returning();

    await tx.insert(applicationEvents).values({
      applicationId: app!.id, fromState: null, toState: state, trigger: "user",
      payload: { promotedFrom: "discovery" },
    });

    await tx.update(jobs).set({ status: "promoted" }).where(eq(jobs.id, jobId));

    return { ok: true, applicationId: app!.id };
  });
}

export async function dismissJob(db: Db, workspaceId: string, jobId: string): Promise<void> {
  await db.update(jobs).set({ status: "dismissed" })
    .where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, workspaceId)));
}
