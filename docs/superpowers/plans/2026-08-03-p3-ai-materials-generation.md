# CareerHQ P3 — Grounded AI Materials Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build spec v0.3 §7's grounded generation: deterministic fact selection → structured LLM generation → deterministic citation validation → NEEDS_FACTS blocking, with cover-letter/email drafting (streaming UX), provenance chips, the sensitive-question hard block, the reusable answer bank, and the AI record/replay layer — Phase P3 of `docs/roadmap.md`, plus the carried P2 backlog.

**Architecture:** All grounding *decisions* are pure functions in `packages/core/src/grounding/` (fact selection, sensitivity ruleset, citation/confidence validation — no IO, no LLM trust). `packages/ai` gains the `generate` task, the widen-only sensitive tie-break task, a record/replay wrapper, and an incremental streaming extractor. `packages/db` gains `generated_documents` + `application_answers` (schema v3) and their repos. `apps/web` orchestrates: server action/route loads facts → core selects → ai generates → core validates → persist draft or return NEEDS_FACTS; nothing unvalidated is ever persisted.

**Tech Stack:** no new runtime deps. Existing: Node 22, TS strict ESM, Drizzle/Postgres, Zod 3, Vitest 3, Next.js 15, pg-boss (untouched this phase).

## Global Constraints

- Generation contract (spec §7.2, normative): model receives the MINIMAL fact subset — never the full bank; output must be `{answer, factIds[], confidence, unsupportedClaims[], clarificationNeeded?}`; deterministic post-validation in `core` never trusts model self-report: every cited factId ⊆ provided subset; `unsupportedClaims ≠ []` OR confidence < `MIN_GENERATION_CONFIDENCE` (0.6) OR zero citations on a factual answer → status `NEEDS_FACTS`, nothing persisted.
- Sensitive questions (spec §7.2.5): authorization/visa/sponsorship, disability, demographics, criminal history, salary/compensation, availability/notice period, relocation, legal attestations are NEVER sent to generation. Ruleset is conservative keywords; LLM tie-break may only WIDEN the sensitive set (ruleset-sensitive is final; ruleset-normal + LLM-sensitive → sensitive; LLM failure → ruleset stands).
- Facts with `sensitivity: "sensitive"` and stale facts (`review_by` past, spec §7.1) NEVER enter generation input.
- AI-generated text is visibly marked as generated until the user approves it (spec §7.2.7). Approval states: `draft | approved | rejected`.
- Deterministic floor (spec §1.4): no `OPENROUTER_API_KEY` → generation buttons render a clear "AI not configured — write manually" state; manual document/answer entry always works.
- Model tiers as config data (spec §8): new `AI_WRITING_MODELS` env, default `["deepseek/deepseek-chat:free","meta-llama/llama-3.3-70b-instruct:free","google/gemini-2.0-flash-001"]`; tie-break uses the existing `fast` tier.
- Replay (spec §8): `AI_MODE` env `live | record | replay` (default `live`); fixtures keyed `(taskId, sha256(system+"\n"+user))` under `packages/ai/fixtures/replay/`; replay miss → never-throws failure result.
- Package boundaries unchanged and enforced: `core` → contracts only; `ai` → contracts+core, never db/apps.
- Repo conventions: TS strict, no `any`; ESM `.js` specifiers; established db test harness (skipIf TEST_DATABASE_URL, throwaway workspace, afterAll cleanup + `$client.end()`); this host's postgres `postgres://careerhq:careerhq@localhost:5433/careerhq`; P1 action conventions (zod → getDb/getActiveWorkspace → repo → revalidatePath, inline `{ok:false, reason}` errors); conventional commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; dep-adding commits include the lockfile.
- Carried P2 backlog (roadmap P3 note) is IN SCOPE: Task 3 burns it down.

---

### Task 1: Contracts — generation, document, and answer schemas

**Files:**
- Modify: `packages/contracts/src/index.ts` (append)
- Test: `packages/contracts/src/generation.test.ts`

**Interfaces:**
- Produces (appended to `@careerhq/contracts`):
```ts
export const DOCUMENT_KINDS = ["cover_letter", "email_body"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const documentKindSchema = z.enum(DOCUMENT_KINDS);

export const APPROVAL_STATES = ["draft", "approved", "rejected"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];
export const approvalStateSchema = z.enum(APPROVAL_STATES);

export const ANSWER_ORIGINS = ["deterministic", "ai", "user"] as const;
export type AnswerOrigin = (typeof ANSWER_ORIGINS)[number];
export const answerOriginSchema = z.enum(ANSWER_ORIGINS);

export const generationResultSchema = z.object({
  answer: z.string().min(1),
  factIds: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  unsupportedClaims: z.array(z.string()).default([]),
  clarificationNeeded: z.string().optional(),
});
export type GenerationResult = z.infer<typeof generationResultSchema>;

export const AI_MODES = ["live", "record", "replay"] as const;
export type AiMode = (typeof AI_MODES)[number];
```

- [ ] **Step 1: Write the failing test**

`packages/contracts/src/generation.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  APPROVAL_STATES, DOCUMENT_KINDS, generationResultSchema,
} from "./index.js";

describe("generation contracts (spec §7.2)", () => {
  it("generation result requires answer and bounds confidence to 0..1", () => {
    expect(generationResultSchema.safeParse({ answer: "", confidence: 0.9 }).success).toBe(false);
    expect(generationResultSchema.safeParse({ answer: "x", confidence: 1.2 }).success).toBe(false);
    const ok = generationResultSchema.parse({ answer: "x", confidence: 0.8 });
    expect(ok.factIds).toEqual([]);
    expect(ok.unsupportedClaims).toEqual([]);
  });
  it("document kinds and approval states are exact", () => {
    expect(DOCUMENT_KINDS).toEqual(["cover_letter", "email_body"]);
    expect(APPROVAL_STATES).toEqual(["draft", "approved", "rejected"]);
  });
});
```

