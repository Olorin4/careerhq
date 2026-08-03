import { eq } from "drizzle-orm";
import type { AppConfig } from "@careerhq/config";
import { generationResultSchema, type DocumentKind, type GenerationResult } from "@careerhq/contracts";
import {
  buildGeneratePrompt, classifySensitiveLlm, generateGrounded, makeFsReplayStore, withReplay,
  type GenerateInput,
} from "@careerhq/ai";
import {
  classifyQuestionSensitivity, mergeSensitivityRulings, selectFactsForGeneration, validateGeneration,
  type FactForSelection,
} from "@careerhq/core";
import {
  companies as companiesTable, createAnswer, createDocument, getApplicationDetail, isFactStale,
  listFacts, type Db,
} from "@careerhq/db";
import { stripHtml } from "@careerhq/ingest";

/**
 * Every terminal state of a generation attempt. Only `ok` has persisted a row;
 * every other status leaves the database untouched, so a caller can render the
 * outcome without worrying about half-written drafts.
 */
export type GenerationOutcome =
  | { status: "ok"; documentId?: string; answerId?: string; answer: string; factIds: string[]; model: string | null }
  | { status: "needs_facts"; reasons: string[] }
  | { status: "sensitive_blocked"; matchedTerms: string[] }
  | { status: "ai_unavailable" }
  | { status: "failed"; error: string };

export interface GenerationDeps {
  db: Db;
  config: AppConfig;
  /** Injected in tests; defaults to the real grounded generate task. */
  generate?: typeof generateGrounded;
  /** Injected in tests; defaults to the real fast-tier tie-break. */
  classifySensitive?: typeof classifySensitiveLlm;
}

export interface GenerationArgs {
  workspaceId: string;
  applicationId: string;
  kind: DocumentKind | "question";
  /** Required when kind === "question". */
  question?: string;
}

/**
 * The result of the gating + fact-selection prelude. Either a gate tripped and
 * the caller must return `outcome` verbatim, or the work is ready to hand to a
 * model. The streaming route (which drives the model itself) and
 * `runGeneration` share this so the two paths can never disagree about which
 * facts are in scope.
 */
export type PreparedGeneration =
  | { ready: false; outcome: GenerationOutcome }
  | {
      ready: true;
      input: GenerateInput;
      prompt: { system: string; user: string };
      /** Ids of the selected facts — the subset the answer must cite from. */
      factIds: string[];
    };

const NO_FACTS_REASON = "no verified facts match this request — add facts or write manually";

/** Matches `GenerateInput.job.descriptionSnippet`'s documented ceiling. */
const MAX_DESCRIPTION_SNIPPET = 800;

/** Task id for the record/replay store; keeps generate fixtures in their own keyspace. */
const REPLAY_TASK_ID = "generate";

function needsFacts(reasons: string[]): GenerationOutcome {
  return { status: "needs_facts", reasons };
}

/**
 * Steps 1–3 of the flow: the api-key gate, the sensitive-question gate, the
 * workspace-scoped application load and deterministic fact selection. Exported
 * so the streaming route can reuse the exact same prelude.
 */
export async function prepareGeneration(
  deps: GenerationDeps,
  args: GenerationArgs,
): Promise<PreparedGeneration> {
  const { db, config } = deps;
  const apiKey = config.openrouterApiKey;

  // (1) No key means no AI at all — the deterministic floor. Checked first so
  // no other work (and no db read) happens for a disabled install.
  if (apiKey === null) return { ready: false, outcome: { status: "ai_unavailable" } };

  let question: string | undefined;
  let ruleset: ReturnType<typeof classifyQuestionSensitivity> | undefined;
  if (args.kind === "question") {
    // generateGrounded degrades silently on a question-kind input with no
    // question (it just omits the line), which would produce a confident
    // answer to nothing. Reject the combination here instead.
    question = args.question?.trim();
    if (!question) return { ready: false, outcome: { status: "failed", error: "question_required" } };

    // (2) Ruleset first — it's a pure string match, free of cost, so it costs
    // nothing to run before the application even loads. A ruleset hit is
    // already a final verdict: the fast-tier LLM only ever widens a clean
    // ruling, so there is nothing left for it to check.
    ruleset = classifyQuestionSensitivity(question);
    if (ruleset.sensitive) {
      // The writing model is never called for a sensitive question: the user
      // answers these themselves.
      return { ready: false, outcome: { status: "sensitive_blocked", matchedTerms: ruleset.matchedTerms } };
    }
  }

  // (3) Workspace scoping is enforced here, not by the caller: an application
  // id from another workspace must never reach the fact bank of this one.
  // This runs before the fast-tier LLM tie-break below (unlike the ruleset
  // check above, that call has a real cost), so an invalid applicationId is
  // rejected before ever burning an LLM call on it.
  const detail = await getApplicationDetail(db, args.applicationId);
  if (!detail || detail.application.workspaceId !== args.workspaceId) {
    return { ready: false, outcome: { status: "failed", error: "application_not_found" } };
  }
  const { job } = detail;
  // getApplicationDetail casts the job row; a missing job would be a broken
  // foreign key, but an undefined `job.title` further down is a far worse
  // failure mode than an explicit error here.
  if (!job) return { ready: false, outcome: { status: "failed", error: "job_not_found" } };

  if (args.kind === "question" && ruleset) {
    // (2b) The fast-tier tie-break itself: only reached once the ruleset
    // came back clean AND the application is confirmed real and in-scope.
    const classifySensitive = deps.classifySensitive ?? classifySensitiveLlm;
    // `question` is guaranteed defined here: it's only unset when
    // `args.kind !== "question"`, in which case `ruleset` (checked above) was
    // never assigned either.
    const llmRuling = await classifySensitive(question!, { models: config.aiFastModels, apiKey });
    if (mergeSensitivityRulings(ruleset, llmRuling)) {
      return { ready: false, outcome: { status: "sensitive_blocked", matchedTerms: ruleset.matchedTerms } };
    }
  }

  const companyName = job.companyId
    ? (await db.select().from(companiesTable).where(eq(companiesTable.id, job.companyId)))[0]?.name
    : undefined;

  const facts = await listFacts(db, args.workspaceId);
  const now = new Date();
  const forSelection: FactForSelection[] = facts.map((fact) => ({
    id: fact.id,
    category: fact.category,
    claim: fact.claim,
    detail: fact.detail,
    sensitivity: fact.sensitivity,
    stale: isFactStale(fact, now),
  }));
  // selectFactsForGeneration hard-excludes stale and sensitive facts, so
  // nothing past this point can leak one into a prompt.
  const selected = selectFactsForGeneration(forSelection, {
    question,
    jobTitle: job.title,
    jobDescription: job.descriptionMd,
  });
  if (selected.length === 0) return { ready: false, outcome: needsFacts([NO_FACTS_REASON]) };

  const input: GenerateInput = {
    kind: args.kind,
    question,
    job: {
      title: job.title,
      companyName: companyName ?? "the company",
      descriptionSnippet: stripHtml(job.descriptionMd ?? "").slice(0, MAX_DESCRIPTION_SNIPPET),
    },
    facts: selected.map((fact) => ({ id: fact.id, claim: fact.claim, detail: fact.detail })),
  };

  return { ready: true, input, prompt: buildGeneratePrompt(input), factIds: selected.map((f) => f.id) };
}

