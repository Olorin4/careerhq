# CareerHQ P2 — Discovery Ingestion, Scoring, AI Re-rank Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the job-discovery pipeline of spec v0.3 §5: keyless feed fetchers with normalization and two-level dedup, a deterministic keyword scorer with persisted breakdown, the OpenRouter AI layer (chatJson + sequential fallback) with the `rerank` task, scheduled worker ingestion with run health tracking, and the discovery inbox UI with promote/dismiss — Phase P2 of `docs/roadmap.md`.

**Architecture:** `packages/ingest` holds pure fetchers (fixture-tested, no live calls in tests) and normalization; `packages/db` gains the ingest repositories (upsert with `(source, external_id)` + content-hash dedup, expiry sweep, run recording); `packages/core` gains the pure keyword scorer; new `packages/ai` holds the OpenRouter chatJson client (ported pattern from kelevoTMS), sequential model fallback with per-model 429 cooldown, and the `rerank` task. `apps/worker` schedules ingestion → scoring → optional re-rank; `apps/web` gains the inbox, scoring-profile settings, watchlist, and pipeline-health UI. **Deterministic floor everywhere:** with no `OPENROUTER_API_KEY`, everything works on keyword order (spec §1.4).

**Tech Stack:** additions — `fast-xml-parser` (WWR RSS), no other new runtime deps. Existing: Node 22, TS strict ESM, Drizzle/Postgres, pg-boss 10, Zod 3, Vitest 3.

## Global Constraints