- [ ] **Step 2: FAIL run** — `pnpm --filter @careerhq/contracts test`.
- [ ] **Step 3: Implement** — append the Interfaces block verbatim.
- [ ] **Step 4: PASS run + build.**
- [ ] **Step 5: Commit** — `feat(contracts): generation, document and answer-bank schemas`

---

### Task 2: DB schema v3 — generated_documents, application_answers, jobs salary/posted columns

**Files:**
- Modify: `packages/db/src/schema/index.ts`, `packages/db/src/index.ts`, `packages/db/src/repos/discovery.ts` (persist the new jobs columns)
- Create (generated): `packages/db/migrations/0002_*.sql`
- Test: extend `packages/db/src/repos/discovery.test.ts` (salary/posted persistence)

**Interfaces:**
- Produces: tables + inferred types `GeneratedDocument`/`NewGeneratedDocument`, `ApplicationAnswer`/`NewApplicationAnswer`; `jobs` gains `salary_raw text`, `posted_at timestamptz` (carried P2 backlog L2) and `upsertNormalizedJobs` now writes both on insert AND update.
```ts
export const documentKind = pgEnum("document_kind", DOCUMENT_KINDS);
export const approvalState = pgEnum("approval_state", APPROVAL_STATES);
export const answerOrigin = pgEnum("answer_origin", ANSWER_ORIGINS);

export const generatedDocuments = pgTable("generated_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
  kind: documentKind("kind").notNull(),
  contentMd: text("content_md").notNull(),
  sourceFactIds: uuid("source_fact_ids").array().notNull().default(sql`'{}'::uuid[]`),
  model: text("model"),
  origin: answerOrigin("origin").notNull().default("ai"),
  approval: approvalState("approval").notNull().default("draft"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("generated_documents_application").on(t.applicationId, t.createdAt)]);

export const applicationAnswers = pgTable("application_answers", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
  questionRaw: text("question_raw").notNull(),
  questionNorm: text("question_norm").notNull(),
  answer: text("answer").notNull(),
  origin: answerOrigin("origin").notNull(),
  sourceFactIds: uuid("source_fact_ids").array().notNull().default(sql`'{}'::uuid[]`),
  confidence: real("confidence"),
  sensitivity: sensitivity("sensitivity").notNull().default("normal"),
  approval: approvalState("approval").notNull().default("draft"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  reusable: boolean("reusable").notNull().default(false),
  reviewBy: timestamp("review_by", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("application_answers_application").on(t.applicationId, t.createdAt),
  index("application_answers_reusable").on(t.reusable, t.questionNorm),
]);
```
(`boolean` needs adding to the pg-core import; `sensitivity` pgEnum exists from P1.)

- [ ] **Step 1: Write the failing test additions** — extend discovery.test.ts:
```ts
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
```
- [ ] **Step 2: FAIL run** (with TEST_DATABASE_URL on 5433).
- [ ] **Step 3: Implement** — schema additions above + jobs columns + upsert writes; `pnpm --filter @careerhq/db db:generate`; READ the migration and quote in the report: 3 CREATE TYPE, 2 CREATE TABLE, 2 ALTER TABLE jobs ADD COLUMN; apply with db:migrate on 5433 (existing data survives).
- [ ] **Step 4: PASS run + full db suite + typecheck + lint.**
- [ ] **Step 5: Commit** — `feat(db): schema v3 — generated documents, application answers, job salary/posted columns`

---

### Task 3: P2 backlog burn-down

**Files:**
- Modify: `packages/db/src/repos/discovery.ts`, `packages/db/src/repos/applications.ts`, `apps/web/src/app/(dashboard)/jobs/job-row.tsx`
- Create: `packages/db/src/repos/companies.ts`
- Test: extend `packages/db/src/repos/discovery.test.ts`

**Interfaces:**
- Produces:
  - `packages/db/src/repos/companies.ts` exports `getOrCreateCompany(db: DbOrTx, workspaceId: string, name: string): Promise<string>` — MOVED from discovery.ts (discovery.ts and applications.ts both import from the new module; old export re-exported from discovery.ts is NOT kept — update all imports; `packages/db/src/index.ts` re-exports the new module).
  - `applyRerank` change: after applying the batch, clears `llm_score/llm_rationale/llm_red_flags` (set null) for all OTHER inbox jobs of the workspace not in the applied batch — stale reranks stop dominating `listInboxJobs` ordering.
  - `listInboxJobs` change: a job with `duplicate_of_job_id` set is INCLUDED when its canonical job is expired or dismissed (canonical no longer visible) — join/exists subquery on the canonical row's status/expired_at.
  - `job-row.tsx`: when `job.url` is null render a plain `<span>` (no dead `#` link).

- [ ] **Step 1: Write the failing tests** — extend discovery.test.ts:
```ts
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
```
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: Implement** all four changes (companies.ts move updates the H1-era imports; run full db suite to prove nothing broke).
- [ ] **Step 4: PASS + full repo lint/typecheck/depcruise/test.**
- [ ] **Step 5: Commit** — `fix(db,web): P2 backlog — stale rerank clearing, orphaned duplicates, companies repo, dead link`

---

### Task 4: Core grounding — sensitive-question ruleset

**Files:**
- Create: `packages/core/src/grounding/sensitive.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/grounding/sensitive.test.ts`

