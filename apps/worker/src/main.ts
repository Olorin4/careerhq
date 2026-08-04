import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PgBoss from "pg-boss";
import { loadConfig } from "@careerhq/config";
import { createDb } from "@careerhq/db";
import { runDemoResetOnce } from "./jobs/demo-reset.js";
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
const DEMO_RESET_QUEUE = "demo.reset";
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

// The demo reset (spec P6 §3) is registered ONLY in demo mode. It deletes and
// rebuilds a whole workspace, so a personal deployment must never so much as
// have the queue: `createQueue`/`schedule` are inside the branch too, not just
// the consumer, because a scheduled row left behind by a one-off DEMO_MODE=true
// run would keep firing against a worker that no longer expects it.
if (config.demoMode) {
  await boss.createQueue(DEMO_RESET_QUEUE);
  await boss.schedule(DEMO_RESET_QUEUE, config.demoResetCron);
  await boss.work(DEMO_RESET_QUEUE, async () => {
    const result = await runDemoResetOnce(db, config);
    console.log(`[worker] ${DEMO_RESET_QUEUE}`, result);
  });
}

// INTENTIONALLY NOT REGISTERED (spec §11).
//
// `runCaptureJob`/`runSubmitJob` (./jobs/autoapply.ts) and their tests stay in
// the tree for P6's queue path, but neither `autoapply.capture` nor
// `autoapply.submit` gets a `createQueue`/`work` pair here yet.
//
// `runSubmitJob` performs a real `fillAndSubmit` — an externally-mutating
// channel — and spec §11 is normative that EVERY such channel passes the three
// layers: the env gate, the sandbox host allow-list, and a single-use
// confirmation token bound to the payload fingerprint. Today those three live
// exclusively in `apps/web`'s `confirmAndSubmitSite`, on the assumption that
// "the gate already ran before this job was enqueued" — and nothing in the repo
// enqueues either queue, so registering a live consumer bought no capability
// and left an ungated live-submit path reachable by anything that could write a
// pg-boss row.
//
// Register them when the gate runs INSIDE the jobs (P6), not before.
const UNREGISTERED_QUEUES = [AUTOAPPLY_CAPTURE_QUEUE, AUTOAPPLY_SUBMIT_QUEUE] as const;

console.log(
  `[worker] started; queues registered${config.demoMode ? ` (demo mode: ${DEMO_RESET_QUEUE} on "${config.demoResetCron}")` : ""}`
  + ` (not registered: ${UNREGISTERED_QUEUES.join(", ")} — ungated until P6)`,
);
