import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PgBoss from "pg-boss";
import { loadConfig } from "@careerhq/config";

// node/tsx load no .env of their own, and the repo keeps a single .env at the
// root (absent in the container, where compose supplies the environment).
// Resolved from this module, so it works from both src/ and dist/. Variables
// already exported in the shell win over the file.
const envFile = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..", ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig();
const boss = new PgBoss(config.databaseUrl);

boss.on("error", (err) => console.error("[worker] pg-boss error", err));

await boss.start();
await boss.createQueue("maintenance.heartbeat");
await boss.schedule("maintenance.heartbeat", "*/5 * * * *");
await boss.work("maintenance.heartbeat", async () => {
  console.log("[worker] heartbeat", new Date().toISOString());
});
console.log("[worker] started; queues registered");
