import type { WorkspaceKind } from "@careerhq/contracts";
import { loadConfig } from "@careerhq/config";
import { asc, eq } from "drizzle-orm";
import { workspaces, type Db } from "@careerhq/db";

export interface GetPersonalWorkspaceIdOptions {
  /** Defaults to `loadConfig().demoMode` — pass explicitly only in tests. */
  demoMode?: boolean;
}

/**
 * Resolves the single-tenant app's active workspace id for scheduled jobs:
 * personal normally, or sandbox in demo mode (spec P6 §3) — the same switch
 * apps/web/src/lib/workspace.ts's `getActiveWorkspace` uses, so the reset/sync
 * jobs operate on the same workspace the web app serves. Mirrors that
 * resolver's ordering rule (oldest workspace of the target kind, id as
 * tiebreaker) without importing across the apps/packages boundary — the
 * worker only needs the selection, not web's bootstrap-on-missing behavior,
 * so it returns null rather than creating a workspace when none exists yet
 * (e.g. before the seed, or before the demo seed job has run in demo mode).
 */
export async function getPersonalWorkspaceId(db: Db, opts: GetPersonalWorkspaceIdOptions = {}): Promise<string | null> {
  const demoMode = opts.demoMode ?? loadConfig().demoMode;
  const kind: WorkspaceKind = demoMode ? "sandbox" : "personal";
  const [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.kind, kind))
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
  return ws?.id ?? null;
}
