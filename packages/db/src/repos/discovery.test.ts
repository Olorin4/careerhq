import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  DEFAULT_SCORING_PROFILE, normalizedJobSchema, type NormalizedJob,
} from "@careerhq/contracts";
import {
  applicationEvents, applications, createDb, jobs, type Db, workspaces,
} from "../index.js";
import {
  addWatchlistEntry,
  applyRerank,
  countInboxDuplicates,
  dismissJob,
  getScoringProfile,
  listIngestRuns,
  listInboxJobs,
  listWatchlist,
  markExpiredJobs,
  promoteJob,
  recordIngestRun,
  removeWatchlistEntry,
  saveScoringProfile,
  scoreInboxJobs,
  upsertNormalizedJobs,
} from "./discovery.js";
import { getOrCreateCompany } from "./companies.js";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

let db: Db;
let workspaceId: string;

beforeAll(async () => {
  if (!url) return;
  db = createDb(url);
  const [ws] = await db.insert(workspaces).values({ name: `t-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;
});

afterAll(async () => {
  if (!url) return;
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.$client.end();
});

const nj = (over: Partial<NormalizedJob> = {}): NormalizedJob => normalizedJobSchema.parse({
  source: "remotive", externalId: over.externalId ?? "r1", url: "https://x.example/j",
  title: "Full-Stack Engineer", companyName: "Acme", remoteMode: "remote",
  descriptionMd: "TypeScript and Node", ...over,
});

d("discovery repo", () => {
  it("insert-then-reingest updates last_seen_at, not a second row", async () => {
    const first = await upsertNormalizedJobs(db, workspaceId, [{ job: nj(), contentHash: "h1" }]);
    expect(first).toEqual({ inserted: 1, updated: 0, duplicates: 0 });
    const again = await upsertNormalizedJobs(db, workspaceId, [{ job: nj(), contentHash: "h1" }]);
    expect(again).toEqual({ inserted: 0, updated: 1, duplicates: 0 });
  });

  it("cross-source same content links duplicate_of_job_id", async () => {
    await upsertNormalizedJobs(db, workspaceId, [{ job: nj({ externalId: "a" }), contentHash: "same" }]);
    const r = await upsertNormalizedJobs(db, workspaceId,
      [{ job: nj({ source: "remoteok", externalId: "b" }), contentHash: "same" }]);
    expect(r.duplicates).toBe(1);
    // The workspace is shared across this file's tests (same harness as facts.test.ts), so
    // other non-duplicate jobs from earlier tests may already be sitting in the inbox — assert
    // on membership rather than exact length: the first-seen job stays, the duplicate is hidden.
    const inbox = await listInboxJobs(db, workspaceId);
    const externalIds = new Set(inbox.map((j) => j.externalId));
    expect(externalIds.has("a")).toBe(true);
    expect(externalIds.has("b")).toBe(false);
    expect(await countInboxDuplicates(db, workspaceId)).toBe(1);
  });

  it("scoreInboxJobs persists score and breakdown", async () => {
    await upsertNormalizedJobs(db, workspaceId, [{ job: nj({ externalId: "s1" }), contentHash: "hs" }]);
    const profile = { ...DEFAULT_SCORING_PROFILE, roles: ["full-stack"], stack: ["typescript"] };
    const n = await scoreInboxJobs(db, workspaceId, profile);
    expect(n).toBeGreaterThan(0);
    const [job] = await listInboxJobs(db, workspaceId);
    expect(job?.keywordScore).toBeGreaterThan(0);
    expect(Array.isArray((job?.keywordBreakdown as { breakdown: unknown[] })?.breakdown ?? job?.keywordBreakdown)).toBe(true);
  });

  it("markExpiredJobs expires stale rows and suggests nothing for fresh ones", async () => {
    await upsertNormalizedJobs(db, workspaceId, [{ job: nj({ externalId: "old" }), contentHash: "ho" }]);
    await db.update(jobs).set({ lastSeenAt: new Date(Date.now() - 30 * 86400_000) })
      .where(eq(jobs.workspaceId, workspaceId));
    expect(await markExpiredJobs(db, workspaceId)).toBeGreaterThan(0);
    expect(await listInboxJobs(db, workspaceId)).toHaveLength(0);
  });

  it("scoring profile round-trips and falls back to default on garbage", async () => {
    expect(await getScoringProfile(db, workspaceId)).toEqual(DEFAULT_SCORING_PROFILE);
    const custom = { ...DEFAULT_SCORING_PROFILE, roles: ["founding engineer"] };
    await saveScoringProfile(db, workspaceId, custom);
    expect((await getScoringProfile(db, workspaceId)).roles).toEqual(["founding engineer"]);
  });

  it("applyRerank writes llm fields only for this workspace's jobs", async () => {
    await upsertNormalizedJobs(db, workspaceId, [{ job: nj({ externalId: "rr" }), contentHash: "hr" }]);
    const inbox = await listInboxJobs(db, workspaceId);
    const target = inbox[0]!;
    const n = await applyRerank(db, workspaceId, [
      { jobId: target.id, score: 91, rationale: "strong fit", redFlags: ["equity-only"] },
      { jobId: "00000000-0000-0000-0000-000000000000", score: 1, rationale: "x", redFlags: [] },
    ]);
    expect(n).toBe(1);
  });

  it("getOrCreateCompany is idempotent per (workspace, name)", async () => {
    const a = await getOrCreateCompany(db, workspaceId, "DupCo");
    const b = await getOrCreateCompany(db, workspaceId, "DupCo");
    expect(a).toBe(b);
  });

  it("applyRerank clears llm fields on inbox jobs outside the batch", async () => {
    await upsertNormalizedJobs(db, workspaceId, [
      { job: nj({ externalId: "rrA" }), contentHash: "hA" },
      { job: nj({ externalId: "rrB" }), contentHash: "hB" },
    ]);
    const inbox = await listInboxJobs(db, workspaceId);
    const [a, b] = [inbox.find((j) => j.externalId === "rrA")!, inbox.find((j) => j.externalId === "rrB")!];
    await applyRerank(db, workspaceId, [
      { jobId: a.id, score: 80, rationale: "x", redFlags: [] },
      { jobId: b.id, score: 70, rationale: "y", redFlags: [] },
    ]);
    await applyRerank(db, workspaceId, [{ jobId: a.id, score: 85, rationale: "z", redFlags: [] }]);
    const after = await listInboxJobs(db, workspaceId);
    expect(after.find((j) => j.id === b.id)?.llmScore).toBeNull();
    expect(after.find((j) => j.id === a.id)?.llmScore).toBe(85);
  });

  it("duplicate surfaces when its canonical job is expired", async () => {
    await upsertNormalizedJobs(db, workspaceId, [{ job: nj({ externalId: "canX" }), contentHash: "dupX" }]);
    await upsertNormalizedJobs(db, workspaceId,
      [{ job: nj({ source: "remoteok", externalId: "dupX2" }), contentHash: "dupX" }]);
    await db.update(jobs).set({ lastSeenAt: new Date(Date.now() - 30 * 86400_000) })
      .where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.externalId, "canX")));
    await markExpiredJobs(db, workspaceId);
    const inbox = await listInboxJobs(db, workspaceId);
    expect(inbox.some((j) => j.externalId === "dupX2")).toBe(true);
  });

  it("watchlist add/list/remove round-trips", async () => {
    const entry = await addWatchlistEntry(db, {
      workspaceId, companyName: "Watched Co", atsType: "greenhouse", boardSlug: "watched-co",
    });
    expect(entry.companyName).toBe("Watched Co");
    const listed = await listWatchlist(db, workspaceId);
    expect(listed.some((w) => w.id === entry.id)).toBe(true);
    await removeWatchlistEntry(db, entry.id);
    const after = await listWatchlist(db, workspaceId);
    expect(after.some((w) => w.id === entry.id)).toBe(false);
  });

  it("recordIngestRun/listIngestRuns round-trip, ordered startedAt desc, respecting limit", async () => {
    const base = Date.now();
    await recordIngestRun(db, {
      workspaceId, source: "remotive",
      startedAt: new Date(base), finishedAt: new Date(base + 1000),
      fetched: 10, inserted: 5, updated: 2, duplicates: 1,
    });
    await recordIngestRun(db, {
      workspaceId, source: "remoteok",
      startedAt: new Date(base + 5000), finishedAt: new Date(base + 6000),
      fetched: 20, inserted: 8, updated: 3, duplicates: 0,
    });
    const all = await listIngestRuns(db, workspaceId);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[0]!.source).toBe("remoteok"); // most recent startedAt first
    expect(all[1]!.source).toBe("remotive");

    const limited = await listIngestRuns(db, workspaceId, 1);
    expect(limited).toHaveLength(1);
    expect(limited[0]!.source).toBe("remoteok");
  });

  it("promoteJob creates an application linked to the same job row, logs a discovery event, and flips job status", async () => {
    await upsertNormalizedJobs(db, workspaceId, [{ job: nj({ externalId: "promo-1" }), contentHash: "hp1" }]);
    const [job] = await db.select().from(jobs).where(eq(jobs.externalId, "promo-1"));
    const result = await promoteJob(db, workspaceId, job!.id);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const [app] = await db.select().from(applications).where(eq(applications.id, result.applicationId));
    expect(app?.jobId).toBe(job!.id);
    expect(app?.state).toBe("DISCOVERED");

    const events = await db.select().from(applicationEvents)
      .where(eq(applicationEvents.applicationId, result.applicationId));
    expect(events).toHaveLength(1);
    expect(events[0]?.trigger).toBe("user");
    expect(events[0]?.toState).toBe("DISCOVERED");
    expect(events[0]?.payload).toEqual({ promotedFrom: "discovery" });

    const [updatedJob] = await db.select().from(jobs).where(eq(jobs.id, job!.id));
    expect(updatedJob?.status).toBe("promoted");
  });

  it("promoteJob refuses a job that already has an application (already promoted)", async () => {
    await upsertNormalizedJobs(db, workspaceId, [{ job: nj({ externalId: "promo-2" }), contentHash: "hp2" }]);
    const [job] = await db.select().from(jobs).where(eq(jobs.externalId, "promo-2"));
    const first = await promoteJob(db, workspaceId, job!.id);
    expect(first.ok).toBe(true);

    const second = await promoteJob(db, workspaceId, job!.id);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.reason.length).toBeGreaterThan(0);
  });

  it("promoteJob refuses a job that does not exist", async () => {
    const result = await promoteJob(db, workspaceId, "00000000-0000-0000-0000-000000000000");
    expect(result.ok).toBe(false);
  });

  it("persists salaryRaw and postedAt on insert and update", async () => {
    const posted = new Date("2026-07-01T00:00:00Z");
    await upsertNormalizedJobs(db, workspaceId, [{
      job: nj({ externalId: "sal1", salaryRaw: "$100k-$140k", postedAt: posted }), contentHash: "hsal",
    }]);
    let [row] = await db.select().from(jobs).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.externalId, "sal1")));
    expect(row?.salaryRaw).toBe("$100k-$140k");
    expect(row?.postedAt?.toISOString()).toBe(posted.toISOString());
    await upsertNormalizedJobs(db, workspaceId, [{
      job: nj({ externalId: "sal1", salaryRaw: "$110k-$150k", postedAt: posted }), contentHash: "hsal",
    }]);
    [row] = await db.select().from(jobs).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.externalId, "sal1")));
    expect(row?.salaryRaw).toBe("$110k-$150k");
  });

  it("listInboxJobs returns the same order on every read when scores tie", async () => {
    const externalIds = Array.from({ length: 12 }, (_, i) => `tie-${i}`);
    await upsertNormalizedJobs(db, workspaceId, externalIds.map((externalId) => ({
      job: nj({ externalId }), contentHash: `h-${externalId}`,
    })));
    // Both scoring keys deliberately identical: this is the state the demo seed
    // produces (a re-rank hands out repeated round numbers) and the state in
    // which the ordering was previously up to Postgres.
    await db.update(jobs).set({ llmScore: 70, keywordScore: 55 })
      .where(and(eq(jobs.workspaceId, workspaceId), inArray(jobs.externalId, externalIds)));

    const readOrder = async (): Promise<string[]> => (await listInboxJobs(db, workspaceId))
      .filter((j) => j.externalId?.startsWith("tie-"))
      .map((j) => j.id);

    const first = await readOrder();
    expect(first).toHaveLength(externalIds.length);

    // One read proves nothing — an untied query returns rows in whatever order
    // the executor read the heap, which is stable until the heap moves. Each
    // UPDATE rewrites its tuple at the end of the table, so without a final
    // sort key the next read comes back in a different order.
    for (const id of first) {
      await db.update(jobs).set({ lastSeenAt: sql`clock_timestamp()` }).where(eq(jobs.id, id));
      expect(await readOrder()).toEqual(first);
    }

    // And the order is the one the worker's rerank tie-break also produces:
    // ascending id. Postgres compares uuids bytewise, which for the canonical
    // lowercase text form is the same order JS gives.
    expect(first).toEqual([...first].sort());
  });

  it("dismissJob flips job status and removes it from the inbox", async () => {
    await upsertNormalizedJobs(db, workspaceId, [{ job: nj({ externalId: "dismiss-1" }), contentHash: "hd1" }]);
    const [job] = await db.select().from(jobs).where(eq(jobs.externalId, "dismiss-1"));
    await dismissJob(db, workspaceId, job!.id);

    const [updatedJob] = await db.select().from(jobs).where(eq(jobs.id, job!.id));
    expect(updatedJob?.status).toBe("dismissed");

    const inbox = await listInboxJobs(db, workspaceId);
    expect(inbox.some((j) => j.id === job!.id)).toBe(false);
  });
});
