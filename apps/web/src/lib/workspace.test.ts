import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DEMO_WORKSPACE_NAME, createDb, lockDemoSeed, workspaces, type Db } from "@careerhq/db";
import { getActiveWorkspace } from "./workspace.js";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

let db: Db;
// Ids of throwaway workspaces these tests insert directly, cleaned up in
// afterAll. This does NOT include whatever `getActiveWorkspace` itself
// returns/bootstraps: in demo mode that is the same kind of singleton
// "CareerHQ Demo" / "My workspace" row the seed creates for personal mode
// (e.g. "Alex Demo") — deleting it here would blow away real seeded state
// that other manual/dev work depends on, not a fixture this suite owns.
const throwawayWorkspaceIds: string[] = [];

beforeAll(() => {
  if (!url) return;
  db = createDb(url);
});

afterAll(async () => {
  if (!url) return;
  for (const id of throwawayWorkspaceIds) {
    await db.delete(workspaces).where(eq(workspaces.id, id));
  }
  await db.$client.end();
});

/**
 * Resolves under the demo seed's advisory lock.
 *
 * `getActiveWorkspace` BOOTSTRAPS a demo workspace when it finds none, and the
 * worker's `demo-reset` suite is deleting and recreating exactly that row in
 * parallel with this file. Un-serialised, a call landing in the gap would
 * commit a second `sandbox`/`CareerHQ Demo` row and break the reset suite's
 * "exactly one demo workspace" assertion. Holding the lock means the call sees
 * either the row before a reset or the row after it, never neither.
 */
async function resolveDemoWorkspace() {
  return db.transaction(async (tx) => {
    await lockDemoSeed(tx);
    return getActiveWorkspace(tx, { demoMode: true });
  });
}

d("getActiveWorkspace", () => {
  it("resolves the demo workspace in demo mode", async () => {
    const ws = await resolveDemoWorkspace();
    expect(ws.kind).toBe("sandbox");
    expect(ws.name).toBe(DEMO_WORKSPACE_NAME);
  });

  // Demo mode matches kind AND name. The demo seed drops and recreates its
  // workspace on every reset, so the demo row is always the newest sandbox one,
  // while this resolver takes the OLDEST match: matching on kind alone resolves
  // an older, unrelated sandbox workspace (the site/email submission suites own
  // several) and serves an empty demo.
  //
  // "Older" is the whole defect, and the reason the decoy is backdated here.
  // An earlier version of this test inserted the decoy after the demo row,
  // where even the buggy kind-only predicate picked the demo row — so it passed
  // with the fix reverted and asserted nothing. Establishing the row set
  // requires hiding the other sandbox rows, which is only safe inside a
  // transaction that rolls back, under the same advisory lock the demo seed
  // takes: without it a reset committing mid-test is visible to the next
  // statement, since the reclassify below only covers rows in its own snapshot.
  it("never resolves a sandbox workspace that is not the demo's", async () => {
    const ROLLBACK = new Error("rollback: this test must leave no trace");
    await expect(db.transaction(async (tx) => {
      await lockDemoSeed(tx);
      await tx.update(workspaces).set({ kind: "personal" }).where(eq(workspaces.kind, "sandbox"));

      const [older] = await tx.insert(workspaces).values({
        name: "t-other-sandbox", kind: "sandbox",
        createdAt: new Date(Date.now() - 24 * 60 * 60_000),
      }).returning();
      const [demo] = await tx.insert(workspaces)
        .values({ name: DEMO_WORKSPACE_NAME, kind: "sandbox" }).returning();

      const resolved = await getActiveWorkspace(tx, { demoMode: true });
      expect(resolved.id).not.toBe(older!.id);
      expect(resolved.id).toBe(demo!.id);
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
  });

  // The review found this branch was named but never reached: against a shared
  // dev DB a "CareerHQ Demo" row already exists, so the bootstrap insert — and
  // the name it chooses — had no coverage at all.
  //
  // Absence is established rather than assumed, and the whole thing runs inside
  // a transaction that always rolls back: deleting every sandbox workspace for
  // real would be visible to the suites running beside this one (site- and
  // email-submission both own sandbox-kind fixtures), which is exactly the
  // class of cross-suite race `72481c1` had to fix once already.
  //
  // The before/after comparison is taken inside an OUTER transaction holding
  // the demo seed's advisory lock. A demo reset committing between the two
  // reads would change the sandbox row set for reasons that have nothing to do
  // with this test, and the reset is running in the worker's suite at the same
  // time as this one.
  it("bootstraps 'CareerHQ Demo' when no sandbox workspace exists at all", async () => {
    await db.transaction(async (outer) => {
      await lockDemoSeed(outer);
      const before = await outer.select().from(workspaces).where(eq(workspaces.kind, "sandbox"));
      const ROLLBACK = new Error("rollback: this test must leave no trace");
      let bootstrappedId = "";

      // A savepoint inside `outer`: rolling it back restores the reclassified
      // rows and drops the bootstrapped one while `outer` — and the lock —
      // stay held. `outer` itself only ever reads, so it commits nothing.
      await expect(outer.transaction(async (tx) => {
        // Reclassified rather than deleted: `workspaces` cascades into
        // applications/facts/attempts, and locking that whole subtree is a far
        // bigger blast radius than this test needs. `getActiveWorkspace` selects
        // on `kind`, so this is absence as far as it is concerned.
        await tx.update(workspaces).set({ kind: "personal" }).where(eq(workspaces.kind, "sandbox"));
        expect(await tx.select().from(workspaces).where(eq(workspaces.kind, "sandbox"))).toHaveLength(0);

        const created = await getActiveWorkspace(tx, { demoMode: true });
        bootstrappedId = created.id;
        expect(created.kind).toBe("sandbox");
        expect(created.name).toBe(DEMO_WORKSPACE_NAME);

        // Idempotent: a second call returns the same row, it does not bootstrap again.
        expect((await getActiveWorkspace(tx, { demoMode: true })).id).toBe(created.id);
        throw ROLLBACK;
      })).rejects.toBe(ROLLBACK);

      // The bootstrapped row went with the rollback, and every pre-existing
      // sandbox workspace is a sandbox workspace again.
      const after = await outer.select().from(workspaces).where(eq(workspaces.kind, "sandbox"));
      expect(after.map((w) => w.id).sort()).toEqual(before.map((w) => w.id).sort());
      expect(after.map((w) => w.id)).not.toContain(bootstrappedId);
    });
  });

  it("resolves the personal workspace when demo mode is off", async () => {
    const ws = await getActiveWorkspace(db, { demoMode: false });
    expect(ws.kind).toBe("personal");
  });

  it("never returns a personal workspace in demo mode even when one exists", async () => {
    const [personal] = await db.insert(workspaces).values({ name: `t-personal-${Date.now()}`, kind: "personal" }).returning();
    throwawayWorkspaceIds.push(personal!.id);
    const ws = await resolveDemoWorkspace();
    expect(ws.kind).toBe("sandbox");
    expect(ws.id).not.toBe(personal!.id);
  });
});
