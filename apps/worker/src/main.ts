import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PgBoss from "pg-boss";
import { loadConfig } from "@careerhq/config";
import { createDb } from "@careerhq/db";
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

console.log("[worker] started; queues registered");
