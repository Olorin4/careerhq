import { inArray } from "drizzle-orm";
import type { AppConfig } from "@careerhq/config";
import { applyRerank, companies, getScoringProfile, listInboxJobs, type Db } from "@careerhq/db";
import type { JobScore } from "@careerhq/core";
import { rerankJobs, type RerankJobInput } from "@careerhq/ai";
import { stripHtml } from "@careerhq/ingest";

const SNIPPET_LENGTH = 600;

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
  if (!config.openrouterApiKey) return { status: "skipped_no_key", reranked: 0 };

  const profile = await getScoringProfile(db, workspaceId);
  const inbox = await listInboxJobs(db, workspaceId);

  const candidates = inbox
    .filter((job) => isRerankCandidate(job.keywordBreakdown))
    .sort((a, b) => (b.keywordScore ?? 0) - (a.keywordScore ?? 0))
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

  const result = await rerankJobs(inputs, profile, {
    models: config.aiFastModels,
    apiKey: config.openrouterApiKey,
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
