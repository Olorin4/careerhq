/**
 * Records the hosted demo's *worker-side* replay fixtures (spec P6 §3, Task 8):
 * one discovery re-rank and one reply classification, each against the demo
 * seed's exact prompt. See `apps/web/scripts/record-demo-fixtures.ts` for the
 * three generation fixtures and for why any of this is pinned.
 *
 * Run it with a real key (never in CI), from the repo root:
 *
 *   DATABASE_URL=postgres://careerhq:careerhq@localhost:5433/careerhq \
 *   OPENROUTER_API_KEY=sk-or-... AI_MODE=record \
 *   pnpm --filter @careerhq/worker exec tsx scripts/record-demo-fixtures.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { loadConfig } from "@careerhq/config";
import { classifyReplyResultSchema, type ClassifyReplyResult } from "@careerhq/contracts";
import {
  buildClassifyPrompt, makeFsReplayStore, classifyReply, withReplay, type ClassifyReplyInput,
} from "@careerhq/ai";
import {
  applications, companies, createDb, emailMessages, generateMasterKeyB64, jobs, seedDemoWorkspace,
} from "@careerhq/db";
import { runRerankOnce } from "../src/jobs/rerank.js";

const config = loadConfig();

if (config.aiMode !== "record") {
  throw new Error(`AI_MODE must be "record" to record fixtures (got "${config.aiMode}")`);
}
const apiKey = config.openrouterApiKey;
if (apiKey === null) throw new Error("OPENROUTER_API_KEY must be set to record fixtures");

const db = createDb(config.databaseUrl);

const { workspaceId } = await seedDemoWorkspace(db, {
  fileStorageDir: mkdtempSync(path.join(tmpdir(), "careerhq-record-")),
  // The seeded mailbox — and so the inbound reply this records a
  // classification for — only exists when a master key can seal its
  // credential. The hosted demo deploys without one, so this fixture serves a
  // self-hoster who runs the demo seed WITH a key, not the public demo itself.
  masterKeyB64: await generateMasterKeyB64(),
});

// --- discovery re-rank ------------------------------------------------------
// Recorded by running the real job, so the prompt is byte-for-byte the one the
// worker's ingest cron builds — including each listing's pinned uuid.
const rerank = await runRerankOnce(db, workspaceId, config);
console.log(`recorded re-rank: status=${rerank.status} reranked=${rerank.reranked}`);

// --- reply classification ---------------------------------------------------
// The seeded inbound reply, and the application context `classifyAndSuggest`
// would load for it (apps/worker/src/jobs/email-sync.ts). Kept in step with
// that function by hand: the two must build the same `ClassifyReplyInput` or
// the recorded key will not be the one the job looks up.
const [reply] = await db.select({
  subject: emailMessages.subject,
  snippet: emailMessages.snippet,
  applicationId: emailMessages.applicationId,
}).from(emailMessages)
  .where(and(
    eq(emailMessages.workspaceId, workspaceId),
    eq(emailMessages.direction, "inbound"),
    isNotNull(emailMessages.applicationId),
  ))
  .orderBy(desc(emailMessages.receivedAt));
if (!reply?.applicationId) throw new Error("no seeded inbound reply to classify");

const [context] = await db.select({
  state: applications.state, jobTitle: jobs.title, companyName: companies.name,
}).from(applications)
  .innerJoin(jobs, eq(jobs.id, applications.jobId))
  .leftJoin(companies, eq(companies.id, jobs.companyId))
  .where(eq(applications.id, reply.applicationId));
if (!context) throw new Error("no application context for the seeded reply");

const input: ClassifyReplyInput = {
  subject: reply.subject,
  snippet: reply.snippet,
  companyName: context.companyName ?? "Unknown",
  jobTitle: context.jobTitle,
  applicationState: context.state,
};

const classified = await withReplay<ClassifyReplyResult>({
  mode: config.aiMode,
  store: makeFsReplayStore(config.aiReplayDir),
  taskId: "classify-reply",
  prompt: buildClassifyPrompt(input),
  schema: classifyReplyResultSchema,
  run: () => classifyReply(input, { models: config.aiFastModels, apiKey }),
});
console.log(
  `recorded classification: ok=${classified.ok} value=${JSON.stringify(classified.value)}`,
);

await db.$client.end();
if (rerank.status !== "ok" || !classified.ok) process.exitCode = 1;
