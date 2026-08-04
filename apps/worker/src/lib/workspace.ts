import type { WorkspaceKind } from "@careerhq/contracts";
import { loadConfig } from "@careerhq/config";
import { and, asc, eq } from "drizzle-orm";
import { DEMO_WORKSPACE_NAME, workspaces, type Db } from "@careerhq/db";

export interface GetPersonalWorkspaceIdOptions {
  /** Defaults to `loadConfig().demoMode` — pass explicitly only in tests. */
  demoMode?: boolean;
}

/**
 * Resolves the single-tenant app's active workspace id for scheduled jobs:
 * personal normally, or sandbox in demo mode (spec P6 §3) — the same switch
 * apps/web/src/lib/workspace.ts's `getActiveWorkspace` uses, so the reset/sync
 * jobs operate on the same workspace the web app serves. Mirrors that
 * resolver's predicate exactly — including the demo-mode name match, without
 * which a reset (which drops and recreates the demo workspace) could leave the
 * worker on a different, older sandbox row than the one the web app serves —
 * without importing across the apps/packages boundary. The worker only needs
 * the selection, not web's bootstrap-on-missing behavior, so it returns null
 * rather than creating a workspace when none exists yet (e.g. before the seed,
 * or before the demo reset job has run in demo mode).
 */
export async function getPersonalWorkspaceId(db: Db, opts: GetPersonalWorkspaceIdOptions = {}): Promise<string | null> {
  const demoMode = opts.demoMode ?? loadConfig().demoMode;
  const kind: WorkspaceKind = demoMode ? "sandbox" : "personal";
  const [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(demoMode
      ? and(eq(workspaces.kind, kind), eq(workspaces.name, DEMO_WORKSPACE_NAME))
      : eq(workspaces.kind, kind))
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
  return ws?.id ?? null;
}
