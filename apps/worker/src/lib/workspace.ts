import { asc, eq } from "drizzle-orm";
import { workspaces, type Db } from "@careerhq/db";

/**
 * Resolves the single-tenant app's personal workspace for scheduled jobs. Mirrors the
 * ordering rule in apps/web/src/lib/workspace.ts (oldest personal workspace, id as
 * tiebreaker) without importing across the apps/packages boundary — the worker only needs
 * the selection, not web's bootstrap-on-missing behavior, so it returns null rather than
 * creating a workspace when none exists yet (e.g. before the seed has run).
 */
export async function getPersonalWorkspaceId(db: Db): Promise<string | null> {
  const [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.kind, "personal"))
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
  return ws?.id ?? null;
}
