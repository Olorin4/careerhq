import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, ingestRuns, jobs, workspaces, type Db } from "@careerhq/db";
import type { AppConfig } from "@careerhq/config";
import type { JobScore } from "@careerhq/core";
import type { FetchContext, JobFetcher } from "@careerhq/ingest";
import type * as AiModule from "@careerhq/ai";
import { runIngestOnce } from "./ingest.js";
import { runRerankOnce } from "./rerank.js";

// The candidate filter must decide *before* any model call, so the assertion
// that matters is "rerankJobs was never reached" — which needs a stub, not a
// network round-trip against a fake key.
const { rerankJobsMock } = vi.hoisted(() => ({ rerankJobsMock: vi.fn() }));
vi.mock("@careerhq/ai", async (importOriginal) => ({
  ...await importOriginal<typeof AiModule>(),
  rerankJobs: rerankJobsMock,
}));

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

let db: Db;
let workspaceId: string;

beforeAll(async () => {
  if (!url) return;
  db = createDb(url);
  const [ws] = await db.insert(workspaces).values({ name: `worker-t-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;
});

afterAll(async () => {
  if (!url) return;
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.$client.end();
});

const unusedFetchCtx: FetchContext = {
  fetchJson: async () => {
    throw new Error("fetchJson should be unused by these stub fetchers");
  },
  fetchText: async () => {
    throw new Error("fetchText should be unused by these stub fetchers");
  },
};

// Same company/title/description (case- and whitespace-insensitively) as fetcherAlpha's job,
// so contentHashOf collides across the two sources — the cross-source duplicate path.
const sharedDescription = "Own the payments platform end to end, in TypeScript on Postgres.";

const fetcherAlpha: JobFetcher = {
  source: "stub-alpha",
  async fetch() {
    return [{
      source: "stub-alpha",
      externalId: "alpha-1",
      url: "https://example.test/alpha-1",
      title: "Backend Engineer",
      companyName: "Acme Co",
      remoteMode: "remote",
      descriptionMd: sharedDescription,
    }];
  },
};

const fetcherBeta: JobFetcher = {
  source: "stub-beta",
  async fetch() {
    return [
      {
        source: "stub-beta",
        externalId: "beta-1",
        url: "https://example.test/beta-1",
        title: "Frontend Engineer",
        companyName: "Globex",
        remoteMode: "remote",
        descriptionMd: "A wholly unrelated, unique listing.",
      },
      {
        source: "stub-beta",
        externalId: "beta-2",
        url: "https://example.test/beta-2",
        title: "Backend Engineer",
        companyName: "Acme Co",
        remoteMode: "remote",
        descriptionMd: sharedDescription,
      },
    ];
  },
};

const fetcherGamma: JobFetcher = {
  source: "stub-gamma",
  async fetch() {
    throw new Error("upstream boom");
  },
};

const baseConfig: AppConfig = {
  databaseUrl: url ?? "",
  submissionsLiveEmail: false,
  submissionsLiveCompanySite: false,
  sandboxForceSafe: false,
  sandboxSmtpAllowedHost: "mailpit",
  followUpDays: 7,
  fileStorageDir: "/tmp/careerhq-worker-test",
  openrouterApiKey: null,
  aiFastModels: ["test/fast-model"],
  aiWritingModels: ["test/writing-model"],
  aiReplayDir: "/tmp/careerhq-worker-test/replay",
  ingestCron: "0 */6 * * *",
  aiMode: "live",
  masterKey: null,
};

d("runIngestOnce", () => {
  it("upserts per-fetcher, records a run per source (the failing one carrying errors), dedupes cross-source, and scores the inbox", async () => {
    const summary = await runIngestOnce(db, workspaceId, {
      fetchers: [fetcherAlpha, fetcherBeta, fetcherGamma],
      fetchCtx: unusedFetchCtx,
    });

    // "duplicates" is not mutually exclusive with "inserted" — a duplicate is still a newly
    // inserted row (new externalId), just one that upsertNormalizedJobs also links to an
    // earlier row sharing its content hash (see packages/db/src/repos/discovery.ts).
    expect(summary).toEqual({ runs: 3, inserted: 3, updated: 0, duplicates: 1, errors: 1 });

    const runs = await db.select().from(ingestRuns).where(eq(ingestRuns.workspaceId, workspaceId));
    const bySource = Object.fromEntries(runs.map((r) => [r.source, r]));
    expect(bySource["stub-alpha"]?.errors).toBeNull();
    expect(bySource["stub-beta"]?.errors).toBeNull();
    expect(bySource["stub-gamma"]?.errors).toBeTruthy();
    expect(bySource["stub-gamma"]?.fetched).toBe(0);

    const rows = await db.select().from(jobs).where(eq(jobs.workspaceId, workspaceId));
    expect(rows.length).toBe(3);
    for (const row of rows) expect(row.keywordScore).not.toBeNull();

    const duplicate = rows.find((row) => row.externalId === "beta-2");
    expect(duplicate?.duplicateOfJobId).not.toBeNull();
  });
});

d("runRerankOnce", () => {
  it("returns skipped_no_key when no OpenRouter key is configured, without ever calling the LLM", async () => {
    const result = await runRerankOnce(db, workspaceId, baseConfig);
    expect(result).toEqual({ status: "skipped_no_key", reranked: 0 });
    expect(rerankJobsMock).not.toHaveBeenCalled();
  });
});

const keyedConfig: AppConfig = { ...baseConfig, openrouterApiKey: "sk-or-test" };

/** A stored `JobScore` breakdown with every gate overridable per test. */
function breakdown(over: Partial<JobScore>): JobScore {
  return {
    score: 10, excluded: false, excludedBy: [], remoteFiltered: false,
    meetsMinimums: true, breakdown: [], ...over,
  };
}

// Spec §5.4: excluded jobs are never shown scored, and a remote-filtered job is
// not a candidate either. Sending them to the LLM burns tokens on listings the
// inbox will not display and can push genuinely eligible jobs out of topNForLlm.
d("runRerankOnce candidate filter", () => {
  let filterWorkspaceId: string;

  beforeAll(async () => {
    if (!url) return;
    const [ws] = await db.insert(workspaces)
      .values({ name: `worker-filter-t-${Date.now()}`, kind: "personal" }).returning();
    filterWorkspaceId = ws!.id;
  });

  afterAll(async () => {
    if (!url) return;
    await db.delete(workspaces).where(eq(workspaces.id, filterWorkspaceId));
  });

  beforeEach(async () => {
    rerankJobsMock.mockReset();
    if (!url) return;
    await db.delete(jobs).where(eq(jobs.workspaceId, filterWorkspaceId));
  });

  async function seedJob(externalId: string, keywordBreakdown: JobScore): Promise<string> {
    const [row] = await db.insert(jobs).values({
      workspaceId: filterWorkspaceId, source: "stub-filter", externalId,
      url: `https://example.test/${externalId}`, title: "Backend Engineer",
      remoteMode: "remote", descriptionMd: "TypeScript on Postgres.",
      keywordScore: keywordBreakdown.score, keywordBreakdown, status: "inbox",
    }).returning({ id: jobs.id });
    return row!.id;
  }

  it("skips jobs the keyword scorer excluded, even when they meet the minimums", async () => {
    await seedJob("excluded-1", breakdown({ excluded: true, excludedBy: ["clearance"], score: 0 }));

    const result = await runRerankOnce(db, filterWorkspaceId, keyedConfig);

    expect(result).toEqual({ status: "skipped_empty", reranked: 0 });
    expect(rerankJobsMock).not.toHaveBeenCalled();
  });

  it("skips remote-filtered jobs, even when they meet the minimums", async () => {
    await seedJob("onsite-1", breakdown({ remoteFiltered: true, score: 0 }));

    const result = await runRerankOnce(db, filterWorkspaceId, keyedConfig);

    expect(result).toEqual({ status: "skipped_empty", reranked: 0 });
    expect(rerankJobsMock).not.toHaveBeenCalled();
  });

  it("sends only the eligible job when excluded and remote-filtered ones sit alongside it", async () => {
    await seedJob("excluded-2", breakdown({ excluded: true, excludedBy: ["clearance"], score: 0 }));
    await seedJob("onsite-2", breakdown({ remoteFiltered: true, score: 0 }));
    await seedJob("minimums-2", breakdown({ meetsMinimums: false }));
    const eligibleId = await seedJob("eligible-2", breakdown({ score: 14 }));

    rerankJobsMock.mockResolvedValue({
      ok: true, model: "test/fast-model", latencyMs: 1, status: 200, error: null, attempts: [],
      value: { results: [{ jobId: eligibleId, score: 91, rationale: "strong fit", redFlags: [] }] },
    });

    const result = await runRerankOnce(db, filterWorkspaceId, keyedConfig);

    expect(result).toEqual({ status: "ok", reranked: 1 });
    expect(rerankJobsMock).toHaveBeenCalledTimes(1);
    const sentIds = (rerankJobsMock.mock.calls[0]?.[0] as AiModule.RerankJobInput[]).map((job) => job.id);
    expect(sentIds).toEqual([eligibleId]);

    const [row] = await db.select().from(jobs).where(eq(jobs.id, eligibleId));
    expect(row?.llmScore).toBe(91);
  });
});
