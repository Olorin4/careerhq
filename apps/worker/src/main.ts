import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PgBoss from "pg-boss";
import { loadConfig } from "@careerhq/config";
import { createDb } from "@careerhq/db";
import { runCaptureJob, runSubmitJob, type CaptureJobData, type SubmitJobData } from "./jobs/autoapply.js";
import { runEmailSyncOnce } from "./jobs/email-sync.js";
import { runIngestOnce } from "./jobs/ingest.js";
import { runRerankOnce } from "./jobs/rerank.js";
import { getPersonalWorkspaceId } from "./lib/workspace.js";

// node/tsx load no .env of their own, and the repo keeps a single .env at the
// root (absent in the container, where compose supplies the environment).
// Resolved from this module, so it works from both src/ and dist/. Variables
// already exported in the shell win over the file.
const envFile = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..", ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const boss = new PgBoss(config.databaseUrl);
const db = createDb(config.databaseUrl);

const INGEST_QUEUE = "discovery.ingest";
const RERANK_QUEUE = "discovery.rerank";
const EMAIL_SYNC_QUEUE = "email.sync";
const AUTOAPPLY_CAPTURE_QUEUE = "autoapply.capture";
const AUTOAPPLY_SUBMIT_QUEUE = "autoapply.submit";

boss.on("error", (err) => console.error("[worker] pg-boss error", err));

await boss.start();
await boss.createQueue("maintenance.heartbeat");
await boss.schedule("maintenance.heartbeat", "*/5 * * * *");
await boss.work("maintenance.heartbeat", async () => {
  console.log("[worker] heartbeat", new Date().toISOString());
});

await boss.createQueue(INGEST_QUEUE);
await boss.schedule(INGEST_QUEUE, config.ingestCron);
await boss.work(INGEST_QUEUE, async () => {
  const workspaceId = await getPersonalWorkspaceId(db);
  if (!workspaceId) {
    console.log(`[worker] ${INGEST_QUEUE}: no personal workspace yet, skipping`);
    return;
  }
  const summary = await runIngestOnce(db, workspaceId);
  console.log(`[worker] ${INGEST_QUEUE}`, summary);
  // Singleton key so a slow rerank pass can't pile up behind repeated ingest runs.
  await boss.send(RERANK_QUEUE, {}, { singletonKey: "rerank" });
});

await boss.createQueue(RERANK_QUEUE);
await boss.work(RERANK_QUEUE, async () => {
  const workspaceId = await getPersonalWorkspaceId(db);
  if (!workspaceId) {
    console.log(`[worker] ${RERANK_QUEUE}: no personal workspace yet, skipping`);
    return;
  }
  const result = await runRerankOnce(db, workspaceId, config);
  console.log(`[worker] ${RERANK_QUEUE}`, result);
});

await boss.createQueue(EMAIL_SYNC_QUEUE);
await boss.schedule(EMAIL_SYNC_QUEUE, config.emailSyncCron);
await boss.work(EMAIL_SYNC_QUEUE, async () => {
  const workspaceId = await getPersonalWorkspaceId(db);
  if (!workspaceId) {
    console.log(`[worker] ${EMAIL_SYNC_QUEUE}: no personal workspace yet, skipping`);
    return;
  }
  const summary = await runEmailSyncOnce(db, workspaceId, config);
  console.log(`[worker] ${EMAIL_SYNC_QUEUE}`, summary);
});

// No `schedule` for either queue — unlike ingest/rerank/email-sync, these run
// on demand, one job per attempt, enqueued by whatever in `apps/web` decides
// an attempt is ready to be captured or submitted (spec §10).
await boss.createQueue(AUTOAPPLY_CAPTURE_QUEUE);
await boss.work<CaptureJobData>(AUTOAPPLY_CAPTURE_QUEUE, async (jobs) => {
  for (const job of jobs) {
    await runCaptureJob(db, config, job.data);
    console.log(`[worker] ${AUTOAPPLY_CAPTURE_QUEUE} attempt=${job.data.attemptId}`);
  }
});

await boss.createQueue(AUTOAPPLY_SUBMIT_QUEUE);
await boss.work<SubmitJobData>(AUTOAPPLY_SUBMIT_QUEUE, async (jobs) => {
  for (const job of jobs) {
    await runSubmitJob(db, config, job.data);
    console.log(`[worker] ${AUTOAPPLY_SUBMIT_QUEUE} attempt=${job.data.attemptId}`);
  }
});

console.log("[worker] started; queues registered");
