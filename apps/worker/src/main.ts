import PgBoss from "pg-boss";
import { loadConfig } from "@careerhq/config";

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
