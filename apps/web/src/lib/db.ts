import { createDb, type Db } from "@careerhq/db";
import { loadConfig } from "@careerhq/config";

let db: Db | undefined;
export function getDb(): Db {
  if (!db) db = createDb(loadConfig().databaseUrl);
  return db;
}
