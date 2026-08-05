import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  DEMO_WORKSPACE_NAME, createApplication, createDb, listApplications, lockDemoSeed, workspaces,
  type Db, type DbOrTx, type Workspace,
} from "@careerhq/db";
import { readInOneSnapshot, readWorkspaceSnapshot } from "./workspace.js";

/**
 * The straddle probe below drives real resets and 1,549 real reads. That is
 * seconds of work, not milliseconds, and it must not be cut short by a default
 * timeout on a loaded box — a probe that times out proves nothing.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

let db: Db;

/**
 * The probe owns a workspace of its own, and its "reset" below rebuilds THAT
 * one — never the demo workspace the six-hourly reset owns.
 *
 * Not squeamishness: `apps/worker`'s `demo-reset` suite runs in parallel with
 * this file (see the note in `workspace.test.ts`) and asserts row counts on the
 * demo workspace between its own resets, unlocked. A second process deleting
 * that workspace mid-assertion would make that suite fail for reasons that have
 * nothing to do with it — the exact cross-suite race this repo has already had
 * to fix twice. The defect under test is not specific to the demo's name: it is
 * "resolve a workspace by predicate, then read what hangs off it, in two
 * statements", and this workspace reproduces that with nobody else watching.
 */
const PROBE_WORKSPACE = `t-straddle-${process.pid}`;

/** What each generation of the probe workspace holds — the "applications" a reader counts. */
const APPLICATIONS_PER_GENERATION = 6;

beforeAll(async () => {
  if (!url) return;
  db = createDb(url);
});

afterAll(async () => {
  if (!url) return;
  await db.delete(workspaces).where(eq(workspaces.name, PROBE_WORKSPACE));
  await db.$client.end();
});

/** The probe's half of a page's first statement: resolve a workspace by predicate. */
function resolveProbeWorkspace(on: DbOrTx): Promise<Workspace[]> {
  return on.select().from(workspaces)
    .where(and(eq(workspaces.kind, "personal"), eq(workspaces.name, PROBE_WORKSPACE)))
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
}

/**
 * The demo reset in miniature, and in the one shape that matters: a SINGLE
 * transaction that deletes the workspace (cascading everything under it) and
 * rebuilds it under a NEW id. Committed, so a reader on either side of it sees
 * a complete workspace — which is exactly why the defect is invisible to
 * anything but a reader that spans the commit.
 */
async function resetProbeWorkspace(): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.delete(workspaces).where(eq(workspaces.name, PROBE_WORKSPACE));
    const [workspace] = await tx.insert(workspaces)
      .values({ name: PROBE_WORKSPACE, kind: "personal" }).returning();
    for (let i = 0; i < APPLICATIONS_PER_GENERATION; i += 1) {
      await createApplication(tx, {
        workspaceId: workspace!.id, companyName: `Straddle Co ${i}`, jobTitle: `Role ${i}`,
      });
    }
    return workspace!.id;
  });
}

/** A page load as it was written before this fix: two statements, two snapshots. */
async function twoStatementRead(pauseMs = 0): Promise<number | null> {
  const [workspace] = await resolveProbeWorkspace(db);
  if (!workspace) return null;
  if (pauseMs) await sleep(pauseMs);
  return (await listApplications(db, workspace.id)).length;
}

