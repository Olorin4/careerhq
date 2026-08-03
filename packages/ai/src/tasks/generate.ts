import { generationResultSchema, type DocumentKind, type GenerationResult } from "@careerhq/contracts";
import { chatJsonWithFallback, type FallbackOptions, type FallbackResult } from "../client/fallback.js";

export interface GenerateFact {
  id: string;
  claim: string;
  detail: string | null;
}

export interface GenerateInput {
  kind: DocumentKind | "question";
  /** Required when kind === "question". */
  question?: string;
  /** Caller pre-trims descriptionSnippet to <=800 chars. */
  job: { title: string; companyName: string; descriptionSnippet: string };
  facts: GenerateFact[];
}

const SYSTEM_PROMPT_BASE = `You write application materials grounded EXCLUSIVELY in the numbered facts provided.

You must not invent employers, projects, metrics, dates, or qualifications that are not present in the provided facts.

You must return ONLY JSON matching this exact shape, with no prose, no markdown fences, and no extra keys:
{"answer","factIds","confidence","unsupportedClaims","clarificationNeeded"}

Rules:
- "factIds" must list the ids of every fact actually used to write the answer.
- Any claim in the answer that is not backed by a provided fact must be listed in "unsupportedClaims" — do not silently include it as if it were grounded.
- If the facts are insufficient to answer well, set a low confidence and explain what's missing in "clarificationNeeded" rather than inventing details.`;

function kindInstruction(kind: DocumentKind | "question"): string {
  switch (kind) {
    case "cover_letter":
      return `Write a cover letter: 3 short paragraphs, professional tone. Never use a salutation placeholder like "[Hiring Manager]" unless a name is known — omit the salutation instead of guessing.`;
    case "email_body":
      return "Write an email body: at most 150 words, direct and to the point.";
    case "question":
      return "Answer the question directly, using only the provided facts.";
  }
}

function formatFactLine(fact: GenerateFact): string {
  const detail = fact.detail ?? "(no further detail)";
  return `[${fact.id}] ${fact.claim} — ${detail}`;
}

export function buildGeneratePrompt(input: GenerateInput): { system: string; user: string } {
  const system = `${SYSTEM_PROMPT_BASE}\n\n${kindInstruction(input.kind)}`;

  const userLines = [
    `Job title: ${input.job.title}`,
    `Company: ${input.job.companyName}`,
    `Job description snippet: ${input.job.descriptionSnippet}`,
  ];

  if (input.question) {
    userLines.push(`Question: ${input.question}`);
  }

  userLines.push("", "Facts:", ...input.facts.map(formatFactLine));

  return { system, user: userLines.join("\n") };
}

/**
 * Generates a grounded application-material answer via an LLM, falling back
 * across models on failure or a hallucinated-fact-id result. Never calls the
 * LLM when no facts are provided — there is nothing to ground an answer in,
 * so the call cannot succeed (same lesson as rerank's empty-input guard).
 */
export async function generateGrounded(
  input: GenerateInput,
  opts: FallbackOptions,
): Promise<FallbackResult<GenerationResult>> {
  if (input.facts.length === 0) {
    return {
      ok: false,
      value: null,
      model: "",
      latencyMs: 0,
      status: null,
      error: "no_facts_provided",
      attempts: [],
    };
  }

  const { system, user } = buildGeneratePrompt(input);
  const factIds = new Set(input.facts.map((fact) => fact.id));

  return chatJsonWithFallback<GenerationResult>(
    {
      system,
      user,
      schema: generationResultSchema,
      isUseful: (value) => value.factIds.every((id) => factIds.has(id)),
    },
    opts,
  );
}
