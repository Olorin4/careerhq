import {
  and, asc, desc, eq, isNotNull, isNull, lt, ne, sql,
} from "drizzle-orm";
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

export async function upsertNormalizedJobs(
  db: Db,
  workspaceId: string,
  items: Array<{ job: NormalizedJob; contentHash: string }>,
): Promise<UpsertResult> {
  return db.transaction(async (tx) => {
    let inserted = 0;
    let updated = 0;
    let duplicates = 0;

    for (const { job, contentHash } of items) {
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
          lastSeenAt: sql`now()`,
          expiredAt: null,
        }).where(eq(jobs.id, existing.id));
        updated += 1;
        continue;
      }

      const [created] = await tx.insert(jobs).values({
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
      )).orderBy(asc(jobs.firstSeenAt)).limit(1);

      if (firstSeen) {
        await tx.update(jobs).set({ duplicateOfJobId: firstSeen.id })
          .where(eq(jobs.id, created!.id));
        duplicates += 1;
      }
    }

    return { inserted, updated, duplicates };
  });
}

export async function scoreInboxJobs(db: Db, workspaceId: string, profile: ScoringProfile): Promise<number> {
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
  const updated = await db.update(jobs).set({ expiredAt: sql`now()` })
    .where(and(
      eq(jobs.workspaceId, workspaceId),
      isNull(jobs.expiredAt),
      lt(jobs.lastSeenAt, cutoff),
    ))
    .returning({ id: jobs.id });
  return updated.length;
}

export async function recordIngestRun(db: Db, run: NewIngestRun & { finishedAt: Date }): Promise<void> {
  await db.insert(ingestRuns).values(run);
}

export async function listIngestRuns(
  db: Db,
  workspaceId: string,
  limit = DEFAULT_INGEST_RUNS_LIMIT,
): Promise<IngestRun[]> {
  return db.select().from(ingestRuns)
    .where(eq(ingestRuns.workspaceId, workspaceId))
    .orderBy(desc(ingestRuns.startedAt))
    .limit(limit);
}

export async function listInboxJobs(db: Db, workspaceId: string): Promise<Job[]> {
  return db.select().from(jobs).where(and(
    eq(jobs.workspaceId, workspaceId),
    eq(jobs.status, "inbox"),
    isNull(jobs.expiredAt),
    isNull(jobs.duplicateOfJobId),
  )).orderBy(sql`${jobs.llmScore} DESC NULLS LAST`, desc(jobs.keywordScore));
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
  db: Db,
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
  return count;
}

export async function getScoringProfile(db: Db, workspaceId: string): Promise<ScoringProfile> {
  const [row] = await db.select().from(scoringProfiles).where(eq(scoringProfiles.workspaceId, workspaceId));
  if (!row) return DEFAULT_SCORING_PROFILE;
  const parsed = scoringProfileSchema.safeParse(row.profile);
  return parsed.success ? parsed.data : DEFAULT_SCORING_PROFILE;
}

export async function saveScoringProfile(db: Db, workspaceId: string, profile: ScoringProfile): Promise<void> {
  await db.insert(scoringProfiles).values({ workspaceId, profile })
    .onConflictDoUpdate({
      target: scoringProfiles.workspaceId,
      set: { profile, updatedAt: sql`now()` },
    });
}

export async function listWatchlist(db: Db, workspaceId: string): Promise<WatchlistCompany[]> {
  return db.select().from(watchlistCompanies)
    .where(eq(watchlistCompanies.workspaceId, workspaceId))
    .orderBy(asc(watchlistCompanies.createdAt));
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

/**
 * Insert-or-select against `companies_workspace_name` (migration 0001). Takes
 * `DbOrTx` so callers already inside a transaction — `createApplication` — get
 * the same conflict-safe semantics without opening a nested one.
 */
export async function getOrCreateCompany(db: DbOrTx, workspaceId: string, name: string): Promise<string> {
  await db.insert(companies).values({ workspaceId, name })
    .onConflictDoNothing({ target: [companies.workspaceId, companies.name] });
  const [company] = await db.select({ id: companies.id }).from(companies)
    .where(and(eq(companies.workspaceId, workspaceId), eq(companies.name, name)));
  return company!.id;
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
export async function promoteJob(db: Db, workspaceId: string, jobId: string): Promise<PromoteJobOutcome> {
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