- Package boundaries (dependency-cruiser enforced): `core` imports ONLY `contracts`; `ingest` imports `contracts` (+`core` allowed) — **`ingest` must NOT import `db`** (fetch/normalize is pure; persistence happens in `db` repos called by `worker`); `ai` imports `contracts`+`core` only. Update `.dependency-cruiser.cjs` rules accordingly (Task 12).
- Discovery sources (spec §5.1, this phase): Remotive, RemoteOK, Arbeitnow, We Work Remotely, The Muse, plus Greenhouse/Lever/Ashby board polling from a user watchlist. HN "Who is hiring" and BYO-key sources (Adzuna/Reed/USAJobs) are OUT of this plan (stretch, later).
- Polite fetching (spec §5.1): User-Agent `CareerHQ/0.2 (+https://github.com/careerhq)` on every request, 15s timeout, one request at a time per source (no parallel hammering), no retries inside fetchers (the scheduled run retries naturally).
- Dedup (spec §5.2): key 1 `(workspace_id, source, external_id)` upsert updating `last_seen_at`; key 2 content hash = sha256 of `lower(company)|lower(title)|first 500 normalized chars of description` — cross-source matches link via `duplicate_of_job_id` to the first-seen job. Expiry: `expired_at` set when `last_seen_at` older than 21 days (`EXPIRY_DAYS = 21`).
- Scoring (spec §5.4): deterministic, transparent; weights ROLE=3 (×2 when in title), STACK=2, BOOST=1; any `exclude` term hit → excluded (never shown scored); `requireRemote`/`includeUnknownRemote` filtering; per-term breakdown persisted in `jobs.keyword_breakdown`.
- LLM re-rank (spec §5.4): top N=`topNForLlm` (default 25) inbox jobs; output `{jobId, score 0–100, rationale, redFlags[]}`; annotates and reorders, never deletes/hides; LLM unavailable → keyword order stands.
- AI layer (spec §8): OpenRouter OpenAI-compatible endpoint `https://openrouter.ai/api/v1`; JSON mode + temperature 0; tolerant JSON extraction; Zod validation; `isUseful` predicate; never-throws result objects; **sequential** fallback over ordered model list with exponential backoff on 429/5xx and per-model cooldown (NOT kelevoTMS's parallel race — see ADR-0003). Model lists are config data (env), not code.
- All AI/network code is testable with mocked `fetch`; NO live network calls in any test; fetcher tests use saved fixtures in `packages/ingest/fixtures/`.
- Repo conventions from P1: TS strict, ESM `.js` specifiers, no `any`; vitest; `describe.skipIf(!process.env.TEST_DATABASE_URL)` for DB integration tests with `afterAll` workspace cleanup; this host's dev/test postgres is `postgres://careerhq:careerhq@localhost:5433/careerhq`; conventional commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; dep-adding commits include the lockfile.
- Reference (read, don't copy verbatim): `/home/olorin4/web-dev/kelevoTMS/apps/backend/src/features/ai/llm/chat-json.service.ts` (the pattern ADR-0003 credits); `/home/olorin4/web-dev/career/scripts/discover/` (predecessor fetchers, Python — concepts only).

---

### Task 1: Contracts — discovery and scoring types

**Files:**
- Modify: `packages/contracts/src/index.ts` (append)
- Test: `packages/contracts/src/discovery.test.ts`

**Interfaces:**
- Produces (appended to `@careerhq/contracts`):
```ts
export const JOB_STATUSES = ["inbox", "promoted", "dismissed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const jobStatusSchema = z.enum(JOB_STATUSES);

export const REMOTE_MODES = ["remote", "hybrid", "onsite", "unknown"] as const;
export type RemoteMode = (typeof REMOTE_MODES)[number];
export const remoteModeSchema = z.enum(REMOTE_MODES);

export const ATS_TYPES = ["greenhouse", "lever", "ashby"] as const;
export type AtsType = (typeof ATS_TYPES)[number];
export const atsTypeSchema = z.enum(ATS_TYPES);

export const normalizedJobSchema = z.object({
  source: z.string().min(1),
  externalId: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  companyName: z.string().min(1),
  location: z.string().optional(),
  remoteMode: remoteModeSchema.default("unknown"),
  salaryRaw: z.string().optional(),
  descriptionMd: z.string().optional(),
  postedAt: z.coerce.date().optional(),
});
export type NormalizedJob = z.infer<typeof normalizedJobSchema>;

export const scoringProfileSchema = z.object({
  roles: z.array(z.string()).default([]),
  stack: z.array(z.string()).default([]),
  boost: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  requireRemote: z.boolean().default(true),
  includeUnknownRemote: z.boolean().default(true),
  minRoleHits: z.number().int().min(0).default(1),
  minStackHits: z.number().int().min(0).default(1),
  topNForLlm: z.number().int().positive().default(25),
});
export type ScoringProfile = z.infer<typeof scoringProfileSchema>;
export const DEFAULT_SCORING_PROFILE: ScoringProfile = scoringProfileSchema.parse({});

export const rerankResultSchema = z.object({
  results: z.array(z.object({
    jobId: z.string(),
    score: z.number().min(0).max(100),
    rationale: z.string().min(1),
    redFlags: z.array(z.string()).default([]),
  })),
});
export type RerankResult = z.infer<typeof rerankResultSchema>;
```

- [ ] **Step 1: Write the failing test**

`packages/contracts/src/discovery.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCORING_PROFILE, normalizedJobSchema, rerankResultSchema, scoringProfileSchema,
} from "./index.js";

describe("discovery contracts", () => {
  it("normalizedJob requires source/externalId/url/title/companyName and defaults remoteMode", () => {
    const parsed = normalizedJobSchema.parse({
      source: "remotive", externalId: "123", url: "https://x.example/job",
      title: "Engineer", companyName: "Acme",
    });
    expect(parsed.remoteMode).toBe("unknown");
    expect(normalizedJobSchema.safeParse({ source: "remotive" }).success).toBe(false);
  });
  it("scoring profile defaults match spec §5.4", () => {
    expect(DEFAULT_SCORING_PROFILE.topNForLlm).toBe(25);
    expect(DEFAULT_SCORING_PROFILE.requireRemote).toBe(true);
    expect(DEFAULT_SCORING_PROFILE.minRoleHits).toBe(1);
  });
  it("rerank result bounds scores to 0-100", () => {
    expect(rerankResultSchema.safeParse({
      results: [{ jobId: "a", score: 101, rationale: "x" }],
    }).success).toBe(false);
    const ok = rerankResultSchema.parse({ results: [{ jobId: "a", score: 88, rationale: "fit" }] });
    expect(ok.results[0]?.redFlags).toEqual([]);
  });
  it("profile arrays default empty", () => {
    expect(scoringProfileSchema.parse({}).roles).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @careerhq/contracts test` → FAIL (exports missing).
- [ ] **Step 3: Implement** — append the Interfaces block verbatim to `packages/contracts/src/index.ts`.
- [ ] **Step 4: Run to verify pass + build** — `pnpm --filter @careerhq/contracts test && pnpm --filter @careerhq/contracts build`.
- [ ] **Step 5: Commit** — `feat(contracts): discovery, scoring-profile and rerank schemas`

---

### Task 2: DB schema v2 — ingest tables and LLM columns

**Files:**
- Modify: `packages/db/src/schema/index.ts`
- Create (generated): `packages/db/migrations/0001_*.sql`

**Interfaces:**
- Produces: new tables `ingest_runs`, `scoring_profiles`, `watchlist_companies`; new `jobs` columns `llm_score real`, `llm_rationale text`, `llm_red_flags jsonb`, `duplicate_of_job_id uuid`; unique index `companies_workspace_name` on `(workspace_id, name)`; pg enum `ats_type` from `ATS_TYPES`.

- [ ] **Step 1: Extend the schema**

Append/modify in `packages/db/src/schema/index.ts` (imports: add `ATS_TYPES` from contracts):
```ts
export const atsType = pgEnum("ats_type", ATS_TYPES);

// jobs table additions (add to the existing pgTable columns):
//   llmScore: real("llm_score"),
//   llmRationale: text("llm_rationale"),
//   llmRedFlags: jsonb("llm_red_flags"),
//   duplicateOfJobId: uuid("duplicate_of_job_id"),

export const ingestRuns = pgTable("ingest_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  fetched: integer("fetched").notNull().default(0),
  inserted: integer("inserted").notNull().default(0),
  updated: integer("updated").notNull().default(0),
  duplicates: integer("duplicates").notNull().default(0),
  errors: jsonb("errors"),
}, (t) => [index("ingest_runs_workspace_started").on(t.workspaceId, t.startedAt)]);

export const scoringProfiles = pgTable("scoring_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  profile: jsonb("profile").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("scoring_profiles_workspace").on(t.workspaceId)]);

export const watchlistCompanies = pgTable("watchlist_companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  companyName: text("company_name").notNull(),
  atsType: atsType("ats_type").notNull(),
  boardSlug: text("board_slug").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("watchlist_workspace_ats_slug").on(t.workspaceId, t.atsType, t.boardSlug)]);
```
Also add `uniqueIndex("companies_workspace_name").on(t.workspaceId, t.name)` to `companies`, add `integer` back to the pg-core import, and export inferred types from `packages/db/src/index.ts`: `IngestRun`, `NewIngestRun`, `WatchlistCompany`, plus `jobs`-derived `Job` already exists (unchanged name).

- [ ] **Step 2: Generate + inspect migration** — `pnpm --filter @careerhq/db db:generate`; READ the SQL: must contain `CREATE TYPE "ats_type"`, 3 `CREATE TABLE`, 4 `ALTER TABLE "jobs" ADD COLUMN`, and the companies unique index. Quote these lines in the report.
- [ ] **Step 3: Apply locally** — `DATABASE_URL=postgres://careerhq:careerhq@localhost:5433/careerhq pnpm --filter @careerhq/db db:migrate` (existing seed data must survive — companies in the seed are unique per workspace, so the new unique index applies cleanly; verify with `\d companies`).
- [ ] **Step 4: Typecheck + full db tests** — `pnpm --filter @careerhq/db typecheck && TEST_DATABASE_URL=postgres://careerhq:careerhq@localhost:5433/careerhq pnpm --filter @careerhq/db test`.
- [ ] **Step 5: Commit** — `feat(db): schema v2 — ingest runs, scoring profiles, watchlist, job llm/duplicate columns`

---

### Task 3: Core — deterministic keyword scorer

**Files:**
- Create: `packages/core/src/scoring/keyword.ts`
- Modify: `packages/core/src/index.ts` (append export)
- Test: `packages/core/src/scoring/keyword.test.ts`

**Interfaces:**
- Consumes: `ScoringProfile` from contracts.
- Produces:
```ts
export const SCORE_WEIGHTS = { role: 3, roleTitleMultiplier: 2, stack: 2, boost: 1 } as const;
export interface ScoreBreakdownEntry {
  term: string; kind: "role" | "stack" | "boost" | "exclude";
  inTitle: boolean; points: number;
}
export interface JobScore {
  score: number;                 // 0 when excluded or remote-filtered
  excluded: boolean; excludedBy: string[];
  remoteFiltered: boolean;
  meetsMinimums: boolean;        // roleHits >= minRoleHits && stackHits >= minStackHits
  breakdown: ScoreBreakdownEntry[];
}
export function scoreJob(
  job: { title: string; descriptionMd?: string | null; remoteMode?: string | null },
  profile: ScoringProfile,
): JobScore;
```
- Matching: case-insensitive whole-substring match of each profile term against title and description (title checked separately for the multiplier); each term counts at most once per kind (`hits` not multiplied by occurrences); exclude terms match against title+description and any hit sets `excluded` with the term listed in `excludedBy` and `score = 0`; `remoteFiltered = requireRemote && (remoteMode === "onsite" || (remoteMode == null || remoteMode === "unknown") && !includeUnknownRemote)` → `score = 0` but breakdown still computed (UI shows why).

- [ ] **Step 1: Write the failing tests**

`packages/core/src/scoring/keyword.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_SCORING_PROFILE } from "@careerhq/contracts";
import { scoreJob, SCORE_WEIGHTS } from "./keyword.js";

const profile = {
  ...DEFAULT_SCORING_PROFILE,
  roles: ["full-stack", "founding engineer"],
  stack: ["typescript", "node"],
  boost: ["logistics"],
  exclude: ["security clearance"],
};

describe("keyword scorer (spec §5.4)", () => {
  it("scores role in title with multiplier, stack and boost in description", () => {
    const s = scoreJob(
      { title: "Full-Stack Engineer", descriptionMd: "TypeScript, Node, logistics domain", remoteMode: "remote" },
      profile,
    );
    expect(s.excluded).toBe(false);
    expect(s.score).toBe(
      SCORE_WEIGHTS.role * SCORE_WEIGHTS.roleTitleMultiplier + SCORE_WEIGHTS.stack * 2 + SCORE_WEIGHTS.boost,
    );
    expect(s.breakdown.find((b) => b.term === "full-stack")?.inTitle).toBe(true);
    expect(s.meetsMinimums).toBe(true);
  });
  it("a term counts once even when it appears many times", () => {
    const s = scoreJob(
      { title: "Engineer", descriptionMd: "node node node typescript", remoteMode: "remote" },
      profile,
    );
    expect(s.breakdown.filter((b) => b.kind === "stack")).toHaveLength(2);
    expect(s.score).toBe(SCORE_WEIGHTS.stack * 2);
  });
  it("exclude term zeroes the score and records the reason", () => {
    const s = scoreJob(
      { title: "Full-Stack Engineer", descriptionMd: "Requires security clearance", remoteMode: "remote" },
      profile,
    );
    expect(s.excluded).toBe(true);
    expect(s.excludedBy).toEqual(["security clearance"]);
    expect(s.score).toBe(0);
  });
  it("remote filtering: onsite always filtered; unknown filtered only when includeUnknownRemote=false", () => {
    expect(scoreJob({ title: "Full-Stack", remoteMode: "onsite" }, profile).remoteFiltered).toBe(true);
    expect(scoreJob({ title: "Full-Stack", remoteMode: "unknown" }, profile).remoteFiltered).toBe(false);
    expect(scoreJob({ title: "Full-Stack", remoteMode: "unknown" },
      { ...profile, includeUnknownRemote: false }).remoteFiltered).toBe(true);
    expect(scoreJob({ title: "Full-Stack", remoteMode: "onsite" },
      { ...profile, requireRemote: false }).remoteFiltered).toBe(false);
  });
  it("meetsMinimums false when role hits below minimum", () => {
    const s = scoreJob({ title: "Backend dev", descriptionMd: "typescript", remoteMode: "remote" }, profile);
    expect(s.meetsMinimums).toBe(false);
  });
  it("matching is case-insensitive", () => {
    const s = scoreJob({ title: "FOUNDING ENGINEER", remoteMode: "remote" }, profile);
    expect(s.breakdown.some((b) => b.term === "founding engineer")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `pnpm --filter @careerhq/core test`.
- [ ] **Step 3: Implement**

`packages/core/src/scoring/keyword.ts`:
```ts
import type { ScoringProfile } from "@careerhq/contracts";

export const SCORE_WEIGHTS = { role: 3, roleTitleMultiplier: 2, stack: 2, boost: 1 } as const;

export interface ScoreBreakdownEntry {
  term: string; kind: "role" | "stack" | "boost" | "exclude";
  inTitle: boolean; points: number;
}
export interface JobScore {
  score: number; excluded: boolean; excludedBy: string[];
  remoteFiltered: boolean; meetsMinimums: boolean;
  breakdown: ScoreBreakdownEntry[];
}

export function scoreJob(
  job: { title: string; descriptionMd?: string | null; remoteMode?: string | null },
  profile: ScoringProfile,
): JobScore {
  const title = job.title.toLowerCase();
  const body = `${title}\n${(job.descriptionMd ?? "").toLowerCase()}`;
  const breakdown: ScoreBreakdownEntry[] = [];
  const excludedBy: string[] = [];
  let roleHits = 0, stackHits = 0, score = 0;

  const scan = (terms: string[], kind: "role" | "stack" | "boost", base: number) => {
    for (const raw of terms) {
      const term = raw.toLowerCase();
      if (!term || !body.includes(term)) continue;
      const inTitle = title.includes(term);
      const points = kind === "role" && inTitle ? base * SCORE_WEIGHTS.roleTitleMultiplier : base;
      breakdown.push({ term: raw, kind, inTitle, points });
      score += points;
      if (kind === "role") roleHits += 1;
      if (kind === "stack") stackHits += 1;
    }
  };
  scan(profile.roles, "role", SCORE_WEIGHTS.role);
  scan(profile.stack, "stack", SCORE_WEIGHTS.stack);
  scan(profile.boost, "boost", SCORE_WEIGHTS.boost);

  for (const raw of profile.exclude) {
    const term = raw.toLowerCase();
    if (term && body.includes(term)) {
      excludedBy.push(raw);
      breakdown.push({ term: raw, kind: "exclude", inTitle: title.includes(term), points: 0 });
    }
  }
  const excluded = excludedBy.length > 0;

  const mode = job.remoteMode ?? "unknown";
  const remoteFiltered = profile.requireRemote &&
    (mode === "onsite" || ((mode === "unknown") && !profile.includeUnknownRemote));

  return {
    score: excluded || remoteFiltered ? 0 : score,
    excluded, excludedBy, remoteFiltered,
    meetsMinimums: roleHits >= profile.minRoleHits && stackHits >= profile.minStackHits,
    breakdown,
  };
}
```
Append `export * from "./scoring/keyword.js";` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run to verify PASS + build** — `pnpm --filter @careerhq/core test && pnpm --filter @careerhq/core build`.
- [ ] **Step 5: Commit** — `feat(core): deterministic keyword scorer with per-term breakdown`

---

### Task 4: Ingest package — net helper, normalization, content hash, Remotive fetcher (exemplar)

**Files:**
- Create: `packages/ingest/package.json`, `packages/ingest/tsconfig.json`, `packages/ingest/src/index.ts`, `packages/ingest/src/net.ts`, `packages/ingest/src/normalize.ts`, `packages/ingest/src/fetchers/types.ts`, `packages/ingest/src/fetchers/remotive.ts`
- Create: `packages/ingest/fixtures/remotive.json`
- Test: `packages/ingest/src/normalize.test.ts`, `packages/ingest/src/fetchers/remotive.test.ts`

**Interfaces:**
- Produces:
```ts
// net.ts
export const INGEST_USER_AGENT = "CareerHQ/0.2 (+https://github.com/careerhq)";
export async function fetchJson(url: string, opts?: { timeoutMs?: number }): Promise<unknown>; // throws IngestFetchError on non-2xx/timeout
export async function fetchText(url: string, opts?: { timeoutMs?: number }): Promise<string>;
export class IngestFetchError extends Error { constructor(message: string, readonly status?: number) }
// normalize.ts
export function stripHtml(html: string): string;                       // tags → text, entities &amp; &lt; &gt; &#39; &quot; &nbsp; decoded, whitespace collapsed
export function contentHashOf(job: Pick<NormalizedJob, "companyName" | "title" | "descriptionMd">): string;
// fetchers/types.ts
export interface FetchContext { fetchJson: typeof fetchJson; fetchText: typeof fetchText }
export interface JobFetcher {
  source: string;                                       // e.g. "remotive"
  fetch(ctx: FetchContext): Promise<NormalizedJob[]>;   // validates each item via normalizedJobSchema; skips (does not throw on) individual bad items
}
// fetchers/remotive.ts
export const remotiveFetcher: JobFetcher;               // GET https://remotive.com/api/remote-jobs?category=software-dev&limit=100
// index.ts re-exports all of the above
```
- `contentHashOf` = sha256 hex of `` `${companyName.toLowerCase().trim()}|${title.toLowerCase().trim()}|${normalizedDescPrefix}` `` where `normalizedDescPrefix` = first 500 chars of `stripHtml(descriptionMd ?? "")` lowercased with whitespace collapsed to single spaces.
- Package: name `@careerhq/ingest`, deps `@careerhq/contracts workspace:*`, `zod ^3.25.0`; devDeps `vitest`; standard scripts incl. `"test": "vitest run"`; mirrors the contracts package tsconfig pattern.
- Fixture: capture ONE real response — `curl -s "https://remotive.com/api/remote-jobs?category=software-dev&limit=5" > packages/ingest/fixtures/remotive.json` (5 items keeps it small). This is the only permitted live call, done once at authoring time, never in tests.

- [ ] **Step 1: Write the failing tests**

`packages/ingest/src/normalize.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { contentHashOf, stripHtml } from "./normalize.js";

describe("stripHtml", () => {
  it("removes tags, decodes common entities, collapses whitespace", () => {
    expect(stripHtml("<p>Hello&nbsp;&amp;\n<b>world</b></p>")).toBe("Hello & world");
  });
});
describe("contentHashOf (spec §5.2 key 2)", () => {
  const base = { companyName: "Acme", title: "Engineer", descriptionMd: "<p>Build things</p>" };
  it("is stable across case and whitespace variants", () => {
    expect(contentHashOf(base)).toBe(
      contentHashOf({ companyName: " ACME ", title: "engineer", descriptionMd: "Build   things" }),
    );
  });
  it("differs when the title differs", () => {
    expect(contentHashOf(base)).not.toBe(contentHashOf({ ...base, title: "Designer" }));
  });
  it("uses only the first 500 description chars", () => {
    const long = "x".repeat(600);
    expect(contentHashOf({ ...base, descriptionMd: long }))
      .toBe(contentHashOf({ ...base, descriptionMd: long.slice(0, 500) + "DIFFERENT TAIL" }));
  });
});
```

`packages/ingest/src/fetchers/remotive.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { remotiveFetcher } from "./remotive.js";
import type { FetchContext } from "./types.js";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/remotive.json", import.meta.url), "utf8"));
const ctx: FetchContext = {
  fetchJson: async () => fixture,
  fetchText: async () => { throw new Error("unused"); },
};

describe("remotive fetcher", () => {
  it("normalizes fixture items with source remotive and remote mode", async () => {
    const jobs = await remotiveFetcher.fetch(ctx);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(j.source).toBe("remotive");
      expect(j.externalId).toBeTruthy();
      expect(j.url).toMatch(/^https?:\/\//);
      expect(j.remoteMode).toBe("remote");
    }
  });
  it("skips malformed items instead of throwing", async () => {
    const broken: FetchContext = {
      ...ctx,
      fetchJson: async () => ({ jobs: [{ id: 1 }, ...(fixture as { jobs: unknown[] }).jobs] }),
    };
    const jobs = await remotiveFetcher.fetch(broken);
    expect(jobs.length).toBeGreaterThan(0); // the bad item is dropped, the rest survive
  });
});
```

- [ ] **Step 2: Capture the fixture** — run the one-time curl above; verify the file contains a `jobs` array; trim to ≤5 items if larger.
- [ ] **Step 3: Run tests to verify FAIL** — `pnpm install && pnpm --filter @careerhq/ingest test`.
- [ ] **Step 4: Implement**

`packages/ingest/src/net.ts`:
```ts
export const INGEST_USER_AGENT = "CareerHQ/0.2 (+https://github.com/careerhq)";
const DEFAULT_TIMEOUT_MS = 15_000;

export class IngestFetchError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

async function request(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": INGEST_USER_AGENT, Accept: "application/json, application/rss+xml, text/xml, */*" },
      signal: controller.signal,
    });
    if (!res.ok) throw new IngestFetchError(`GET ${url} → ${res.status}`, res.status);
    return res;
  } catch (err) {
    if (err instanceof IngestFetchError) throw err;
    throw new IngestFetchError(`GET ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url: string, opts?: { timeoutMs?: number }): Promise<unknown> {
  return (await request(url, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS)).json();
}
export async function fetchText(url: string, opts?: { timeoutMs?: number }): Promise<string> {
  return (await request(url, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS)).text();
}
```

`packages/ingest/src/normalize.ts`:
```ts
import { createHash } from "node:crypto";
import type { NormalizedJob } from "@careerhq/contracts";

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ",
};

export function stripHtml(html: string): string {
  let text = html.replace(/<[^>]*>/g, " ");
  for (const [entity, char] of Object.entries(ENTITIES)) text = text.replaceAll(entity, char);
  return text.replace(/\s+/g, " ").trim();
}

export function contentHashOf(job: Pick<NormalizedJob, "companyName" | "title" | "descriptionMd">): string {
  const desc = stripHtml(job.descriptionMd ?? "").toLowerCase().slice(0, 500);
  const key = `${job.companyName.toLowerCase().trim()}|${job.title.toLowerCase().trim()}|${desc}`;
  return createHash("sha256").update(key).digest("hex");
}
```

`packages/ingest/src/fetchers/types.ts`:
```ts
import type { NormalizedJob } from "@careerhq/contracts";
import type { fetchJson, fetchText } from "../net.js";

export interface FetchContext { fetchJson: typeof fetchJson; fetchText: typeof fetchText }
export interface JobFetcher {
  source: string;
  fetch(ctx: FetchContext): Promise<NormalizedJob[]>;
}
```

`packages/ingest/src/fetchers/remotive.ts`:
```ts
import { normalizedJobSchema, type NormalizedJob } from "@careerhq/contracts";
import type { FetchContext, JobFetcher } from "./types.js";

const URL = "https://remotive.com/api/remote-jobs?category=software-dev&limit=100";

export const remotiveFetcher: JobFetcher = {
  source: "remotive",
  async fetch(ctx: FetchContext): Promise<NormalizedJob[]> {
    const data = (await ctx.fetchJson(URL)) as { jobs?: unknown[] };
    const out: NormalizedJob[] = [];
    for (const raw of data.jobs ?? []) {
      const r = raw as Record<string, unknown>;
      const parsed = normalizedJobSchema.safeParse({
        source: "remotive",
        externalId: String(r.id ?? ""),
        url: r.url,
        title: r.title,
        companyName: r.company_name,
        location: r.candidate_required_location,
        remoteMode: "remote",
        salaryRaw: r.salary || undefined,
        descriptionMd: r.description,
        postedAt: r.publication_date,
      });
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  },
};
```
`packages/ingest/src/index.ts` re-exports net, normalize, fetchers/types, and every fetcher.

- [ ] **Step 5: Run to verify PASS + build + lint** — `pnpm --filter @careerhq/ingest test && pnpm --filter @careerhq/ingest build && pnpm --filter @careerhq/ingest lint`.
- [ ] **Step 6: Commit** — `feat(ingest): package scaffold, net/normalize helpers, remotive fetcher`

---

### Task 5: Fetchers — RemoteOK and Arbeitnow

**Files:**
- Create: `packages/ingest/src/fetchers/remoteok.ts`, `packages/ingest/src/fetchers/arbeitnow.ts`
- Create: `packages/ingest/fixtures/remoteok.json`, `packages/ingest/fixtures/arbeitnow.json`
- Modify: `packages/ingest/src/index.ts`
- Test: `packages/ingest/src/fetchers/remoteok.test.ts`, `packages/ingest/src/fetchers/arbeitnow.test.ts`

**Interfaces:**
- Produces: `remoteokFetcher: JobFetcher` (source `"remoteok"`), `arbeitnowFetcher: JobFetcher` (source `"arbeitnow"`).
- **RemoteOK**: GET `https://remoteok.com/api`. Response is a JSON ARRAY whose FIRST element is a legal notice object (no `id`) — skip any element without both `id` and `position`. Field mapping: `externalId ← String(id)`, `url ← url`, `title ← position`, `companyName ← company`, `location ← location || undefined`, `remoteMode ← "remote"`, `salaryRaw ← salary_min && salary_max ? \`$${salary_min}-$${salary_max}\` : undefined`, `descriptionMd ← description`, `postedAt ← date`.
- **Arbeitnow**: GET `https://www.arbeitnow.com/api/job-board-api`. Response `{ data: [...] }`. Mapping: `externalId ← slug`, `url ← url`, `title ← title`, `companyName ← company_name`, `location ← location || undefined`, `remoteMode ← remote === true ? "remote" : "unknown"`, `descriptionMd ← description`, `postedAt ← new Date(created_at * 1000)` (unix seconds).
- Fixtures: one-time `curl -s https://remoteok.com/api > fixtures/remoteok.json` (trim to legal-notice element + ≤4 jobs) and `curl -s https://www.arbeitnow.com/api/job-board-api > fixtures/arbeitnow.json` (trim `data` to ≤4). If a live capture is blocked (403), hand-write the fixture matching the documented shape above and note it.

- [ ] **Step 1: Write the failing tests** — same fixture-driven pattern as `remotive.test.ts`, with these source-specific assertions:

```ts
// remoteok.test.ts — additional cases:
it("skips the leading legal-notice element", async () => {
  const jobs = await remoteokFetcher.fetch(ctx);
  expect(jobs.every((j) => j.title.length > 0)).toBe(true);
});
// arbeitnow.test.ts — additional cases:
it("maps unix created_at to postedAt and remote flag to remoteMode", async () => {
  const jobs = await arbeitnowFetcher.fetch(ctx);
  expect(jobs[0]?.postedAt).toBeInstanceOf(Date);
  expect(["remote", "unknown"]).toContain(jobs[0]?.remoteMode);
});
```
(Each test file builds `ctx` exactly as remotive.test.ts does, reading its own fixture; the standard assertions — correct `source`, non-empty externalId/url, malformed-item skip — are repeated per file.)

- [ ] **Step 2: Capture/author both fixtures.**
- [ ] **Step 3: Run to verify FAIL.**
- [ ] **Step 4: Implement both fetchers** following the mapping tables above, each mirroring the remotive fetcher's structure: cast raw item to `Record<string, unknown>`, build the candidate object, `normalizedJobSchema.safeParse`, push only successes. Export both from `index.ts`.
- [ ] **Step 5: Run to verify PASS.**
- [ ] **Step 6: Commit** — `feat(ingest): remoteok and arbeitnow fetchers`

---

### Task 6: Fetchers — We Work Remotely (RSS) and The Muse

**Files:**
- Create: `packages/ingest/src/fetchers/wwr.ts`, `packages/ingest/src/fetchers/themuse.ts`
- Create: `packages/ingest/fixtures/wwr.xml`, `packages/ingest/fixtures/themuse.json`
- Modify: `packages/ingest/src/index.ts`, `packages/ingest/package.json` (add dep `fast-xml-parser ^4.5.0`)
- Test: `packages/ingest/src/fetchers/wwr.test.ts`, `packages/ingest/src/fetchers/themuse.test.ts`

**Interfaces:**
- Produces: `wwrFetcher: JobFetcher` (source `"wwr"`), `themuseFetcher: JobFetcher` (source `"themuse"`).
- **WWR**: GET `https://weworkremotely.com/remote-jobs.rss` via `ctx.fetchText`, parse with `XMLParser` from fast-xml-parser. Items at `rss.channel.item[]`. WWR titles are `"Company: Role"` — split on the FIRST `": "`; if no separator, companyName `"Unknown"` and full title kept. Mapping: `externalId ← guid` text value (fast-xml-parser may give `{ "#text": ... }` — handle both string and object), `url ← link`, `descriptionMd ← description`, `remoteMode ← "remote"`, `postedAt ← pubDate`, `location ← region || undefined`.
- **The Muse**: GET `https://www.themuse.com/api/public/jobs?page=1` (single page per run is enough). Response `{ results: [...] }`. Mapping: `externalId ← String(id)`, `url ← refs.landing_page`, `title ← name`, `companyName ← company.name`, `location ← locations.map(l => l.name).join("; ") || undefined`, `remoteMode ← locations.some(l => /remote|flexible/i.test(l.name)) ? "remote" : "unknown"`, `descriptionMd ← contents`, `postedAt ← publication_date`.
- Fixtures: one-time curl each (trim to ≤4 items). XMLParser options: `{ ignoreAttributes: false }`.

- [ ] **Step 1: Write the failing tests** — fixture pattern; source-specific:
```ts
// wwr.test.ts:
it("splits 'Company: Role' titles", async () => {
  const jobs = await wwrFetcher.fetch(ctx);   // ctx.fetchText returns the xml fixture string
  expect(jobs[0]?.companyName).not.toContain(":");
  expect(jobs[0]?.title.length).toBeGreaterThan(0);
});
// themuse.test.ts:
it("joins multiple locations and detects remote", async () => {
  const jobs = await themuseFetcher.fetch(ctx);
  expect(jobs[0]?.externalId).toMatch(/^\d+$/);
});
```
- [ ] **Step 2: Capture/author fixtures.** `pnpm install` after adding fast-xml-parser; commit lockfile with this task.
- [ ] **Step 3: FAIL run.**
- [ ] **Step 4: Implement both** per mappings (wwr uses `ctx.fetchText` + XMLParser; themuse uses `ctx.fetchJson`); safeParse-and-skip per item; export from index.
- [ ] **Step 5: PASS run.**
- [ ] **Step 6: Commit** — `feat(ingest): wwr rss and themuse fetchers`

---

### Task 7: Fetcher — ATS board polling (Greenhouse, Lever, Ashby)

**Files:**
- Create: `packages/ingest/src/fetchers/ats-boards.ts`
- Create: `packages/ingest/fixtures/greenhouse.json`, `packages/ingest/fixtures/lever.json`, `packages/ingest/fixtures/ashby.json`
- Modify: `packages/ingest/src/index.ts`
- Test: `packages/ingest/src/fetchers/ats-boards.test.ts`

**Interfaces:**
- Consumes: `AtsType` from contracts.
- Produces (parameterized — the watchlist rows come from the db at call time, passed in by the worker):
```ts
export interface WatchlistEntry { atsType: AtsType; boardSlug: string; companyName: string }
export function makeAtsBoardsFetcher(watchlist: WatchlistEntry[]): JobFetcher; // source "ats_boards"
```
- Endpoints and mappings (per entry; failures on ONE board are caught, recorded by continuing — a broken slug must not kill the rest; collect per-board errors on the fetcher result? No — keep `JobFetcher` shape: log-and-skip, the run-level error accounting stays coarse in P2):
  - **greenhouse**: GET `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` → `{ jobs: [...] }`; `externalId ← \`gh-${id}\``, `url ← absolute_url`, `title ← title`, `companyName ← entry.companyName`, `location ← location?.name`, `descriptionMd ← content` (HTML, entity-decode via stripHtml only at hash time — store as-is), `postedAt ← updated_at`, `remoteMode ← /remote/i.test(location?.name ?? "") ? "remote" : "unknown"`.
  - **lever**: GET `https://api.lever.co/v0/postings/{slug}?mode=json` → array; `externalId ← \`lever-${id}\``, `url ← hostedUrl`, `title ← text`, `location ← categories?.location`, `descriptionMd ← descriptionPlain || description`, `postedAt ← new Date(createdAt)` (ms), `remoteMode ← /remote/i.test(String(workplaceType ?? categories?.location ?? "")) ? "remote" : "unknown"`.
  - **ashby**: GET `https://api.ashbyhq.com/posting-api/job-board/{slug}` → `{ jobs: [...] }`; `externalId ← \`ashby-${id}\``, `url ← jobUrl`, `title ← title`, `location ← location`, `descriptionMd ← descriptionHtml`, `remoteMode ← isRemote === true ? "remote" : "unknown"`, `postedAt ← publishedAt`.
- Fixtures: capture one real public board each (e.g. `boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true` trimmed to 2 jobs; a known Lever and Ashby public board similarly — any public slug works; trim hard, these responses are large).

- [ ] **Step 1: Write the failing tests** — build a fetcher over a 3-entry watchlist whose ctx.fetchJson dispatches by URL substring (`boards-api.greenhouse` → greenhouse fixture, `api.lever.co` → lever fixture, `api.ashbyhq.com` → ashby fixture); assert: all three sources' jobs appear, externalIds carry the `gh-`/`lever-`/`ashby-` prefixes (cross-ATS id-collision guard), companyName comes from the watchlist entry, and a fourth entry with a fetchJson that throws does not prevent the other three boards' jobs from returning.
- [ ] **Step 2: Capture/trim fixtures.**
- [ ] **Step 3: FAIL run.**
- [ ] **Step 4: Implement** `makeAtsBoardsFetcher` per the mapping tables (per-entry try/catch; safeParse-and-skip per item).
- [ ] **Step 5: PASS run; full ingest suite green.**
- [ ] **Step 6: Commit** — `feat(ingest): greenhouse/lever/ashby watchlist board fetcher`

---

### Task 8: DB — discovery repositories

**Files:**
- Create: `packages/db/src/repos/discovery.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/repos/discovery.test.ts` (integration, skipIf pattern with afterAll cleanup)

**Interfaces:**
- Consumes: `NormalizedJob`, `ScoringProfile`, `DEFAULT_SCORING_PROFILE` from contracts; `scoreJob` from core; `contentHashOf` from `@careerhq/ingest`?? — NO: `ingest` must stay out of `db`'s dependencies to keep boundaries one-directional. `contentHashOf` moves conceptually: **`db` receives the hash precomputed** — `upsertNormalizedJobs` takes `(job, contentHash)` pairs. The worker composes ingest+db.
- Produces:
```ts
export interface UpsertResult { inserted: number; updated: number; duplicates: number }
export async function upsertNormalizedJobs(
  db: Db, workspaceId: string,
  jobs: Array<{ job: NormalizedJob; contentHash: string }>,
): Promise<UpsertResult>;
export async function scoreInboxJobs(db: Db, workspaceId: string, profile: ScoringProfile): Promise<number>; // scores every non-expired inbox job, persists keyword_score + keyword_breakdown, returns count
export async function markExpiredJobs(db: Db, workspaceId: string, olderThanDays?: number): Promise<number>; // default EXPIRY_DAYS=21
export async function recordIngestRun(db: Db, run: NewIngestRun & { finishedAt: Date }): Promise<void>;
export async function listIngestRuns(db: Db, workspaceId: string, limit?: number): Promise<IngestRun[]>;
export async function listInboxJobs(db: Db, workspaceId: string): Promise<Job[]>;   // status inbox, not expired, not duplicates; ordered llm_score DESC NULLS LAST, keyword_score DESC
export async function countInboxDuplicates(db: Db, workspaceId: string): Promise<number>;
export async function applyRerank(db: Db, workspaceId: string, results: RerankResult["results"]): Promise<number>; // sets llm_score/llm_rationale/llm_red_flags for matching job ids in this workspace
export async function getScoringProfile(db: Db, workspaceId: string): Promise<ScoringProfile>;   // row or DEFAULT_SCORING_PROFILE (validated via scoringProfileSchema — bad stored json falls back to default)
export async function saveScoringProfile(db: Db, workspaceId: string, profile: ScoringProfile): Promise<void>; // upsert on workspace unique index
export async function listWatchlist(db: Db, workspaceId: string): Promise<WatchlistCompany[]>;
export async function addWatchlistEntry(db: Db, e: { workspaceId: string; companyName: string; atsType: AtsType; boardSlug: string }): Promise<WatchlistCompany>;
export async function removeWatchlistEntry(db: Db, id: string): Promise<void>;
export async function getOrCreateCompany(db: Db, workspaceId: string, name: string): Promise<string>; // returns company id; uses companies_workspace_name unique index (insert onConflictDoNothing + select)
```
- `upsertNormalizedJobs` semantics per job, in ONE transaction for the whole batch: `getOrCreateCompany`; insert with `onConflictDoUpdate` on `(workspace_id, source, external_id)` updating `last_seen_at: now, url, title, location_/salary/description, expired_at: null`; classify inserted-vs-updated via `xmax = 0` trick? — NO, keep it simple and portable: select existing id first, then insert or update explicitly (batch is ≤ a few hundred; N+1 acceptable at this scale). On fresh insert, check content-hash duplicate: another non-expired job in the workspace with the same `content_hash` and different `(source, external_id)` → set `duplicate_of_job_id` to the FIRST-SEEN one (`order by first_seen_at asc limit 1`), count as `duplicates` (still inserted).

- [ ] **Step 1: Write the failing integration tests** (same harness as facts.test.ts — fresh `t-${Date.now()}` workspace, afterAll delete + `$client.end()`):
```ts
const nj = (over: Partial<NormalizedJob> = {}): NormalizedJob => normalizedJobSchema.parse({
  source: "remotive", externalId: over.externalId ?? "r1", url: "https://x.example/j",
  title: "Full-Stack Engineer", companyName: "Acme", remoteMode: "remote",
  descriptionMd: "TypeScript and Node", ...over,
});

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
  const inbox = await listInboxJobs(db, workspaceId);
  expect(inbox).toHaveLength(1); // duplicate hidden from inbox
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
  const [job] = await listInboxJobs(db, workspaceId); // reuse a seeded row from an earlier test in this file... create one explicitly instead:
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
```
(Plus watchlist add/list/remove round-trip and `recordIngestRun`/`listIngestRuns` round-trip tests, asserting ordering by `startedAt desc` and the `limit` parameter.)

- [ ] **Step 2: FAIL run** (with TEST_DATABASE_URL).
- [ ] **Step 3: Implement** `packages/db/src/repos/discovery.ts` per the semantics above; `keyword_breakdown` stores the full `JobScore` object (breakdown + flags) as jsonb; `scoreInboxJobs` skips nothing — excluded/remote-filtered jobs get score 0 with reasons persisted (UI explains). Re-export from index.
- [ ] **Step 4: PASS run; full db suite green; build+lint.**
- [ ] **Step 5: Commit** — `feat(db): discovery repositories (upsert/dedup/expiry/scoring/rerank/watchlist/profile)`

---

### Task 9: AI package — chatJson client

**Files:**
- Create: `packages/ai/package.json`, `packages/ai/tsconfig.json`, `packages/ai/src/index.ts`, `packages/ai/src/client/chat-json.ts`
- Test: `packages/ai/src/client/chat-json.test.ts`

**Interfaces:**
- Produces:
```ts
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export interface ChatJsonRequest<T> {
  system: string; user: string;
  schema: z.ZodType<T>;
  model: string; apiKey: string;
  url?: string;                    // default OPENROUTER_URL
  timeoutMs?: number;              // default 30_000
  isUseful?: (value: T) => boolean;
  fetchImpl?: typeof fetch;        // injection point for tests
}
export interface ChatJsonResult<T> {
  ok: boolean; value: T | null;
  model: string; latencyMs: number;
  status: number | null;           // HTTP status when the call reached the server
  error: string | null;            // "timeout" | "http_<status>" | "no_json" | "schema_invalid" | "not_useful" | message
}
export async function chatJson<T>(req: ChatJsonRequest<T>): Promise<ChatJsonResult<T>>; // NEVER throws
export function extractJsonObject(text: string): unknown | null;  // exported for tests
```
- Behavior (the kelevoTMS pattern, reference file in Global Constraints): POST OpenAI-format body `{ model, messages: [{role:"system"},{role:"user"}], response_format: { type: "json_object" }, temperature: 0 }` with headers `Authorization: Bearer <key>`, `Content-Type: application/json`, `HTTP-Referer: https://github.com/careerhq`, `X-Title: CareerHQ`. AbortController timeout. Response content at `choices[0].message.content` may be: an object (some providers), a JSON string, or prose-wrapped JSON — `extractJsonObject` strips ``` fences then takes the substring from the first `{` to the last `}` and JSON.parses it (null on failure). Then `schema.safeParse`; then `isUseful` (a valid-but-useless value → `error: "not_useful"`). Every failure path returns a result object — the function never throws.

- [ ] **Step 1: Write the failing tests** (mocked fetch; no network):
```ts
const schema = z.object({ answer: z.string() });
const okFetch = (content: unknown): typeof fetch => (async () => new Response(JSON.stringify({
  choices: [{ message: { content } }],
}), { status: 200 })) as typeof fetch;
const base = { system: "s", user: "u", schema, model: "m", apiKey: "k" };

it("parses a plain JSON string content", async () => {
  const r = await chatJson({ ...base, fetchImpl: okFetch('{"answer":"hi"}') });
  expect(r.ok).toBe(true); expect(r.value?.answer).toBe("hi");
});
it("parses prose-wrapped and fenced JSON", async () => {
  const r = await chatJson({ ...base, fetchImpl: okFetch('Sure! ```json\n{"answer":"hi"}\n``` hope that helps') });
  expect(r.ok).toBe(true);
});
it("returns http_429 with status on rate limit, never throwing", async () => {
  const r = await chatJson({ ...base, fetchImpl: (async () => new Response("slow down", { status: 429 })) as typeof fetch });
  expect(r.ok).toBe(false); expect(r.status).toBe(429); expect(r.error).toBe("http_429");
});
it("schema mismatch → schema_invalid", async () => {
  const r = await chatJson({ ...base, fetchImpl: okFetch('{"wrong":"shape"}') });
  expect(r.error).toBe("schema_invalid");
});
it("isUseful=false → not_useful", async () => {
  const r = await chatJson({ ...base, isUseful: () => false, fetchImpl: okFetch('{"answer":"hi"}') });
  expect(r.error).toBe("not_useful");
});
it("timeout aborts and reports", async () => {
  const never: typeof fetch = ((_: unknown, init?: RequestInit) => new Promise((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
  })) as typeof fetch;
  const r = await chatJson({ ...base, timeoutMs: 20, fetchImpl: never });
  expect(r.ok).toBe(false); expect(r.error).toBe("timeout");
});
it("extractJsonObject returns null for no JSON", () => {
  expect(extractJsonObject("no json here")).toBeNull();
});
```
- [ ] **Step 2: Scaffold package** (name `@careerhq/ai`, deps `@careerhq/contracts workspace:*`, `@careerhq/core workspace:*`, `zod ^3.25.0`; contracts-package pattern; `pnpm install`, lockfile in commit). **FAIL run.**
- [ ] **Step 3: Implement** per the behavior block. **PASS run + build + lint.**
- [ ] **Step 4: Commit** — `feat(ai): openrouter chatJson client with tolerant extraction and never-throws contract`

---

### Task 10: AI — sequential fallback with cooldown; config env additions

**Files:**
- Create: `packages/ai/src/client/fallback.ts`
- Modify: `packages/ai/src/index.ts`, `packages/config/src/index.ts`
- Test: `packages/ai/src/client/fallback.test.ts`, `packages/config/src/index.test.ts` (append)

**Interfaces:**
- Produces (`@careerhq/ai`):
```ts
export interface FallbackAttempt { model: string; error: string | null; status: number | null; skippedCooldown?: boolean }
export interface FallbackOptions {
  models: string[]; apiKey: string; url?: string; timeoutMs?: number;
  cooldownMs?: number;             // default 5 * 60_000; applied to a model after http_429
  backoffBaseMs?: number;          // default 300; wait backoffBaseMs * 2^i + jitter(0..100) before trying model i>0 after a retryable failure
  fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>;  // injection for tests
  now?: () => number;              // injection for cooldown tests
}
export type FallbackResult<T> = ChatJsonResult<T> & { attempts: FallbackAttempt[] };
export async function chatJsonWithFallback<T>(
  req: Omit<ChatJsonRequest<T>, "model" | "apiKey" | "url" | "timeoutMs" | "fetchImpl">,
  opts: FallbackOptions,
): Promise<FallbackResult<T>>;
export function clearCooldowns(): void;  // test hook; module-level cooldown map keyed by model
```
- Semantics: try models in order; skip a model still cooling down (record `skippedCooldown`); on `ok` return immediately; on `http_429` set cooldown and continue; on `http_5xx`/`timeout` continue (no cooldown); on `schema_invalid`/`not_useful`/`no_json` continue (the next model may do better); after the list is exhausted return the LAST result with the full attempts array. All models cooling down → return `{ ok: false, error: "all_models_cooling_down", ... }`.
- Produces (`@careerhq/config` — appended env, all optional):
```ts
// AppConfig additions:
openrouterApiKey: string | null;          // OPENROUTER_API_KEY, default null → AI features off (deterministic floor)
aiFastModels: string[];                   // AI_FAST_MODELS comma-list, default ["google/gemini-2.0-flash-exp:free","meta-llama/llama-3.3-70b-instruct:free"]
ingestCron: string;                       // INGEST_CRON, default "0 */6 * * *"
```

- [ ] **Step 1: Write the failing tests** — fallback: sequences of mocked chatJson via `fetchImpl` returning [429, 200-valid] → second model wins, attempts length 2, first has `http_429`; cooldown: after a 429 for model A, an immediate second call (same module state, `now` injected) skips A with `skippedCooldown`; `clearCooldowns` resets; all-cooling → `all_models_cooling_down`; schema-invalid then valid → second model wins; sleep injected and called with a backoff > 0 for the second attempt. Config: defaults (no key → null, models default list, cron default), `AI_FAST_MODELS="a,b , c"` → `["a","b","c"]`.
- [ ] **Step 2: FAIL runs** (ai + config).
- [ ] **Step 3: Implement both.** Config parses `AI_FAST_MODELS` by splitting on commas and trimming, dropping empties.
- [ ] **Step 4: PASS runs + builds.**
- [ ] **Step 5: Commit** — `feat(ai,config): sequential model fallback with 429 cooldown and ai env config`

---

### Task 11: AI — rerank task

**Files:**
- Create: `packages/ai/src/tasks/rerank.ts`
- Modify: `packages/ai/src/index.ts`
- Test: `packages/ai/src/tasks/rerank.test.ts`

**Interfaces:**
- Consumes: `rerankResultSchema`, `RerankResult`, `ScoringProfile` from contracts; `chatJsonWithFallback`, `FallbackOptions` from Task 10.
- Produces:
```ts
export interface RerankJobInput {
  id: string; title: string; companyName: string;
  location: string | null; remoteMode: string | null;
  keywordScore: number | null; descriptionSnippet: string;  // caller pre-trims to ≤600 chars
}
export function buildRerankPrompt(jobs: RerankJobInput[], profile: ScoringProfile): { system: string; user: string };
export async function rerankJobs(
  jobs: RerankJobInput[], profile: ScoringProfile, opts: FallbackOptions,
): Promise<FallbackResult<RerankResult>>;
```
- Prompt requirements (test-asserted): system prompt states the model is ranking job listings for fit against a candidate profile, must return ONLY JSON matching `{"results":[{"jobId","score","rationale","redFlags"}]}`, must score 0–100, one entry per input job, `jobId` copied verbatim, rationale ≤ 25 words, redFlags only for concrete concerns (equity-only pay, agency spam, mismatched seniority). User prompt contains the profile's roles/stack/boost lists and a numbered job list with id/title/company/location/remote/keywordScore/snippet.
- `rerankJobs` calls `chatJsonWithFallback` with `schema: rerankResultSchema` and `isUseful: (r) => r.results.length > 0 && r.results.every(x => inputIds.has(x.jobId))` — a result referencing unknown jobIds is useless (model hallucinated ids).

- [ ] **Step 1: Write the failing tests** — prompt contains every job id and profile role (string assertions on `buildRerankPrompt` output); `rerankJobs` with a mocked fetch returning a valid result for the given ids → ok; returning ids NOT in the input → falls through to next model and, with a single-model list, ends `not_useful`.
- [ ] **Step 2: FAIL.** **Step 3: Implement.** **Step 4: PASS + build.**
- [ ] **Step 5: Commit** — `feat(ai): rerank task with grounded-id usefulness check`

---

### Task 12: Worker — scheduled ingestion pipeline (+ boundary rules update)

**Files:**
- Create: `apps/worker/src/jobs/ingest.ts`, `apps/worker/src/jobs/rerank.ts`
- Modify: `apps/worker/src/main.ts`, `apps/worker/package.json` (add deps `@careerhq/ingest`, `@careerhq/ai`, `@careerhq/contracts`, `@careerhq/core`), `.dependency-cruiser.cjs`
- Test: `apps/worker/src/jobs/ingest.test.ts` (integration, skipIf TEST_DATABASE_URL)

**Interfaces:**
- Consumes: everything from Tasks 4–11.
- Produces:
```ts
// ingest.ts
export const ALL_FETCHERS: JobFetcher[]; // remotive, remoteok, arbeitnow, wwr, themuse (ats_boards built per-run from watchlist)
export async function runIngestOnce(db: Db, workspaceId: string, opts?: {
  fetchers?: JobFetcher[];            // injection for tests
  fetchCtx?: FetchContext;            // injection for tests
}): Promise<{ runs: number; inserted: number; updated: number; duplicates: number; errors: number }>;
// rerank.ts
export async function runRerankOnce(db: Db, workspaceId: string, config: AppConfig): Promise<
  { status: "skipped_no_key" | "skipped_empty" | "ok" | "failed"; reranked: number }>;
```
- `runIngestOnce` per fetcher (sequential): record `startedAt`; `fetcher.fetch(ctx)` → pair each job with `contentHashOf(job)` → `upsertNormalizedJobs` → `recordIngestRun` with counts; a fetcher throwing records a run with `errors: [{message}]` and continues to the next source. After all sources: `markExpiredJobs`, then `scoreInboxJobs` with `getScoringProfile`. The ATS fetcher is appended when `listWatchlist` is non-empty (`makeAtsBoardsFetcher(watchlist)`).
- `runRerankOnce`: no `openrouterApiKey` → `skipped_no_key` (deterministic floor); select top `profile.topNForLlm` inbox jobs by keyword score with `meetsMinimums` true (read from stored breakdown jsonb) — none → `skipped_empty`; build `RerankJobInput[]` (snippet = stripHtml(description).slice(0,600)); `rerankJobs`; on ok → `applyRerank`; on failure → `failed` (keyword order stands, log one line, no retry — next cron pass tries again).
- `main.ts`: add queues `discovery.ingest` (scheduled with `config.ingestCron`) and `discovery.rerank` (enqueued by the ingest handler after a successful run, `singletonKey` to avoid pileup); handlers resolve the personal workspace via a small local helper (select personal workspace ordered by createdAt asc — same rule as web).
- `.dependency-cruiser.cjs`: extend `core-purity` to also forbid `packages/(ingest|ai)` from importing `db`/`apps`; add rule `ingest-and-ai-purity`: `from ^packages/(ingest|ai)` to `^(packages/db|apps)` severity error.

- [ ] **Step 1: Write the failing integration test** — `runIngestOnce` with two stub fetchers (one returning 2 valid jobs incl. a cross-source content-hash duplicate of the other's job, one throwing) against a throwaway workspace: expect inserted/duplicates counts, an `ingest_runs` row per fetcher with the failing one carrying `errors`, jobs scored (keywordScore not null) after the run. `runRerankOnce` with `openrouterApiKey: null` → `skipped_no_key`.
- [ ] **Step 2: FAIL.** **Step 3: Implement.** `pnpm install` for new workspace deps; depcruise negative check: temporarily add `import "@careerhq/db"` to `packages/ingest/src/index.ts` → error → revert (record both outputs).
- [ ] **Step 4: PASS + full repo lint/typecheck/depcruise/test.**
- [ ] **Step 5: Commit** — `feat(worker): scheduled discovery ingestion and rerank jobs with boundary rules`

---

### Task 13: Web — discovery inbox UI with promote/dismiss

**Files:**
- Create: `apps/web/src/app/(dashboard)/jobs/page.tsx`, `apps/web/src/app/(dashboard)/jobs/actions.ts`, `apps/web/src/app/(dashboard)/jobs/job-row.tsx` (client), `packages/db/src/repos/discovery.ts` (append `promoteJob`, `dismissJob`)
- Modify: `apps/web/src/app/layout.tsx` (nav "Discovery"), `packages/db/src/index.ts`
- Test: append to `packages/db/src/repos/discovery.test.ts`

**Interfaces:**
- Produces (db):
```ts
export async function promoteJob(db: Db, workspaceId: string, jobId: string): Promise<
  { ok: true; applicationId: string } | { ok: false; reason: string }>;
// Creates an application at DISCOVERED linked to THIS job row (company already exists via ingest),
// appends the creation event (trigger user, payload { promotedFrom: "discovery" }), sets jobs.status='promoted'.
// Refuses (ok:false) when the job is already promoted or already has an application.
export async function dismissJob(db: Db, workspaceId: string, jobId: string): Promise<void>; // status='dismissed'
```
- Page `/jobs` (server component, `force-dynamic`): header with inbox count + hidden-duplicates count (`countInboxDuplicates`); ranked list from `listInboxJobs` — each row: title, company, location/remote badge, keyword score, LLM score + rationale + red-flag chips when present, expandable score breakdown (`<details>` listing each breakdown term: kind, points, inTitle), link to the job URL (`rel="noopener noreferrer" target="_blank"`), Promote and Dismiss buttons.
- Actions follow the P1 pattern (zod uuid parse → getDb/getActiveWorkspace → repo → `revalidatePath("/jobs")`); promote's failure reason surfaces inline on the row (same mechanism as TransitionButtons); after successful promote show link "View application" via returned applicationId (client keeps last result state).
- Excluded/remote-filtered jobs (score 0 with reasons in stored breakdown) render in a collapsed "Filtered out" `<details>` section at the bottom with their reasons — never silently hidden (spec §5.4: re-rank/filtering annotates, never deletes).

- [ ] **Step 1: Write the failing db tests** — promote creates the application linked to the SAME job row (`application.jobId === jobId`), event payload notes discovery, job status flips, second promote refuses; dismiss flips status and removes the row from `listInboxJobs`.
- [ ] **Step 2: FAIL.** **Step 3: Implement db functions, actions, page, row component.**
- [ ] **Step 4: PASS db suite; manual verification** (this host): with the dev server up, seed a couple of jobs via a tsx snippet calling `upsertNormalizedJobs` + `scoreInboxJobs`, then curl `/jobs` grepping a title and `Promote`; promote via the repo and confirm the job appears on `/applications` board (curl grep). Typecheck+lint clean.
- [ ] **Step 5: Commit** — `feat(web,db): discovery inbox with promote-to-application and dismiss`

---

### Task 14: Web — scoring profile settings and watchlist UI

**Files:**
- Create: `apps/web/src/app/(dashboard)/settings/page.tsx`, `apps/web/src/app/(dashboard)/settings/actions.ts`, `apps/web/src/app/(dashboard)/settings/profile-form.tsx` (client), `apps/web/src/app/(dashboard)/settings/watchlist-form.tsx` (client)
- Modify: `apps/web/src/app/layout.tsx` (nav "Settings")

**Interfaces:**
- Consumes: `getScoringProfile`/`saveScoringProfile`/`listWatchlist`/`addWatchlistEntry`/`removeWatchlistEntry` (Task 8), `scoringProfileSchema`, `ATS_TYPES`.
- `/settings` (force-dynamic): two sections. **Scoring profile** — textareas for roles/stack/boost/exclude (one term per line; action splits on newlines, trims, drops empties), checkboxes requireRemote/includeUnknownRemote, number inputs minRoleHits/minStackHits/topNForLlm; save action validates the assembled object through `scoringProfileSchema` before `saveScoringProfile` (parse failure → inline error, not a crash). **ATS watchlist** — table of entries (company, ats type, slug, remove button) + add form (company name, `<select>` from `ATS_TYPES`, board slug with placeholder `e.g. stripe` and helper text showing the three URL patterns); duplicate `(atsType, boardSlug)` insert surfaces the unique-violation as "already on the watchlist" instead of a 500 (catch the pg unique error code `23505`).

- [ ] **Step 1: Implement** (form-heavy task; the db layer is already tested — UI verification is manual).
- [ ] **Step 2: Verify manually** — save a profile with 2 roles + 1 exclude; reload page shows them; run `scoreInboxJobs` via tsx and confirm `/jobs` scores changed accordingly; add a watchlist entry, re-add the same → friendly error; remove works. Typecheck + lint clean.
- [ ] **Step 3: Commit** — `feat(web): scoring profile and ats watchlist settings`

---

### Task 15: Web — pipeline health panel

**Files:**
- Create: `apps/web/src/app/(dashboard)/jobs/health.tsx` (server component fragment)
- Modify: `apps/web/src/app/(dashboard)/jobs/page.tsx` (render `<IngestHealth/>` in a collapsed `<details>` above the list)

**Interfaces:**
- Consumes: `listIngestRuns` (Task 8, limit 20).
- Renders a table: source, started (relative "2h ago" via a small `timeAgo` helper — extract the helper to `apps/web/src/lib/time.ts` and reuse), duration (finished−started, "—" when null), fetched/inserted/updated/duplicates, error badge with `<details>` showing the error messages. Empty state: "No ingestion runs yet — the worker runs on a schedule, or trigger one via the worker." (No manual-trigger button in P2 — the worker owns execution; note this is deliberate YAGNI.)

- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify manually** — after Task 12's integration test or a manual `runIngestOnce` tsx invocation against the dev DB, `/jobs` shows the runs table with counts and one error row. Typecheck + lint.
- [ ] **Step 3: Commit** — `feat(web): ingestion pipeline health panel`

---

### Task 16: ADR-0003, ADR-0006, README update, full verification

**Files:**
- Create: `docs/adr/0003-openrouter-sequential-fallback.md`, `docs/adr/0006-scraping-and-tos-boundaries.md`
- Modify: `README.md`

**Interfaces:**
- ADR-0003 (Context/Decision/Consequences, ~40 lines): OpenRouter chosen for one endpoint over free/cheap models; the kelevoTMS `chat-json` pattern ported (tolerant extraction, Zod, isUseful, never-throws) — credit the source; its parallel two-lane race router deliberately NOT ported: racing burns ~2× tokens for latency, wrong trade against rate-limited free tiers; sequential fallback + per-model 429 cooldown + deterministic floor instead; model lists as env config because free-model availability churns.
- ADR-0006 (~40 lines): discovery uses only keyless public APIs/feeds and public ATS board endpoints, polite UA + timeouts, no scraping of sites that prohibit it; LinkedIn/Indeed/Glassdoor/Google Jobs/ZipRecruiter live ONLY in the isolated opt-in restricted connector (spec §5.3, phase P7) — never in core; HN and BYO-key sources deferred; cite spec §5.1/§5.3/§19.
- README: move Discovery from "planned" to features (sources list, scoring, optional AI re-rank with deterministic floor, watchlist, health panel); document new env vars (`OPENROUTER_API_KEY` optional, `AI_FAST_MODELS`, `INGEST_CRON`); note `/jobs` and `/settings` routes.

- [ ] **Step 1: Write both ADRs + README changes.**
- [ ] **Step 2: Full-suite verification** — `pnpm lint && pnpm typecheck && pnpm depcruise && TEST_DATABASE_URL=postgres://careerhq:careerhq@localhost:5433/careerhq pnpm test`; paste tails in the report. Also run one REAL end-to-end smoke on this host (the only live-network step, deliberate): tsx script running `runIngestOnce` against the dev DB with the real Remotive fetcher only, then confirm `/jobs` renders real listings. If the network call fails (offline/blocked), note it and rely on fixtures — do not fail the task on external availability.
- [ ] **Step 3: Commit** — `docs: ADR-0003/0006, README discovery update`

---

## Final Verification (Definition of Done for P2)

1. `pnpm lint && pnpm typecheck && pnpm depcruise && TEST_DATABASE_URL=… pnpm test` all green; ingest/ai packages inside the boundary fence (negative depcruise test recorded).
2. Live smoke: one real `runIngestOnce` produces jobs in `/jobs` with keyword scores and breakdown chips; `ingest_runs` visible in the health panel; duplicates collapsed with a count.
3. With `OPENROUTER_API_KEY` unset, everything above works (deterministic floor); rerank reports `skipped_no_key`.
4. Promote moves a discovery job onto the P1 board linked to the same job row; dismiss hides it; both survive reload.
5. Scoring-profile edits change subsequent `scoreInboxJobs` output; watchlist entries feed the ATS fetcher on the next run.
6. No test performs a live network call (grep tests for `https://` fetches — fixtures only); ADRs committed; README current.
