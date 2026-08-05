import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { FallbackOptions, GenerateInput } from "@careerhq/ai";
import type { GenerationResult } from "@careerhq/contracts";
import { loadConfig, type AppConfig } from "@careerhq/config";
import {
  applications, companies as companiesTable, createApplication, createDb, createFact,
  jobs as jobsTable, listAnswers, listDocuments, lockDemoSeed, seedDemoWorkspace, workspaces,
  type Db,
} from "@careerhq/db";
import {
  prepareGeneration, runGeneration, type GenerationArgs, type GenerationDeps,
} from "./generation";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

const BASE_ENV = {
  DATABASE_URL: url ?? "postgres://u:p@localhost:5432/careerhq",
  OPENROUTER_API_KEY: "sk-or-test",
  AI_REPLAY_DIR: mkdtempSync(path.join(tmpdir(), "careerhq-replay-")),
};

let db: Db;
let workspaceId: string;
let applicationId: string;
/** Fresh, non-sensitive fact — the only one that may ever reach the model. */
let freshFactId: string;
let staleFactId: string;
let sensitiveFactId: string;
/** A second workspace whose application has no facts at all. */
let emptyWorkspaceId: string;
let emptyApplicationId: string;

const YEAR = 365 * 24 * 60 * 60 * 1000;

function okResult(value: GenerationResult, model = "test/model") {
  return { ok: true as const, value, model, latencyMs: 5, status: 200, error: null, attempts: [] };
}

function failResult(error: string) {
  return {
    ok: false as const, value: null, model: "", latencyMs: 0, status: null, error, attempts: [],
  };
}

function config(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...BASE_ENV, ...overrides });
}

type GenerateStubResult = ReturnType<typeof okResult> | ReturnType<typeof failResult>;

/** A `generate` stub whose recorded calls stay typed, so the input can be asserted on. */
function stubGenerate(result: GenerateStubResult) {
  return vi.fn<(input: GenerateInput, opts: FallbackOptions) => Promise<GenerateStubResult>>(
    async () => result,
  );
}

function deps(over: Partial<GenerationDeps> = {}): GenerationDeps {
  return {
    db,
    config: config(),
    generate: stubGenerate(okResult({ answer: "x", factIds: [], confidence: 1, unsupportedClaims: [] })),
    classifySensitive: vi.fn(async () => null),
    ...over,
  };
}