/** The same page load through the fix: two statements, one snapshot. */
async function oneSnapshotRead(pauseMs = 0): Promise<number | null> {
  return readInOneSnapshot(db, async (tx) => {
    const [workspace] = await resolveProbeWorkspace(tx);
    if (!workspace) return null;
    if (pauseMs) await sleep(pauseMs);
    return (await listApplications(tx, workspace.id)).length;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A read that saw no workspace at all, or a workspace with none of the
 * applications every generation of it has, is a straddle: a moment that never
 * existed in the database.
 */
function straddled(observed: number | null): boolean {
  return observed === null || observed === 0;
}

d("a page's reads across a reset commit", () => {
  // The window, widened. The straddle is a race, and a race reproduced 3 times
  // in 1,549 is a poor test: it would pass with the fix reverted 99.8% of the
  // time. Pausing between the two statements makes the reset's commit land
  // inside the window every time, so this test states the property outright —
  // and the pause is on BOTH readers, so the only difference between them is
  // the snapshot.
  it("two statements see the reset; one snapshot does not", async () => {
    await resetProbeWorkspace();

    // The reader resolves the workspace, the reset commits underneath it, and
    // the reader then counts what belongs to the id it resolved.
    const naive = twoStatementRead(600);
    await sleep(100);
    await resetProbeWorkspace();
    expect(await naive).toBe(0);

    // Same choreography, same window, one snapshot: the rows the reset deleted
    // are still visible to a snapshot taken before it committed, so the count
    // is the generation the reader resolved.
    const snapshot = oneSnapshotRead(600);
    await sleep(100);
    await resetProbeWorkspace();
    expect(await snapshot).toBe(APPLICATIONS_PER_GENERATION);
  });

  // The measurement the roadmap's "3 of 1,549" came from, re-run against both
  // readers: reads polled concurrently while resets run, with no artificial
  // window at all. The naive number is the baseline (it is a race, so it is
  // allowed to be small — 3 in 1,549 was the original); the fixed one must be
  // zero, and it is zero by construction rather than by luck.
  it("polls 1,549 reads through repeated resets and observes no empty workspace", async () => {
    const READS = 1549;
    const CONCURRENCY = 8;

    async function poll(read: (pauseMs?: number) => Promise<number | null>): Promise<number> {
      await resetProbeWorkspace();
      let done = false;
      let straddles = 0;

      const resetting = (async () => {
        while (!done) await resetProbeWorkspace();
      })();

      let issued = 0;
      const readers = Array.from({ length: CONCURRENCY }, async () => {
        while (issued < READS) {
          issued += 1;
          if (straddled(await read())) straddles += 1;
        }
      });
      await Promise.all(readers);
      done = true;
      await resetting;
      return straddles;
    }

    const naiveStraddles = await poll(twoStatementRead);
    const snapshotStraddles = await poll(oneSnapshotRead);

    console.log(
      `[straddle probe] ${READS} reads: two statements saw ${naiveStraddles} empty workspaces, `
      + `one snapshot saw ${snapshotStraddles}`,
    );
    expect(snapshotStraddles).toBe(0);
  });
});

d("readWorkspaceSnapshot", () => {
  /**
   * Resolved under the demo seed's advisory lock, exactly as `workspace.test.ts`
   * does and for the same reason: the worker's reset suite is deleting and
   * recreating this row in parallel with this file. This test reads only — it
   * never resets anything — so the lock is enough to make it deterministic.
   */
  function underSeedLock<T>(body: () => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await lockDemoSeed(tx);
      return body();
    });
  }

  it("hands the resolved workspace to a read that runs in one repeatable-read, read-only snapshot", async () => {
    const seen = await underSeedLock(() => readWorkspaceSnapshot(db, async (tx, workspace) => {
      const rows = await tx.execute(sql`
        select current_setting('transaction_isolation') as isolation,
               current_setting('transaction_read_only') as read_only
      `) as unknown as Array<{ isolation: string; read_only: string }>;
      return { workspace, settings: rows[0]! };
    }, { demoMode: true }));

    expect(seen.workspace.kind).toBe("sandbox");
    expect(seen.workspace.name).toBe(DEMO_WORKSPACE_NAME);
    // The two halves of the fix, asserted where they take effect rather than
    // where they are configured.
    expect(seen.settings.isolation).toBe("repeatable read");
    expect(seen.settings.read_only).toBe("on");
  });

  // `read only` is scope, not decoration: a page's reads are meant to agree
  // with each other, not to carry a write inside a transaction whose lifetime
  // is a render.
  it("refuses a write attempted inside the snapshot", async () => {
    const failure: unknown = await underSeedLock(() => readWorkspaceSnapshot(db, async (tx, workspace) => tx
      .update(workspaces).set({ name: "nope" }).where(eq(workspaces.id, workspace.id)), { demoMode: true }))
      .then(() => null, (err: unknown) => err);

    // Drizzle wraps the driver's error in one naming the query; Postgres's own
    // refusal is the cause.
    expect(failure).toBeInstanceOf(Error);
    const cause = (failure as Error).cause;
    expect(`${(cause as Error | undefined)?.message ?? (failure as Error).message}`)
      .toMatch(/read-only transaction/i);
  });
});
