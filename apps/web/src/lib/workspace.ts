import type { WorkspaceKind } from "@careerhq/contracts";
import { loadConfig } from "@careerhq/config";
import { workspaces, type Db, type Workspace } from "@careerhq/db";
import { asc, eq } from "drizzle-orm";

export interface GetActiveWorkspaceOptions {
  /** Defaults to `loadConfig().demoMode` — pass explicitly only in tests. */
  demoMode?: boolean;
}

/**
 * The single-tenant app binds to one workspace: the personal one normally, or
 * the sandbox one in demo mode (spec P6 §3) — the switch that also arms the
 * sandbox adapter blocks in `email-submission.ts`/`site-submission.ts`, which
 * key off `workspace.kind === "sandbox"`. Several paths can create the
 * personal workspace (this bootstrap, `pnpm seed`'s "Alex Demo", integration
 * tests), so the selection must be deterministic within a kind: always the
 * oldest workspace of that kind, with the id as a tiebreaker. Following the
 * quickstart (seed, then `next dev`) that is the seeded "Alex Demo" workspace,
 * not an empty one; in demo mode it is "CareerHQ Demo", bootstrapped the same
 * way the first time no sandbox workspace exists yet.
 */
export async function getActiveWorkspace(db: Db, opts: GetActiveWorkspaceOptions = {}): Promise<Workspace> {
  const demoMode = opts.demoMode ?? loadConfig().demoMode;
  const kind: WorkspaceKind = demoMode ? "sandbox" : "personal";
  const name = demoMode ? "CareerHQ Demo" : "My workspace";

  const existing = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.kind, kind))
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
  if (existing[0]) return existing[0];
  const created = await db.insert(workspaces).values({ name, kind }).returning();
  if (!created[0]) throw new Error("failed to bootstrap workspace");
  return created[0];
}
