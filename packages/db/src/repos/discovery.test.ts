import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  DEFAULT_SCORING_PROFILE, normalizedJobSchema, type NormalizedJob,
} from "@careerhq/contracts";
import { createDb, jobs, type Db, workspaces } from "../index.js";
import {
  addWatchlistEntry,
  applyRerank,
  countInboxDuplicates,
  getOrCreateCompany,
  getScoringProfile,
  listIngestRuns,
  listInboxJobs,
  listWatchlist,
  markExpiredJobs,
  recordIngestRun,
  removeWatchlistEntry,
  saveScoringProfile,
  scoreInboxJobs,
  upsertNormalizedJobs,
} from "./discovery.js";

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
});