/**
 * Steps 6–7: validate a model result against the facts it was actually given,
 * then persist it. A result that fails validation persists nothing — an
 * ungrounded draft in the database is worse than no draft. Exported so the
 * streaming route finishes a stream exactly the way `runGeneration` finishes a
 * blocking call.
 */
export async function finalizeGeneration(
  deps: GenerationDeps,
  args: GenerationArgs,
  result: GenerationResult,
  factIds: string[],
  model: string | null,
): Promise<GenerationOutcome> {
  const validation = validateGeneration(result, factIds);
  if (!validation.ok) return needsFacts(validation.reasons);

  if (args.kind === "question") {
    const question = args.question?.trim();
    if (!question) return { status: "failed", error: "question_required" };
    const answer = await createAnswer(deps.db, {
      applicationId: args.applicationId,
      questionRaw: question,
      answer: result.answer,
      origin: "ai",
      sourceFactIds: result.factIds,
      confidence: result.confidence,
      // Sensitive questions never get here — they are blocked in the prelude.
      sensitivity: "normal",
    });
    return {
      status: "ok", answerId: answer.id, answer: result.answer, factIds: result.factIds, model,
    };
  }

  const document = await createDocument(deps.db, {
    applicationId: args.applicationId,
    kind: args.kind,
    contentMd: result.answer,
    sourceFactIds: result.factIds,
    model,
    origin: "ai",
  });
  return {
    status: "ok", documentId: document.id, answer: result.answer, factIds: result.factIds, model,
  };
}

/**
 * The one blocking path from "generate this" to a persisted draft. Order is
 * normative (spec §7.2): api-key gate → sensitive-question gate → workspace
 * scoping and fact selection → the model → validation → persistence. Any step
 * can end the run, and only the last one writes.
 */
export async function runGeneration(
  deps: GenerationDeps,
  args: GenerationArgs,
): Promise<GenerationOutcome> {
  const prepared = await prepareGeneration(deps, args);
  if (!prepared.ready) return prepared.outcome;

  const { config } = deps;
  const apiKey = config.openrouterApiKey;
  // prepareGeneration already returned ai_unavailable for a null key; this is
  // for the type narrowing only.
  if (apiKey === null) return { status: "ai_unavailable" };

  const generate = deps.generate ?? generateGrounded;
  // (4) The replay layer wraps the whole call: in replay mode `generate` is
  // never invoked, so a fixture-driven run needs no live key beyond the gate.
  const result = await withReplay<GenerationResult>({
    mode: config.aiMode,
    store: makeFsReplayStore(config.aiReplayDir),
    taskId: REPLAY_TASK_ID,
    prompt: prepared.prompt,
    schema: generationResultSchema,
    run: () => generate(prepared.input, { models: config.aiWritingModels, apiKey }),
  });

  // (5) A failure is terminal, except no_facts_provided — that is the grounding
  // guard firing, which is the user-actionable "add facts" case, not a fault.
  if (!result.ok || !result.value) {
    const error = result.error ?? "generation_failed";
    if (error === "no_facts_provided") return needsFacts([NO_FACTS_REASON]);
    return { status: "failed", error };
  }

  // (6) + (7)
  return finalizeGeneration(deps, args, result.value, prepared.factIds, result.model || null);
}
