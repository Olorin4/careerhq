import type { WorkspaceKind } from "@careerhq/contracts";
import { loadConfig } from "@careerhq/config";
// `DbOrTx`, not `Db`: the bootstrap branch can only be tested by first
// establishing that no sandbox workspace exists, and doing that on a shared dev
// database is only safe inside a transaction that rolls back.
import {
  DEMO_WORKSPACE_NAME, lockDemoSeed, workspaces, type Db, type DbOrTx, type Tx, type Workspace,
} from "@careerhq/db";
import { and, asc, eq, type SQL } from "drizzle-orm";

export interface GetActiveWorkspaceOptions {
  /** Defaults to `loadConfig().demoMode` — pass explicitly only in tests. */
  demoMode?: boolean;
}

/**
 * The resolution half of {@link getActiveWorkspace} with no bootstrap: the one
 * workspace this install binds to, or none. Kept separate because
 * {@link readWorkspaceSnapshot} must be able to ask the question without being
 * able to answer it by writing.
 */
function selectActive(on: DbOrTx, demoMode: boolean): Promise<Workspace[]> {
  const kind: WorkspaceKind = demoMode ? "sandbox" : "personal";
  const match: SQL | undefined = demoMode
    ? and(eq(workspaces.kind, kind), eq(workspaces.name, DEMO_WORKSPACE_NAME))
    : eq(workspaces.kind, kind);
  return on
    .select()
    .from(workspaces)
    .where(match)
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
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

  const select = (on: DbOrTx): Promise<Workspace[]> => selectActive(on, demoMode);

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

/**
 * Runs `read`'s statements against ONE snapshot of the database, so that what
 * a page renders is a state that really existed.
 *
 * Every dashboard page is two or more statements — resolve the workspace, then
 * list or count what belongs to it — and the six-hourly demo reset is a single
 * transaction that DELETEs its workspace (cascading every row under it) and
 * re-INSERTs the lot under a NEW id. The data is therefore never half-built,
 * but a page's reads can still straddle its commit: the first returns the old
 * workspace, the reset commits, and the count that follows finds nothing under
 * an id that no longer exists. The visitor is shown an empty demo — a moment
 * that never existed. The P6 audit measured that at 3 reads in 1,549.
 *
 * `repeatable read` is exactly the fix: every statement inside reads the same
 * snapshot, taken at the first of them, so the workspace and its rows are the
 * same generation or none of them are. It is not a lock and holds nothing back
 * — the reset commits underneath it as usual — and a `read only` REPEATABLE
 * READ transaction cannot raise a serialization failure, so there is nothing to
 * retry.
 *
 * `read only` is the second half, and is about scope rather than isolation: a
 * page's reads are supposed to agree with each other, NOT to hold a transaction
 * open across whatever else a request does. A write that finds its way in here
 * is refused by Postgres rather than quietly extending this transaction's life.
 */
export function readInOneSnapshot<T>(db: Db, read: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(read, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/**
 * {@link readInOneSnapshot} with the workspace resolved inside it: the shape
 * every dashboard page wants, since "which workspace" is the first of the two
 * statements that could straddle.
 *
 * The bootstrap is deliberately OUTSIDE the snapshot. `getActiveWorkspace`
 * creates the workspace when it finds none, under `DEMO_SEED_LOCK_KEY` and
 * re-reading under that lock — and a re-read inside a REPEATABLE READ snapshot
 * cannot see the commit that lock just waited for, which is precisely how two
 * demo workspaces got created before `d008a30`. So the snapshot answers first,
 * and only a genuinely empty database falls through to the bootstrap and one
 * retry.
 */
export async function readWorkspaceSnapshot<T>(
  db: Db,
  read: (tx: Tx, workspace: Workspace) => Promise<T>,
  opts: GetActiveWorkspaceOptions = {},
): Promise<T> {
  const demoMode = opts.demoMode ?? loadConfig().demoMode;

  const attempt = (): Promise<{ value: T } | null> => readInOneSnapshot(db, async (tx) => {
    const [workspace] = await selectActive(tx, demoMode);
    if (!workspace) return null;
    return { value: await read(tx, workspace) };
  });

  const first = await attempt();
  if (first) return first.value;

  // No workspace in that snapshot. On a running install this cannot happen —
  // the reset's DELETE and INSERT commit together, so there is no committed
  // state without one — which leaves the first page load against a fresh
  // database. Bootstrapping it needs to write, and to write under the seed
  // lock, so it happens in its own transaction and the snapshot is re-taken.
  await getActiveWorkspace(db, { demoMode });
  const second = await attempt();
  if (second) return second.value;
  throw new Error("failed to bootstrap workspace");
}