beforeAll(async () => {
  if (!url) return;
  db = createDb(url);
  const [ws] = await db.insert(workspaces).values({ name: `t-gen-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;
  const app = await createApplication(db, {
    workspaceId, companyName: "Acme Robotics", jobTitle: "Senior Platform Engineer",
  });
  applicationId = app.id;
  await db.update(jobsTable)
    .set({ descriptionMd: "<p>We need a <b>platform</b> engineer for kubernetes work.</p>" })
    .where(eq(jobsTable.id, app.jobId));

  const future = new Date(Date.now() + YEAR);
  const past = new Date(Date.now() - YEAR);
  freshFactId = (await createFact(db, {
    workspaceId, category: "experience", claim: "Led platform team of six",
    detail: "Ran kubernetes migration", reviewBy: future,
  })).id;
  staleFactId = (await createFact(db, {
    workspaceId, category: "experience", claim: "Stale platform work",
    detail: "Needs re-verification", reviewBy: past,
  })).id;
  sensitiveFactId = (await createFact(db, {
    workspaceId, category: "authorization", claim: "Requires visa sponsorship",
    detail: "kubernetes platform", sensitivity: "sensitive", reviewBy: future,
  })).id;

  const [emptyWs] = await db.insert(workspaces)
    .values({ name: `t-gen-empty-${Date.now()}`, kind: "personal" }).returning();
  emptyWorkspaceId = emptyWs!.id;
  emptyApplicationId = (await createApplication(db, {
    workspaceId: emptyWorkspaceId, companyName: "Empty Inc", jobTitle: "Analyst",
  })).id;
});

afterAll(async () => {
  if (!url) return;
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(workspaces).where(eq(workspaces.id, emptyWorkspaceId));
  await db.$client.end();
});

d("runGeneration gates", () => {
  it("returns ai_unavailable and never calls the model when no api key is configured", async () => {
    const generate = stubGenerate(okResult({ answer: "a", factIds: [], confidence: 1, unsupportedClaims: [] }));
    const classifySensitive = vi.fn(async () => null);
    const outcome = await runGeneration(
      deps({ config: config({ OPENROUTER_API_KEY: "" }), generate, classifySensitive }),
      { workspaceId, applicationId, kind: "cover_letter" },
    );
    expect(outcome).toEqual({ status: "ai_unavailable" });
    expect(generate).not.toHaveBeenCalled();
    expect(classifySensitive).not.toHaveBeenCalled();
  });

  it("blocks a ruleset-sensitive question before any model call", async () => {
    const generate = stubGenerate(okResult({ answer: "a", factIds: [], confidence: 1, unsupportedClaims: [] }));
    const classifySensitive = vi.fn(async () => null);
    const outcome = await runGeneration(deps({ generate, classifySensitive }), {
      workspaceId, applicationId, kind: "question",
      question: "What are your salary expectations for this role?",
    });
    expect(outcome.status).toBe("sensitive_blocked");
    if (outcome.status !== "sensitive_blocked") throw new Error("unreachable");
    expect(outcome.matchedTerms).toContain("salary");
    expect(generate).not.toHaveBeenCalled();
    // The ruleset already decided: no reason to spend an LLM call widening a
    // verdict that cannot be narrowed.
    expect(classifySensitive).not.toHaveBeenCalled();
  });

  it("lets the fast-tier tie-break widen a ruleset-clean question to sensitive", async () => {
    const generate = stubGenerate(okResult({ answer: "a", factIds: [], confidence: 1, unsupportedClaims: [] }));
    const classifySensitive = vi.fn(async () => true);
    const outcome = await runGeneration(deps({ generate, classifySensitive }), {
      workspaceId, applicationId, kind: "question",
      question: "Do you have any family plans in the next two years?",
    });
    expect(outcome).toEqual({ status: "sensitive_blocked", matchedTerms: [] });
    expect(classifySensitive).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps the ruleset verdict when the tie-break fails (null)", async () => {
    const generate = stubGenerate(okResult({
      answer: "Answer", factIds: [freshFactId], confidence: 0.9, unsupportedClaims: [],
    }));
    const outcome = await runGeneration(
      deps({ generate, classifySensitive: vi.fn(async () => null) }),
      { workspaceId, applicationId, kind: "question", question: "Describe your platform experience." },
    );
    expect(outcome.status).toBe("ok");
  });

  it("rejects kind question without a question instead of degrading silently", async () => {
    const generate = stubGenerate(okResult({ answer: "a", factIds: [], confidence: 1, unsupportedClaims: [] }));
    const outcome = await runGeneration(deps({ generate }), {
      workspaceId, applicationId, kind: "question", question: "   ",
    });
    expect(outcome).toEqual({ status: "failed", error: "question_required" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("refuses an application belonging to another workspace", async () => {
    const generate = stubGenerate(okResult({ answer: "a", factIds: [], confidence: 1, unsupportedClaims: [] }));
    const outcome = await runGeneration(deps({ generate }), {
      workspaceId: emptyWorkspaceId, applicationId, kind: "cover_letter",
    });
    expect(outcome).toEqual({ status: "failed", error: "application_not_found" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("never burns a fast-tier LLM call for a ruleset-clean question when the applicationId is invalid", async () => {
    const generate = stubGenerate(okResult({ answer: "a", factIds: [], confidence: 1, unsupportedClaims: [] }));
    const classifySensitive = vi.fn(async () => null);
    // "Describe your platform experience." is ruleset-clean (see the
    // ruleset-widening tests above), so absent the fix this would reach the
    // paid tie-break call before the workspace-scoping check ever runs.
    const outcome = await runGeneration(deps({ generate, classifySensitive }), {
      workspaceId: emptyWorkspaceId, applicationId, kind: "question",
      question: "Describe your platform experience.",
    });
    expect(outcome).toEqual({ status: "failed", error: "application_not_found" });
    expect(classifySensitive).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("returns needs_facts without calling the model when nothing is selectable", async () => {
    const generate = stubGenerate(okResult({ answer: "a", factIds: [], confidence: 1, unsupportedClaims: [] }));
    const outcome = await runGeneration(deps({ generate }), {
      workspaceId: emptyWorkspaceId, applicationId: emptyApplicationId, kind: "cover_letter",
    });
    expect(outcome).toEqual({
      status: "needs_facts",
      reasons: ["no verified facts match this request — add facts or write manually"],
    });
    expect(generate).not.toHaveBeenCalled();
  });
});

d("runGeneration fact grounding", () => {
  it("never hands the model a stale or sensitive fact", async () => {
    const generate = stubGenerate(okResult({
      answer: "Draft", factIds: [freshFactId], confidence: 0.9, unsupportedClaims: [],
    }));
    await runGeneration(deps({ generate }), { workspaceId, applicationId, kind: "cover_letter" });
    expect(generate).toHaveBeenCalledTimes(1);
    const input = generate.mock.calls[0]![0];
    const ids = input.facts.map((f) => f.id);
    expect(ids).toContain(freshFactId);
    expect(ids).not.toContain(staleFactId);
    expect(ids).not.toContain(sensitiveFactId);
  });

  it("passes the job with html stripped from the description snippet", async () => {
    const generate = stubGenerate(okResult({
      answer: "Draft", factIds: [freshFactId], confidence: 0.9, unsupportedClaims: [],
    }));
    await runGeneration(deps({ generate }), { workspaceId, applicationId, kind: "cover_letter" });
    const input = generate.mock.calls[0]![0];
    expect(input.job.title).toBe("Senior Platform Engineer");
    expect(input.job.companyName).toBe("Acme Robotics");
    expect(input.job.descriptionSnippet).toBe("We need a platform engineer for kubernetes work.");
    expect(input.job.descriptionSnippet.length).toBeLessThanOrEqual(800);
  });
});

d("runGeneration persistence", () => {
  it("persists an ai draft document with the cited fact ids and model", async () => {
    const generate = stubGenerate(okResult({
      answer: "Dear Acme Robotics team, I led a platform team of six.",
      factIds: [freshFactId], confidence: 0.82, unsupportedClaims: [],
    }, "deepseek/deepseek-chat:free"));
    const outcome = await runGeneration(deps({ generate }), {
      workspaceId, applicationId, kind: "cover_letter",
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.documentId).toBeTruthy();
    expect(outcome.answerId).toBeUndefined();
    expect(outcome.factIds).toEqual([freshFactId]);
    expect(outcome.model).toBe("deepseek/deepseek-chat:free");

    const docs = await listDocuments(db, applicationId);
    const doc = docs.find((row) => row.id === outcome.documentId);
    expect(doc).toBeDefined();
    expect(doc!.approval).toBe("draft");
    expect(doc!.origin).toBe("ai");
    expect(doc!.kind).toBe("cover_letter");
    expect(doc!.sourceFactIds).toEqual([freshFactId]);
    expect(doc!.model).toBe("deepseek/deepseek-chat:free");
  });

  it("persists an ai answer for a non-sensitive question", async () => {
    const generate = stubGenerate(okResult({
      answer: "I led a platform team of six through a kubernetes migration.",
      factIds: [freshFactId], confidence: 0.77, unsupportedClaims: [],
    }));
    const outcome = await runGeneration(deps({ generate }), {
      workspaceId, applicationId, kind: "question",
      question: "Describe your platform engineering experience.",
    });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.answerId).toBeTruthy();
    expect(outcome.documentId).toBeUndefined();

    const answers = await listAnswers(db, applicationId);
    const answer = answers.find((row) => row.id === outcome.answerId);
    expect(answer).toBeDefined();
    expect(answer!.origin).toBe("ai");
    expect(answer!.approval).toBe("draft");
    expect(answer!.sensitivity).toBe("normal");
    expect(answer!.confidence).toBeCloseTo(0.77, 5);
    expect(answer!.questionRaw).toBe("Describe your platform engineering experience.");
    expect(answer!.sourceFactIds).toEqual([freshFactId]);
  });

  it("persists nothing when the model cites a fact outside the provided subset", async () => {
    const before = (await listDocuments(db, applicationId)).length;
    const generate = stubGenerate(okResult({
      answer: "I am also a licensed pilot.", factIds: [staleFactId], confidence: 0.95, unsupportedClaims: [],
    }));
    const outcome = await runGeneration(deps({ generate }), {
      workspaceId, applicationId, kind: "cover_letter",
    });
    expect(outcome.status).toBe("needs_facts");
    if (outcome.status !== "needs_facts") throw new Error("unreachable");
    expect(outcome.reasons.join(" ")).toContain(staleFactId);
    expect((await listDocuments(db, applicationId)).length).toBe(before);
  });

  it("persists nothing when confidence is below the floor", async () => {
    const before = (await listDocuments(db, applicationId)).length;
    const generate = stubGenerate(okResult({
      answer: "Maybe.", factIds: [freshFactId], confidence: 0.2, unsupportedClaims: [],
    }));
    const outcome = await runGeneration(deps({ generate }), {
      workspaceId, applicationId, kind: "cover_letter",
    });
    expect(outcome.status).toBe("needs_facts");
    expect((await listDocuments(db, applicationId)).length).toBe(before);
  });
});

d("runGeneration failure mapping", () => {
  it("maps a no_facts_provided failure to needs_facts", async () => {
    const outcome = await runGeneration(deps({ generate: stubGenerate(failResult("no_facts_provided")) }), {
      workspaceId, applicationId, kind: "cover_letter",
    });
    expect(outcome.status).toBe("needs_facts");
  });

  it("surfaces any other model failure as failed with the error code", async () => {
    const outcome = await runGeneration(deps({ generate: stubGenerate(failResult("http_500")) }), {
      workspaceId, applicationId, kind: "cover_letter",
    });
    expect(outcome).toEqual({ status: "failed", error: "http_500" });
  });

  it("routes the model call through the replay layer: a replay miss never calls generate", async () => {
    const generate = stubGenerate(okResult({
      answer: "Draft", factIds: [freshFactId], confidence: 0.9, unsupportedClaims: [],
    }));
    const outcome = await runGeneration(
      deps({ generate, config: config({ AI_MODE: "replay" }) }),
      { workspaceId, applicationId, kind: "cover_letter" },
    );
    expect(outcome).toEqual({ status: "failed", error: "replay_miss" });
    expect(generate).not.toHaveBeenCalled();
  });
});

d("prepareGeneration", () => {
  it("returns the built prompt and the selected fact ids for the stream route to reuse", async () => {
    const prepared = await prepareGeneration(deps(), { workspaceId, applicationId, kind: "cover_letter" });
    expect(prepared.ready).toBe(true);
    if (!prepared.ready) throw new Error("unreachable");
    expect(prepared.factIds).toContain(freshFactId);
    expect(prepared.factIds).not.toContain(staleFactId);
    expect(prepared.prompt.user).toContain("Led platform team of six");
    expect(prepared.prompt.user).toContain(freshFactId);
    expect(prepared.input.facts.map((f) => f.id)).toEqual(prepared.factIds);
  });

  it("returns the early outcome instead of a prompt when a gate trips", async () => {
    const prepared = await prepareGeneration(deps({ config: config({ OPENROUTER_API_KEY: "" }) }), {
      workspaceId, applicationId, kind: "cover_letter",
    });
    expect(prepared).toEqual({ ready: false, outcome: { status: "ai_unavailable" } });
  });
});

/**
 * The hosted demo's premise, asserted end to end (spec P6 §3, Task 8): it
 * deploys with `AI_MODE=replay` and **no** `OPENROUTER_API_KEY`, so every AI
 * answer a visitor sees has to come out of a committed fixture in
 * `packages/ai/fixtures/replay/`.
 *
 * Two things are being proved here, and neither is "the fixture files exist":
 *
 *  1. a keyless replay run reaches the model layer at all (the api-key gate
 *     used to refuse it before anything else ran), and
 *  2. the fixtures still *hit* against a freshly reset demo workspace — which
 *     they only can because `demo-seed.ts` pins its fact ids. Every run of this
 *     suite reseeds, so a change that unpins them fails here rather than six
 *     hours after a deploy.
 *
 * `generate` is a stub that throws: reaching it would mean the run tried to
 * talk to OpenRouter, which is the failure this whole arrangement exists to
 * make impossible.
 */
d("the hosted demo's keyless replay path", () => {
  /**
   * Seeding runs inside a rolled-back transaction holding the demo seed's own
   * advisory lock, exactly like `apps/worker/src/lib/workspace.test.ts`: the
   * seed's delete predicate is database-global, `jobs/demo-reset.test.ts` runs
   * resets in parallel with this file, and without the lock one of them would
   * delete this test's workspace between the seed and the assertions. The
   * rollback is why running this suite never disturbs a real demo workspace.
   */
  async function inSeededDemoWorkspace(
    body: (tx: Db, workspaceId: string) => Promise<void>,
  ): Promise<void> {
    const ROLLBACK = new Error("rollback: this test must leave no trace");
    await expect(db.transaction(async (tx) => {
      await lockDemoSeed(tx);
      // The seed only needs a transaction handle; drizzle nests its own
      // `db.transaction` on this one as a savepoint.
      const txDb = tx as unknown as Db;
      const { workspaceId: demoWorkspaceId } = await seedDemoWorkspace(txDb, {
        fileStorageDir: mkdtempSync(path.join(tmpdir(), "careerhq-demo-replay-")),
      });
      await body(txDb, demoWorkspaceId);
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
  }

  /**
   * Every seeded application with its company name, in `/applications`' order.
   * Enumerated rather than named one by one: the point of this test is that a
   * visitor's *first* click succeeds whichever row they open, so a new seeded
   * application must fail here until it has a fixture, not surface as a
   * `replay_miss` on the live demo (Task 12, C1).
   */
  async function demoApplications(
    tx: Db, demoWorkspaceId: string,
  ): Promise<Array<{ id: string; company: string }>> {
    return tx.select({ id: applications.id, company: companiesTable.name })
      .from(applications)
      .innerJoin(jobsTable, eq(applications.jobId, jobsTable.id))
      .innerJoin(companiesTable, eq(jobsTable.companyId, companiesTable.id))
      .where(eq(applications.workspaceId, demoWorkspaceId))
      .orderBy(applications.createdAt, applications.id);
  }

  it("answers every seeded application's generation flows from committed fixtures with no api key", async () => {
    // Exactly the demo's AI environment: replay mode, no key, and the
    // repo's committed fixture directory (AI_REPLAY_DIR's default).
    const replayConfig = loadConfig({ DATABASE_URL: BASE_ENV.DATABASE_URL, AI_MODE: "replay" });
    expect(replayConfig.openrouterApiKey).toBeNull();

    const generate = vi.fn(async () => {
      throw new Error("replay mode must never call the model");
    });
    const classifySensitive = vi.fn(async () => {
      throw new Error("replay mode must never call the model");
    });

    await inSeededDemoWorkspace(async (tx, demoWorkspaceId) => {
      const seeded = await demoApplications(tx, demoWorkspaceId);
      expect(seeded.length).toBeGreaterThan(0);
      const wexford = seeded.find((a) => a.company === "Wexford Health")?.id;
      if (!wexford) throw new Error("no seeded application for Wexford Health");

      const cases: Array<{ label: string; args: GenerationArgs }> = [
        ...seeded.flatMap(({ id, company }): Array<{ label: string; args: GenerationArgs }> => [
          { label: `cover letter — ${company}`, args: { workspaceId: demoWorkspaceId, applicationId: id, kind: "cover_letter" } },
          { label: `email body — ${company}`, args: { workspaceId: demoWorkspaceId, applicationId: id, kind: "email_body" } },
        ]),
        {
          label: "screening question",
          args: {
            workspaceId: demoWorkspaceId, applicationId: wexford, kind: "question",
            question: "Why do you want to work here?",
          },
        },
      ];

      for (const { label, args } of cases) {
        const outcome = await runGeneration(
          { db: tx, config: replayConfig, generate, classifySensitive }, args,
        );
        expect(outcome.status, `${label}: ${JSON.stringify(outcome)}`).toBe("ok");
        if (outcome.status !== "ok") throw new Error("unreachable");
        // "replay:<recorded model>" is withReplay's marker for a fixture hit,
        // so this distinguishes a real replay from a lucky live call.
        expect(outcome.model).toMatch(/^replay:/);
        expect(outcome.answer.length).toBeGreaterThan(0);
        // The grounding contract still runs on a replayed answer: every cited
        // fact is one the prompt actually offered.
        expect(outcome.factIds.length).toBeGreaterThan(0);
      }

      expect(generate).not.toHaveBeenCalled();
      expect(classifySensitive).not.toHaveBeenCalled();
    });
  }, 120_000);
});
