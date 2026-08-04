import type { WorkspaceKind } from "@careerhq/contracts";
import { loadConfig } from "@careerhq/config";
// `DbOrTx`, not `Db`: the bootstrap branch can only be tested by first
// establishing that no sandbox workspace exists, and doing that on a shared dev
// database is only safe inside a transaction that rolls back.
import { DEMO_WORKSPACE_NAME, workspaces, type DbOrTx, type Workspace } from "@careerhq/db";
import { and, asc, eq } from "drizzle-orm";

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
 * not an empty one; in demo mode it is `DEMO_WORKSPACE_NAME`, bootstrapped the
 * same way the first time it does not exist yet.
 *
 * Demo mode matches on the NAME as well as the kind. `seedDemoWorkspace` drops
 * and recreates its workspace on every reset, so the demo row is always the
 * *newest* sandbox workspace — matching on kind alone would silently resolve
 * any older sandbox row instead (the e2e suites own several, and so might a
 * self-hoster), and the demo would serve an empty workspace.
 */
export async function getActiveWorkspace(db: DbOrTx, opts: GetActiveWorkspaceOptions = {}): Promise<Workspace> {
  const demoMode = opts.demoMode ?? loadConfig().demoMode;
  const kind: WorkspaceKind = demoMode ? "sandbox" : "personal";
  const name = demoMode ? DEMO_WORKSPACE_NAME : "My workspace";

  const existing = await db
    .select()
    .from(workspaces)
    .where(demoMode ? and(eq(workspaces.kind, kind), eq(workspaces.name, name)) : eq(workspaces.kind, kind))
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
  if (existing[0]) return existing[0];
  const created = await db.insert(workspaces).values({ name, kind }).returning();
  if (!created[0]) throw new Error("failed to bootstrap workspace");
  return created[0];
}
