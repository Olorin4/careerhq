import { rerankResultSchema, type RerankResult, type ScoringProfile } from "@careerhq/contracts";
import { chatJsonWithFallback, type FallbackOptions, type FallbackResult } from "../client/fallback.js";

export interface RerankJobInput {
  id: string;
  title: string;
  companyName: string;
  location: string | null;
  remoteMode: string | null;
  keywordScore: number | null;
  /** Caller pre-trims this to <=600 chars. */
  descriptionSnippet: string;
}

const SYSTEM_PROMPT = `You are ranking job listings for fit against a candidate profile.

You must return ONLY JSON matching this exact shape, with no prose, no markdown fences, and no extra keys:
{"results":[{"jobId","score","rationale","redFlags"}]}

Rules:
- Score each job 0-100 for fit against the candidate profile.
- Return exactly one entry per input job — no more, no fewer.
- Copy each job's "jobId" verbatim from the input; never invent, alter, or omit an id.
- "rationale" must be a concise explanation of at most 25 words.
- "redFlags" is an array of strings listing only concrete concerns actually present in the listing (for example: equity-only pay, agency spam, mismatched seniority). Leave it empty if there are none — do not speculate.`;

function formatList(label: string, values: string[]): string {
  return `${label}: ${values.length > 0 ? values.join(", ") : "(none specified)"}`;
}

function formatJobLine(index: number, job: RerankJobInput): string {
  const location = job.location ?? "unknown";
  const remote = job.remoteMode ?? "unknown";
  const keywordScore = job.keywordScore ?? "unknown";
  return [
    `${index + 1}. id: ${job.id}`,
    `title: ${job.title}`,
    `company: ${job.companyName}`,
    `location: ${location}`,
    `remote: ${remote}`,
    `keywordScore: ${keywordScore}`,
    `snippet: ${job.descriptionSnippet}`,
  ].join(" | ");
}

export function buildRerankPrompt(
  jobs: RerankJobInput[],
  profile: ScoringProfile,
): { system: string; user: string } {
  const user = [
    "Candidate profile:",
    formatList("Roles", profile.roles),
    formatList("Stack", profile.stack),
    formatList("Boost", profile.boost),
    "",
    "Jobs:",
    ...jobs.map((job, i) => formatJobLine(i, job)),
  ].join("\n");

  return { system: SYSTEM_PROMPT, user };
}

/**
 * Re-ranks candidate jobs for fit against a scoring profile via an LLM,
 * falling back across models on failure or a hallucinated-id result.
 */
export async function rerankJobs(
  jobs: RerankJobInput[],
  profile: ScoringProfile,
  opts: FallbackOptions,
): Promise<FallbackResult<RerankResult>> {
  const { system, user } = buildRerankPrompt(jobs, profile);
  const inputIds = new Set(jobs.map((job) => job.id));

  return chatJsonWithFallback<RerankResult>(
    {
      system,
      user,
      schema: rerankResultSchema,
      isUseful: (value) => value.results.length > 0 && value.results.every((r) => inputIds.has(r.jobId)),
    },
    opts,
  );
}
