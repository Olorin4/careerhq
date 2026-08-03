import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import { companies } from "../schema/index.js";

/**
 * Insert-or-select against `companies_workspace_name` (migration 0001). Takes
 * `DbOrTx` so callers already inside a transaction — `createApplication` — get
 * the same conflict-safe semantics without opening a nested one.
 */
export async function getOrCreateCompany(db: DbOrTx, workspaceId: string, name: string): Promise<string> {
  await db.insert(companies).values({ workspaceId, name })
    .onConflictDoNothing({ target: [companies.workspaceId, companies.name] });
  const [company] = await db.select({ id: companies.id }).from(companies)
    .where(and(eq(companies.workspaceId, workspaceId), eq(companies.name, name)));
  return company!.id;
}