**Interfaces:**
- Produces:
```ts
export interface SensitivityRuling { sensitive: boolean; matchedTerms: string[] }
export function classifyQuestionSensitivity(question: string): SensitivityRuling;
export function mergeSensitivityRulings(ruleset: SensitivityRuling, llmSaysSensitive: boolean | null): boolean;
// widen-only: ruleset.sensitive → true (final); !ruleset.sensitive && llmSaysSensitive === true → true; llm null/false → ruleset stands
```
- Keyword ruleset (case-insensitive substring groups, spec §7.2.5 categories): work authorization (`authorized to work, work authorization, visa, sponsorship, citizen, citizenship, right to work`), disability (`disability, disabled, accommodation`), demographics (`gender, race, ethnicity, veteran, sexual orientation, pronouns, date of birth, age`), criminal (`criminal, felony, convicted, background check`), compensation (`salary, compensation, pay expectation, rate, desired pay`), availability (`notice period, start date, availability, available to start`), relocation (`relocate, relocation, willing to move`), attestations (`certify, attest, acknowledge, agree to the terms, legal name, signature`).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { classifyQuestionSensitivity, mergeSensitivityRulings } from "./sensitive.js";

describe("sensitive-question ruleset (spec §7.2.5)", () => {
  it.each([
    ["Are you authorized to work in the US?", "authorized to work"],
    ["Do you require visa sponsorship?", "sponsorship"],
    ["What are your salary expectations?", "salary"],
    ["What is your notice period?", "notice period"],
    ["Are you willing to relocate?", "relocate"],
    ["Have you ever been convicted of a felony?", "felony"],
    ["Do you have a disability?", "disability"],
    ["I certify the above is true", "certify"],
  ])("flags %s", (q, term) => {
    const r = classifyQuestionSensitivity(q);
    expect(r.sensitive).toBe(true);
    expect(r.matchedTerms.join(" ")).toContain(term);
  });
  it("does not flag ordinary role questions", () => {
    expect(classifyQuestionSensitivity("Why do you want to work at Acme?").sensitive).toBe(false);
    expect(classifyQuestionSensitivity("Describe a TypeScript project you led.").sensitive).toBe(false);
  });
  it("merge is widen-only", () => {
    const flagged = { sensitive: true, matchedTerms: ["salary"] };
    const clean = { sensitive: false, matchedTerms: [] };
    expect(mergeSensitivityRulings(flagged, false)).toBe(true);  // LLM can never narrow
    expect(mergeSensitivityRulings(clean, true)).toBe(true);     // LLM may widen
    expect(mergeSensitivityRulings(clean, null)).toBe(false);    // LLM failure → ruleset stands
    expect(mergeSensitivityRulings(clean, false)).toBe(false);
  });
});
```
- [ ] **Step 2: FAIL.** **Step 3: Implement** (term groups as a flat `SENSITIVE_TERMS: string[]` constant; matcher lowercases the question and collects all matching terms). **Step 4: PASS + full core suite.**
- [ ] **Step 5: Commit** — `feat(core): sensitive-question keyword ruleset with widen-only merge`

---

### Task 5: Core grounding — deterministic fact selection + question normalization

**Files:**
- Create: `packages/core/src/grounding/select-facts.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/grounding/select-facts.test.ts`

**Interfaces:**
- Produces:
```ts
export interface FactForSelection {
  id: string; category: FactCategory; claim: string; detail: string | null;
  sensitivity: Sensitivity; stale: boolean;
}
export interface SelectionContext { question?: string; jobTitle: string; jobDescription?: string | null }
export const MAX_GENERATION_FACTS = 12;
export function selectFactsForGeneration(
  facts: FactForSelection[], context: SelectionContext, opts?: { maxFacts?: number },
): FactForSelection[];
export function normalizeQuestion(question: string): string; // lowercase, strip punctuation, collapse whitespace
```
- Selection rules (deterministic, test-pinned): HARD-exclude `sensitivity === "sensitive"` and `stale === true`; score each remaining fact = count of distinct words (length ≥ 4, lowercased) shared between `claim + detail` and `question + jobTitle + jobDescription`; `experience` and `skill` categories get +1 baseline (always relevant to materials); sort score DESC then category order (FACT_CATEGORIES array order) then claim ASC (stable); take top `maxFacts` (default 12); facts with score 0 AND no baseline are dropped even if the cap isn't reached.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { normalizeQuestion, selectFactsForGeneration, type FactForSelection } from "./select-facts.js";

const fact = (over: Partial<FactForSelection>): FactForSelection => ({
  id: over.id ?? "f1", category: over.category ?? "skill", claim: over.claim ?? "TypeScript",
  detail: over.detail ?? null, sensitivity: over.sensitivity ?? "normal", stale: over.stale ?? false,
});
const ctx = { jobTitle: "Senior TypeScript Engineer", jobDescription: "Node, Postgres, logistics platform" };

describe("selectFactsForGeneration (spec §7.2.1)", () => {
  it("hard-excludes sensitive and stale facts regardless of relevance", () => {
    const facts = [
      fact({ id: "s", claim: "TypeScript expert", sensitivity: "sensitive" }),
      fact({ id: "t", claim: "TypeScript expert", stale: true }),
      fact({ id: "ok", claim: "TypeScript expert" }),
    ];
    const out = selectFactsForGeneration(facts, ctx);
    expect(out.map((f) => f.id)).toEqual(["ok"]);
  });
  it("ranks by term overlap with the context", () => {
    const facts = [
      fact({ id: "lo", category: "preference", claim: "Enjoys hiking" }),
      fact({ id: "hi", category: "preference", claim: "Built logistics platform with Postgres" }),
    ];
    const out = selectFactsForGeneration(facts, ctx);
    expect(out[0]?.id).toBe("hi");
    expect(out.find((f) => f.id === "lo")).toBeUndefined(); // zero overlap, no baseline → dropped
  });
  it("experience and skill facts survive with zero overlap (baseline)", () => {
    const out = selectFactsForGeneration([fact({ id: "e", category: "experience", claim: "Led a team of four" })], ctx);
    expect(out.map((f) => f.id)).toEqual(["e"]);
  });
  it("caps at maxFacts deterministically", () => {
    const many = Array.from({ length: 20 }, (_, i) => fact({ id: `f${i}`, claim: `TypeScript item ${i}` }));
    const a = selectFactsForGeneration(many, ctx);
    const b = selectFactsForGeneration([...many].reverse(), ctx);
    expect(a).toHaveLength(12);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id)); // input order must not matter
  });
});
describe("normalizeQuestion", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeQuestion("  Why   do you want THIS job?! ")).toBe("why do you want this job");
  });
});
```
- [ ] **Step 2: FAIL.** **Step 3: Implement per the selection rules.** **Step 4: PASS + full core suite.**
- [ ] **Step 5: Commit** — `feat(core): deterministic fact selection and question normalization`

