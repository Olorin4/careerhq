import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, ingestRuns, jobs, workspaces, type Db } from "@careerhq/db";
import type { AppConfig } from "@careerhq/config";
import type { FetchContext, JobFetcher } from "@careerhq/ingest";
import { runIngestOnce } from "./ingest.js";
import { runRerankOnce } from "./rerank.js";

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
  followUpDays: 7,
  fileStorageDir: "/tmp/careerhq-worker-test",
  openrouterApiKey: null,
  aiFastModels: ["test/fast-model"],
  ingestCron: "0 */6 * * *",
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
  });
});
