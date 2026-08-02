import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Db = ReturnType<typeof createDb>;

/**
 * The transaction handle drizzle hands to a `db.transaction` callback. It is
 * not a `Db` (no `$client`, no nested pool), so repo helpers that must be
 * callable both standalone and from inside someone else's transaction take
 * `DbOrTx` instead.
 */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;
export function createDb(url: string) {
  const sql = postgres(url, { max: 10 });
  return drizzle(sql, { schema, casing: "snake_case" });
}
