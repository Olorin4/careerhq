import type { WorkspaceKind } from "@careerhq/contracts";
import { loadConfig } from "@careerhq/config";
// `DbOrTx`, not `Db`: the bootstrap branch can only be tested by first
// establishing that no sandbox workspace exists, and doing that on a shared dev
// database is only safe inside a transaction that rolls back.
import {
  DEMO_WORKSPACE_NAME, lockDemoSeed, workspaces, type DbOrTx, type Workspace,
} from "@careerhq/db";
import { and, asc, eq, type SQL } from "drizzle-orm";

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
 * Demo mode matches on the NAME as well as the kind, because `seedDemoWorkspace`
 * drops and recreates its workspace on every reset: matching on kind alone would
 * silently resolve any older sandbox row instead (the e2e suites own several,
 * and so might a self-hoster), and the demo would serve an empty workspace.
 *
 * The demo branch is the one that can RACE the seed, so its bootstrap takes
 * `DEMO_SEED_LOCK_KEY` — the same lock `seedDemoWorkspace` holds for its whole
 * transaction — and re-reads under it (P6 final review, A3). Without that:
 *
 *   - the seed's DELETE+INSERT is atomic, so a request arriving mid-reset sees
 *     the OLD demo row and never bootstraps. That case was already safe; and
 *   - on a FRESH database, where there is no old row, a request arriving while
 *     the seed transaction is still open sees nothing at all and inserts an
 *     empty demo workspace of its own. Two rows then match the predicate and
 *     the `createdAt` tie-break below decides which one the demo serves for the
 *     next six hours. Migration `0006` moved that default from `now()`
 *     (transaction start — so the seed's row was always the older one, and the
 *     empty row could never win) to `clock_timestamp()`, which re-opened the
 *     window between the seed's own DELETE and INSERT statements.
 *
 * Taking the lock removes the race rather than re-tuning the tie-break: the
 * bootstrap waits for an in-flight seed and then finds its row, and a seed that
 * starts afterwards deletes whatever the bootstrap made. Which is why the
 * ordering below is only a determinism rule for duplicates an OLDER version may
 * have left behind — the demo branch can no longer create one, and a reset
 * clears any that exist.
 */
export async function getActiveWorkspace(db: DbOrTx, opts: GetActiveWorkspaceOptions = {}): Promise<Workspace> {
  const demoMode = opts.demoMode ?? loadConfig().demoMode;
  const kind: WorkspaceKind = demoMode ? "sandbox" : "personal";
  const name = demoMode ? DEMO_WORKSPACE_NAME : "My workspace";
  const match: SQL | undefined = demoMode
    ? and(eq(workspaces.kind, kind), eq(workspaces.name, name))
    : eq(workspaces.kind, kind);

  const select = (on: DbOrTx): Promise<Workspace[]> => on
    .select()
    .from(workspaces)
    .where(match)
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);

  const existing = await select(db);
  if (existing[0]) return existing[0];

  if (!demoMode) {
    const created = await db.insert(workspaces).values({ name, kind }).returning();
    if (!created[0]) throw new Error("failed to bootstrap workspace");
    return created[0];
  }

  return db.transaction(async (tx) => {
    // Before the re-read, not after: the lock is what makes the re-read mean
    // anything, and it is always taken before any row lock so every holder
    // orders its locks the same way (see DEMO_SEED_LOCK_KEY's own note).
    await lockDemoSeed(tx);
    const seeded = await select(tx);
    if (seeded[0]) return seeded[0];
    const created = await tx.insert(workspaces).values({ name, kind }).returning();
    if (!created[0]) throw new Error("failed to bootstrap workspace");
    return created[0];
  });
}