---

### Task 6: Core grounding — citation and confidence validation

**Files:**
- Create: `packages/core/src/grounding/validate.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/grounding/validate.test.ts`

**Interfaces:**
- Produces:
```ts
export const MIN_GENERATION_CONFIDENCE = 0.6;
export type GenerationValidation =
  | { ok: true }
  | { ok: false; status: "needs_facts"; reasons: string[] };
export function validateGeneration(
  result: GenerationResult, providedFactIds: readonly string[],
): GenerationValidation;
```
- Rules (each failing rule appends a human-readable reason; all are checked, not short-circuited): cited factId not in provided subset → `"cites unknown fact <id>"`; `factIds` empty → `"no supporting facts cited"`; `unsupportedClaims` non-empty → `"model reported unsupported claims: <list>"`; `confidence < MIN_GENERATION_CONFIDENCE` → `"confidence <x> below threshold 0.6"`; `clarificationNeeded` present → `"model requests clarification: <text>"`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { MIN_GENERATION_CONFIDENCE, validateGeneration } from "./validate.js";

const base = { answer: "I built X", factIds: ["a"], confidence: 0.9, unsupportedClaims: [] as string[] };

describe("validateGeneration (spec §7.2.3-4)", () => {
  it("passes a fully grounded result", () => {
    expect(validateGeneration(base, ["a", "b"])).toEqual({ ok: true });
  });
  it("rejects citations outside the provided subset (never trusts the model)", () => {
    const v = validateGeneration({ ...base, factIds: ["a", "z"] }, ["a"]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons.join(" ")).toContain("unknown fact z");
  });
  it("rejects zero citations", () => {
    const v = validateGeneration({ ...base, factIds: [] }, ["a"]);
    expect(v.ok).toBe(false);
  });
  it("rejects unsupported claims and low confidence, collecting ALL reasons", () => {
    const v = validateGeneration(
      { ...base, unsupportedClaims: ["invented award"], confidence: 0.3 }, ["a"],
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reasons).toHaveLength(2);
      expect(v.status).toBe("needs_facts");
    }
  });
  it("rejects when clarification is requested", () => {
    const v = validateGeneration({ ...base, clarificationNeeded: "which project?" }, ["a"]);
    expect(v.ok).toBe(false);
  });
  it("threshold is exactly 0.6 inclusive", () => {
    expect(validateGeneration({ ...base, confidence: MIN_GENERATION_CONFIDENCE }, ["a"]).ok).toBe(true);
    expect(validateGeneration({ ...base, confidence: 0.59 }, ["a"]).ok).toBe(false);
  });
});
```
- [ ] **Step 2: FAIL.** **Step 3: Implement.** **Step 4: PASS + full core suite.**
- [ ] **Step 5: Commit** — `feat(core): generation citation/confidence validation with needs_facts status`

---

### Task 7: AI — generate task and sensitive tie-break task

**Files:**
- Create: `packages/ai/src/tasks/generate.ts`, `packages/ai/src/tasks/classify-sensitive.ts`
- Modify: `packages/ai/src/index.ts`
- Test: `packages/ai/src/tasks/generate.test.ts`, `packages/ai/src/tasks/classify-sensitive.test.ts`

**Interfaces:**
- Consumes: `chatJsonWithFallback`, `FallbackOptions`, `FallbackResult` (P2 Task 10); `generationResultSchema`, `GenerationResult` (Task 1).
- Produces:
```ts
// generate.ts
export interface GenerateInput {
  kind: DocumentKind | "question";
  question?: string;                       // required when kind === "question"
  job: { title: string; companyName: string; descriptionSnippet: string }; // caller pre-trims snippet ≤800 chars
  facts: Array<{ id: string; claim: string; detail: string | null }>;
}
export function buildGeneratePrompt(input: GenerateInput): { system: string; user: string };
export async function generateGrounded(
  input: GenerateInput, opts: FallbackOptions,
): Promise<FallbackResult<GenerationResult>>;
// classify-sensitive.ts
export async function classifySensitiveLlm(question: string, opts: FallbackOptions): Promise<boolean | null>;
// null on any failure — the caller's ruleset stands (widen-only floor)
```
- Prompt requirements (test-asserted): system — the model writes application materials grounded EXCLUSIVELY in the numbered facts provided; it must not invent employers, projects, metrics, dates, or qualifications; output ONLY JSON `{"answer","factIds","confidence","unsupportedClaims","clarificationNeeded"}`; `factIds` must list the ids of every fact actually used; any claim in the answer not backed by a provided fact must be listed in `unsupportedClaims`; if the facts are insufficient, set low confidence and explain in `clarificationNeeded` rather than inventing. Kind-specific instruction: cover_letter → 3 short paragraphs, professional, no salutation placeholders like "[Hiring Manager]" unless a name is known; email_body → ≤150 words, direct; question → answer the question directly. User — job title/company/snippet, the question when present, and the numbered fact list `[id] claim — detail`.
- `generateGrounded` guards: `facts.length === 0` → immediate `{ok:false, error:"no_facts_provided", ...}` result WITHOUT calling the LLM (never burn models on an unwinnable call — same lesson as rerank's empty-input); `isUseful`: `factIds ⊆ input fact ids` (a result citing unknown ids is useless — grounded-id check, mirror of rerank).
- `classifySensitiveLlm`: fast-tier call with schema `z.object({ sensitive: z.boolean() })`, system prompt asking whether answering the question requires personal/legal/compensation/availability/demographic information; returns `result.ok ? result.value.sensitive : null`.

- [ ] **Step 1: Write the failing tests** — prompt assertions (every fact id present, kind instruction present, anti-invention instruction present); `generateGrounded` with mocked fetch returning valid grounded JSON → ok; returning out-of-subset factIds with single-model list → `not_useful`; empty facts → `no_facts_provided` with zero fetch calls (assert the mock was never invoked); `classifySensitiveLlm` ok-true, ok-false, and failure → null.
- [ ] **Step 2: FAIL.** **Step 3: Implement.** **Step 4: PASS + full ai suite + build + lint.**
- [ ] **Step 5: Commit** — `feat(ai): grounded generate task and sensitive tie-break with no-facts guard`

---

### Task 8: AI — record/replay layer

**Files:**
- Create: `packages/ai/src/replay/index.ts`, `packages/ai/fixtures/replay/.gitkeep`
- Modify: `packages/ai/src/index.ts`, `packages/config/src/index.ts` (+ test append)
- Test: `packages/ai/src/replay/replay.test.ts`

**Interfaces:**
- Produces (`@careerhq/ai`):
```ts
export interface ReplayStore {                       // fs-backed default, injectable for tests
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}
export function makeFsReplayStore(dir: string): ReplayStore;
export function replayKey(taskId: string, prompt: { system: string; user: string }): string; // `${taskId}-${sha256(system+"\n"+user).slice(0,16)}`
export async function withReplay<T>(args: {
  mode: AiMode; store: ReplayStore; taskId: string;
  prompt: { system: string; user: string };
  run: () => Promise<FallbackResult<T>>;
}): Promise<FallbackResult<T>>;
```
- Semantics: `live` → just `run()`; `record` → `run()`, and when `ok` persist `JSON.stringify({value, model})` under the key (failures not recorded); `replay` → read key; hit → `{ok:true, value, model: "replay:"+model, latencyMs:0, status:null, error:null, attempts:[]}`; miss → `{ok:false, error:"replay_miss", ...}` never throwing, never calling `run()`.
- Produces (`@careerhq/config`): `aiMode: AiMode` (env `AI_MODE`, default `"live"`, zod-validated against AI_MODES) and `aiWritingModels: string[]` (env `AI_WRITING_MODELS`, same comma parsing + empty-falls-back-to-default as aiFastModels; default `["deepseek/deepseek-chat:free","meta-llama/llama-3.3-70b-instruct:free","google/gemini-2.0-flash-001"]`).

- [ ] **Step 1: Write the failing tests** — in-memory ReplayStore stub; record mode writes only on ok; replay hit returns stored value with `replay:` model prefix and never calls run (spy); replay miss → `replay_miss`; live passes through; `replayKey` stable and distinct per prompt; config: AI_MODE default live, invalid value throws, AI_WRITING_MODELS default + empty-string fallback.
- [ ] **Step 2: FAIL (ai + config).** **Step 3: Implement.** **Step 4: PASS + builds.**
- [ ] **Step 5: Commit** — `feat(ai,config): record/replay layer and writing-tier/ai-mode config`

---

### Task 9: AI — streaming answer extractor and stream client

**Files:**
- Create: `packages/ai/src/client/stream.ts`
- Modify: `packages/ai/src/index.ts`
- Test: `packages/ai/src/client/stream.test.ts`

**Interfaces:**
- Produces:
```ts
export function extractAnswerPrefix(partialJson: string): string;
// Best-effort: finds `"answer"` key in a PARTIAL JSON string and returns the decoded string-value
// prefix accumulated so far (handles \" \\ \n escapes; returns "" before the key/value starts;
// stops at the closing unescaped quote). Pure, heavily unit-tested — this is the streaming UX core.
export interface StreamCallbacks { onAnswerDelta: (answerSoFar: string) => void }
export async function streamChatJson<T>(
  req: ChatJsonRequest<T>, cb: StreamCallbacks,
): Promise<ChatJsonResult<T>>;
// Single-model streaming variant: POST with stream:true, parse SSE "data:" lines, accumulate
// choices[0].delta.content, call cb.onAnswerDelta(extractAnswerPrefix(accumulated)) on each chunk
// (only when the prefix grew), then validate the COMPLETE accumulated text exactly like chatJson
// (extractJsonObject → schema → isUseful). Same never-throws contract and error taxonomy.
```
- The web layer (Task 12) tries `streamChatJson` with the FIRST writing model only; on failure it falls back to the non-streaming `generateGrounded` full chain. Streaming is UX sugar — correctness always comes from the final validation.

- [ ] **Step 1: Write the failing tests**

```ts
describe("extractAnswerPrefix", () => {
  it("returns empty before the answer value opens", () => {
    expect(extractAnswerPrefix('{"ans')).toBe("");
    expect(extractAnswerPrefix('{"answer": ')).toBe("");
  });
  it("returns the growing prefix of the answer string", () => {
    expect(extractAnswerPrefix('{"answer": "Dear')).toBe("Dear");
    expect(extractAnswerPrefix('{"answer": "Dear team, I')).toBe("Dear team, I");
  });
  it("decodes escapes and stops at the closing quote", () => {
    expect(extractAnswerPrefix('{"answer": "line1\\nline2\\" q", "factIds"')).toBe('line1\nline2" q');
  });
  it("ignores an answer-like key inside another string", () => {
    expect(extractAnswerPrefix('{"note": "the \\"answer\\" is", "answer": "real')).toBe("real");
  });
});
describe("streamChatJson", () => {
  it("emits growing answer deltas and validates the final JSON", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"{\\"answer\\": \\"He"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"llo\\", \\"factIds\\": [\\"a\\"], \\"confidence\\": 0.9, \\"unsupportedClaims\\": []}"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const fetchImpl = (async () => new Response(
      new ReadableStream({
        start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch)); c.close(); },
      }), { status: 200 },
    )) as typeof fetch;
    const seen: string[] = [];
    const r = await streamChatJson(
      { system: "s", user: "u", schema: generationResultSchema, model: "m", apiKey: "k", fetchImpl },
      { onAnswerDelta: (a) => seen.push(a) },
    );
    expect(r.ok).toBe(true);
    expect(seen.at(-1)).toBe("Hello");
    expect(seen.length).toBeGreaterThan(0);
  });
  it("http error → never throws, taxonomy result", async () => {
    const r = await streamChatJson(
      { system: "s", user: "u", schema: generationResultSchema, model: "m", apiKey: "k",
        fetchImpl: (async () => new Response("nope", { status: 429 })) as typeof fetch },
      { onAnswerDelta: () => {} },
    );
    expect(r.ok).toBe(false); expect(r.error).toBe("http_429");
  });
});
```
- [ ] **Step 2: FAIL.** **Step 3: Implement** (`extractAnswerPrefix` as a small state machine: scan for `"answer"` key at object top level tracking in-string/escape state, then decode the value prefix; `streamChatJson` reads `response.body` via `getReader()`, splits on newlines, accumulates `delta.content`). **Step 4: PASS + full ai suite.**
- [ ] **Step 5: Commit** — `feat(ai): streaming client with incremental answer extraction`

---

### Task 10: DB — documents and answers repositories

**Files:**
- Create: `packages/db/src/repos/documents.ts`, `packages/db/src/repos/answers.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/repos/documents.test.ts`, `packages/db/src/repos/answers.test.ts`

**Interfaces:**
- Produces:
```ts
// documents.ts
export async function createDocument(db: Db, input: {
  applicationId: string; kind: DocumentKind; contentMd: string;
  sourceFactIds: string[]; model?: string | null; origin?: AnswerOrigin; // default "ai"
}): Promise<GeneratedDocument>;   // approval always starts "draft"
export async function setDocumentApproval(db: Db, id: string, approval: ApprovalState): Promise<GeneratedDocument | null>; // sets approvedAt when "approved", clears otherwise
export async function listDocuments(db: Db, applicationId: string): Promise<GeneratedDocument[]>; // createdAt DESC
// answers.ts
export async function createAnswer(db: Db, input: {
  applicationId: string; questionRaw: string; answer: string; origin: AnswerOrigin;
  sourceFactIds?: string[]; confidence?: number | null; sensitivity?: Sensitivity;
}): Promise<ApplicationAnswer>;   // questionNorm computed via normalizeQuestion (from @careerhq/core); approval "draft"
export async function approveAnswer(db: Db, id: string, opts: { reusable: boolean; reviewBy?: Date }): Promise<ApplicationAnswer | null>;
// approval "approved", approvedAt now; reusable requires sourceFactIds retained; reviewBy default now + 12 months when reusable
export async function rejectAnswer(db: Db, id: string): Promise<void>;
export async function listAnswers(db: Db, applicationId: string): Promise<ApplicationAnswer[]>;
export async function listReusableAnswers(db: Db, workspaceId: string): Promise<Array<ApplicationAnswer & { staleForReuse: boolean }>>;
// joins applications for workspace scope; approved + reusable only; staleForReuse = reviewBy != null && reviewBy < now (spec §7.2.6)
```

- [ ] **Step 1: Write the failing tests** (established harness; create a workspace + one application via `createApplication` in beforeAll):
```ts
// documents.test.ts
it("creates a draft and approves it with timestamp", async () => {
  const doc = await createDocument(db, { applicationId, kind: "cover_letter", contentMd: "Dear team", sourceFactIds: [] });
  expect(doc.approval).toBe("draft");
  const approved = await setDocumentApproval(db, doc.id, "approved");
  expect(approved?.approvedAt).toBeInstanceOf(Date);
  const rejected = await setDocumentApproval(db, doc.id, "rejected");
  expect(rejected?.approvedAt).toBeNull();
});
// answers.test.ts
it("normalizes the question and starts as draft", async () => {
  const a = await createAnswer(db, { applicationId, questionRaw: "Why THIS job?!", answer: "Because.", origin: "user" });
  expect(a.questionNorm).toBe("why this job");
  expect(a.approval).toBe("draft");
});
it("approve with reusable sets reviewBy and surfaces in the workspace bank; stale flagged", async () => {
  const a = await createAnswer(db, { applicationId, questionRaw: "Notice period?", answer: "Two weeks", origin: "user" });
  await approveAnswer(db, a.id, { reusable: true, reviewBy: new Date(Date.now() - 86400_000) });
  const bank = await listReusableAnswers(db, workspaceId);
  const row = bank.find((r) => r.id === a.id);
  expect(row?.staleForReuse).toBe(true);
});
it("non-reusable approvals do not enter the bank", async () => {
  const a = await createAnswer(db, { applicationId, questionRaw: "One-off?", answer: "Yes", origin: "ai" });
  await approveAnswer(db, a.id, { reusable: false });
  expect((await listReusableAnswers(db, workspaceId)).find((r) => r.id === a.id)).toBeUndefined();
});
```
- [ ] **Step 2: FAIL.** **Step 3: Implement** (note: `core` is already a db dependency; `normalizeQuestion` import is legal). **Step 4: PASS + full db suite.**
- [ ] **Step 5: Commit** — `feat(db): generated-document and answer-bank repositories`

---

### Task 11: Web — generation service (orchestration, non-streaming path)

**Files:**
- Create: `apps/web/src/lib/generation.ts`
- Test: `apps/web/src/lib/generation.test.ts` (unit — db and ai injected)

**Interfaces:**
- Consumes: everything from Tasks 4–10.
- Produces (the single orchestration function both the action and the stream route call):
```ts
export type GenerationOutcome =
  | { status: "ok"; documentId?: string; answerId?: string; answer: string; factIds: string[]; model: string | null }
  | { status: "needs_facts"; reasons: string[] }
  | { status: "sensitive_blocked"; matchedTerms: string[] }
  | { status: "ai_unavailable" }
  | { status: "failed"; error: string };
