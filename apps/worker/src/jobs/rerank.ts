import { inArray } from "drizzle-orm";
import type { AppConfig } from "@careerhq/config";
import { applyRerank, companies, getScoringProfile, listInboxJobs, type Db } from "@careerhq/db";
import type { JobScore } from "@careerhq/core";
import {
  buildRerankPrompt, makeFsReplayStore, rerankJobs, withReplay, type RerankJobInput,
} from "@careerhq/ai";
import { rerankResultSchema, type RerankResult } from "@careerhq/contracts";
import { stripHtml } from "@careerhq/ingest";

const SNIPPET_LENGTH = 600;

/** Task id for the record/replay store; keeps re-rank fixtures in their own keyspace. */
const REPLAY_TASK_ID = "rerank";

export interface RerankSummary {
  status: "skipped_no_key" | "skipped_empty" | "ok" | "failed";
  reranked: number;
}

/**
 * Reads the gates out of the full `JobScore` object persisted in
 * `keyword_breakdown`. Spec §5.4: an excluded job is never shown scored, and a
 * remote-filtered one is not a candidate either — so neither belongs in the
 * LLM batch. They would otherwise burn tokens on listings the inbox will not
 * display and crowd genuinely eligible jobs out of `topNForLlm`.
 */
function isRerankCandidate(keywordBreakdown: unknown): boolean {
  const score = keywordBreakdown as JobScore | null;
  return score?.meetsMinimums === true && score.excluded !== true && score.remoteFiltered !== true;
}

/**
 * Re-ranks the workspace's inbox via the LLM, layered on top of the deterministic keyword
 * score: no key configured keeps AI off entirely (`skipped_no_key`); no candidate clears the
 * keyword-scoring gates (`skipped_empty`) — critically, this check runs *before* calling
 * `rerankJobs`, since handing it an empty job list would burn through every fallback model
 * for nothing. A model failure leaves the keyword order standing (`failed`) rather than
 * retrying inline — the next cron pass tries again.
 */
export async function runRerankOnce(db: Db, workspaceId: string, config: AppConfig): Promise<RerankSummary> {
  const apiKey = config.openrouterApiKey;
  // Replay mode reads a committed fixture and never opens a socket, so it is
  // the one mode that works without a key — the hosted demo runs exactly that
  // way (`AI_MODE=replay`, no key deployed, spec P6 §3).
  if (!apiKey && config.aiMode !== "replay") return { status: "skipped_no_key", reranked: 0 };

  const profile = await getScoringProfile(db, workspaceId);
  const inbox = await listInboxJobs(db, workspaceId);

  const candidates = inbox
    .filter((job) => isRerankCandidate(job.keywordBreakdown))
    // The id tie-break is load-bearing, not tidiness. `listInboxJobs` orders on
    // `llm_score DESC NULLS LAST, keyword_score DESC` with no further key, so
    // Postgres returns equal-scoring listings in whatever order it read them —
    // measured different between two runs over the *same* rows. That decides
    // both which listings survive `topNForLlm` and the order they appear in the
    // prompt, and the prompt is an AI replay fixture's cache key: without this,
    // a recorded re-rank misses at random and the demo's keyless re-rank
    // silently degrades to `replay_miss`.
    .sort((a, b) => (b.keywordScore ?? 0) - (a.keywordScore ?? 0) || a.id.localeCompare(b.id))
    .slice(0, profile.topNForLlm);

  if (candidates.length === 0) return { status: "skipped_empty", reranked: 0 };

  const companyIds = [...new Set(candidates.map((job) => job.companyId).filter((id): id is string => id !== null))];
  const companyRows = companyIds.length > 0
    ? await db.select({ id: companies.id, name: companies.name }).from(companies).where(inArray(companies.id, companyIds))
    : [];
  const companyNameById = new Map(companyRows.map((row) => [row.id, row.name]));

  const inputs: RerankJobInput[] = candidates.map((job) => ({
    id: job.id,
    title: job.title,
    companyName: (job.companyId && companyNameById.get(job.companyId)) || "Unknown",
    location: job.location,
    remoteMode: job.remoteMode,
    keywordScore: job.keywordScore,
    descriptionSnippet: stripHtml(job.descriptionMd ?? "").slice(0, SNIPPET_LENGTH),
  }));

  // The replay wrapper keys on the prompt, which quotes each listing's uuid —
  // which is why the demo seed pins those ids (see `demoJobId`).
  const result = await withReplay<RerankResult>({
    mode: config.aiMode,
    store: makeFsReplayStore(config.aiReplayDir),
    taskId: REPLAY_TASK_ID,
    prompt: buildRerankPrompt(inputs, profile),
    schema: rerankResultSchema,
    run: () => {
      // Unreachable without a key: replay never calls `run`, and every other
      // mode returned `skipped_no_key` above.
      if (!apiKey) throw new Error("rerank: no api key outside replay mode");
      return rerankJobs(inputs, profile, { models: config.aiFastModels, apiKey });
    },
  });

  if (!result.ok || !result.value) {
    console.error(
      `[rerank] failed for workspace ${workspaceId}: ${result.error ?? "unknown_error"} (model=${result.model})`,
    );
    return { status: "failed", reranked: 0 };
  }

  const reranked = await applyRerank(db, workspaceId, result.value.results);
  return { status: "ok", reranked };
}