export interface GenerationDeps {   // injection for tests; real wiring in the callers
  db: Db; config: AppConfig;
  generate?: typeof generateGrounded;           // default real
  classifySensitive?: typeof classifySensitiveLlm; // default real
}
export async function runGeneration(deps: GenerationDeps, args: {
  workspaceId: string; applicationId: string;
  kind: DocumentKind | "question"; question?: string;
}): Promise<GenerationOutcome>;
```
- Flow (order is normative): (1) `config.openrouterApiKey` null → `ai_unavailable`; (2) when kind === "question": ruleset `classifyQuestionSensitivity`; if not sensitive AND api key present, `classifySensitiveLlm` tie-break (fast tier); `mergeSensitivityRulings`; sensitive → `sensitive_blocked` — the LLM is never called for generation; (3) load application+job (must belong to workspace) and facts via `listFacts`; map to `FactForSelection` (stale via `isFactStale`); `selectFactsForGeneration`; empty selection → `needs_facts` with reason "no verified facts match this request — add facts or write manually"; (4) `generateGrounded` wrapped in `withReplay` (mode from config, store `makeFsReplayStore("packages/ai/fixtures/replay")`... path resolved from repo root via config pattern — reuse the `FILE_STORAGE_DIR` resolution helper's approach: add the fixtures dir as a constant resolved relative to the ai package? Simplest correct: `AI_REPLAY_DIR` env with default resolved like fileStorageDir — document the choice); (5) failure → `failed` (with `no_facts_provided` mapped to `needs_facts`); (6) `validateGeneration` against the selected fact ids → `needs_facts` on failure, nothing persisted; (7) ok → persist: documents via `createDocument` (kind cover_letter/email_body) or answers via `createAnswer` (origin "ai", confidence, sensitivity "normal") → return ok with ids.

- [ ] **Step 1: Write the failing tests** — with stubbed `generate`/`classifySensitive` and a REAL db (skipIf TEST_DATABASE_URL, throwaway workspace with one application + facts): sensitive question short-circuits before generate (spy not called) → `sensitive_blocked`; no api key → `ai_unavailable`; generate ok + valid citations → document row exists with approval draft and sourceFactIds recorded; generate ok but citing out-of-subset id → `needs_facts` and NO row persisted; stale/sensitive facts never appear in the ids passed to generate (assert on the spy's input).
- [ ] **Step 2: FAIL.** **Step 3: Implement.** **Step 4: PASS + typecheck + lint.**
- [ ] **Step 5: Commit** — `feat(web): generation orchestration with sensitive block and needs-facts gating`

---

### Task 12: Web — materials UI (generate, stream, provenance, approve)

**Files:**
- Create: `apps/web/src/app/(dashboard)/applications/[id]/materials.tsx` (client), `apps/web/src/app/(dashboard)/applications/[id]/materials-actions.ts`, `apps/web/src/app/api/generate/stream/route.ts`
- Modify: `apps/web/src/app/(dashboard)/applications/[id]/page.tsx` (render `<Materials/>` with server-fetched documents + facts summary)

**Interfaces:**
- Consumes: `runGeneration` (Task 11), `streamChatJson`+`buildGeneratePrompt` (Tasks 7/9), document repos (Task 10).
- Produces:
  - Server actions: `generateDocumentAction({applicationId, kind}) → GenerationOutcome` (non-streaming path); `approveDocumentAction({id})`, `rejectDocumentAction({id})`, `createManualDocumentAction(formData)` (kind + content, origin "user", approval draft).
  - Stream route `POST /api/generate/stream` (node runtime): body `{applicationId, kind}` zod-validated; replays steps 1–3 of `runGeneration` (via exported helpers — refactor `runGeneration` internals so the fact-selection prelude is a shared `prepareGeneration(deps, args)` returning either an early `GenerationOutcome` or `{facts, prompt}`); streams SSE events `{"type":"delta","answer":...}` from `streamChatJson`'s callback with the FIRST writing model; on stream completion validates + persists exactly like `runGeneration` step 6–7 and emits `{"type":"done", outcome}`; on stream failure emits `{"type":"fallback"}` then runs the full non-streaming `generateGrounded` chain and emits done. `AI_MODE=replay` skips streaming entirely (replay is instant) and emits done from `runGeneration`.
  - Materials panel UI: per kind — latest document with **"AI-generated — not yet approved"** badge when `origin === "ai" && approval === "draft"`; provenance chips (fact claims looked up from sourceFactIds, rendered as small chips under the text); Approve / Reject buttons; Generate button opening a streaming pane (`EventSource`-style fetch reader appending `answer` deltas); NEEDS_FACTS outcome renders the reasons plus a link to `/facts` ("add a verified fact or write manually"); `ai_unavailable` renders the manual editor with a note; manual `<textarea>` editor always available (origin "user").

- [ ] **Step 1: Implement** (UI task; the orchestration logic is already unit-tested — this task's tests are the route's zod rejection path plus manual verification).
- [ ] **Step 2: Verify manually** (this host, dev server on 5433 DB): with NO api key — buttons show manual-mode note, manual document saves and approves; with a FAKE api key + `AI_MODE=replay` and a hand-recorded fixture (record one by calling `withReplay` in record mode with a stubbed run via tsx) — generate returns the replayed draft, provenance chips render, approve flips the badge off; curl the stream route with an invalid body → 400. Document every curl/transcript in the report.
- [ ] **Step 3: Typecheck + lint + full web tests.**
- [ ] **Step 4: Commit** — `feat(web): materials panel with streaming generation, provenance chips and approval flow`

---

### Task 13: Web — answer bank UI

**Files:**
- Create: `apps/web/src/app/(dashboard)/applications/[id]/qa.tsx` (client), `apps/web/src/app/(dashboard)/applications/[id]/qa-actions.ts`, `apps/web/src/app/(dashboard)/answers/page.tsx`
- Modify: `apps/web/src/app/layout.tsx` (nav "Answers"), `apps/web/src/app/(dashboard)/applications/[id]/page.tsx` (render `<QaPanel/>`)

**Interfaces:**
- Consumes: `runGeneration` kind "question" (Task 11), answer repos (Task 10).
- Produces:
  - Actions: `askQuestionAction({applicationId, question}) → GenerationOutcome` — `sensitive_blocked` outcome renders: "This question is sensitive (matched: …) — CareerHQ never AI-answers it. Answer manually below." with the manual answer form (origin "user", sensitivity from the ruling); `saveManualAnswerAction(formData)`; `approveAnswerAction({id, reusable})` (reusable checkbox in the approve UI); `rejectAnswerAction({id})`.
  - QA panel on the application page: question input → outcome pane (streamless — questions are short; non-streaming path only), answer list for this application with origin/approval badges and provenance chips for AI answers.
  - `/answers` page: the workspace reusable bank via `listReusableAnswers` — question, answer, source-fact count, approvedAt, **STALE** badge when `staleForReuse` (spec §7.2.6: flagged before reuse), grouped alphabetically by questionNorm.
- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify manually** — ask "What are your salary expectations?" → sensitive block message, manual form appears, manual answer saves with sensitivity "sensitive"; ask a normal question with replay fixture → AI draft with chips; approve with reusable → appears on /answers; with past reviewBy → STALE badge. Transcripts in report.
- [ ] **Step 3: Typecheck + lint.**
- [ ] **Step 4: Commit** — `feat(web): question answering with sensitive block and reusable answer bank`

---

### Task 14: ADR-0004, README, full verification

**Files:**
- Create: `docs/adr/0004-grounding-contract-and-sensitive-answers.md`
- Modify: `README.md`, `.env.example` (AI_WRITING_MODELS, AI_MODE entries)

**Interfaces:**
- ADR-0004 (Context/Decision/Consequences, ~40 lines): the grounding contract — minimal fact subset in, structured citations out, deterministic post-validation that never trusts model self-report, NEEDS_FACTS as a feature not a failure; the sensitive-answer policy — conservative ruleset + widen-only LLM tie-break, hard generation block, manual-only path; grounded in shipped artifacts (`selectFactsForGeneration`, `validateGeneration`, `classifyQuestionSensitivity`, `generationResultSchema`, spec §7).
- README: Materials + answer bank move to shipped features (grounded generation with provenance, streaming, sensitive block, NEEDS_FACTS, replay mode); env table gains AI_WRITING_MODELS / AI_MODE; routes gain /answers.
- [ ] **Step 1: Write ADR + README + .env.example.**
- [ ] **Step 2: Full gate** — `pnpm lint && pnpm typecheck && pnpm depcruise && TEST_DATABASE_URL=postgres://careerhq:careerhq@localhost:5433/careerhq pnpm test`; paste tails.
- [ ] **Step 3: Commit** — `docs: ADR-0004 grounding contract, README materials update`

---

## Final Verification (Definition of Done for P3)

1. Full gate green; no test performs a live network call.
2. The grounded path demonstrably blocks: a question citing no facts → NEEDS_FACTS with reasons and NOTHING persisted (unit-proven); a sensitive question → hard block before any LLM call (spy-proven).
3. Stale and sensitive facts provably never reach the model (spy-proven on generate input).
4. With no OPENROUTER_API_KEY the app fully works: manual documents/answers, clear ai-unavailable states.
5. AI drafts carry the "AI-generated — not yet approved" badge until approved; provenance chips resolve to real fact claims.
6. Reusable approved answers appear on /answers with STALE flagged past reviewBy.
7. Replay mode returns recorded fixtures without network; record mode writes them (unit-proven).
8. P2 backlog burned: stale llm scores cleared outside rerank batches, orphaned duplicates surface, salary/posted persisted, dead link gone, companies repo extracted.
