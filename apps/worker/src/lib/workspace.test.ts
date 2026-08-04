import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DEMO_WORKSPACE_NAME, createDb, lockDemoSeed, workspaces, type Db, type DbOrTx } from "@careerhq/db";
import { getPersonalWorkspaceId } from "./workspace.js";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

let db: Db;
// Only the throwaway rows this suite inserts directly get cleaned up. This
// suite never asserts "no sandbox/personal workspace exists" — doing so
// against the shared dev/CI database would mean deleting rows other suites
// (or a real demo deployment) may depend on, such as the "CareerHQ Demo"
// singleton the demo seed owns.
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

async function kindOf(id: string): Promise<string | undefined> {
  const [row] = await db.select({ kind: workspaces.kind }).from(workspaces).where(eq(workspaces.id, id));
  return row?.kind;
}

/**
 * Runs `body` against a workspace table containing nothing but the rows it
 * creates, then rolls the whole thing back.
 *
 * Both halves matter. The rollback is why this suite may insert a row named
 * `DEMO_WORKSPACE_NAME` at all: an earlier version committed one, which is
 * exactly `seedDemoWorkspace`'s delete predicate, and `jobs/demo-reset.test.ts`
 * runs in parallel with this file — the reset deleted this suite's fixture
 * mid-test (reproduced on 1 run in 6), and this suite's fixture made the
 * reset's "exactly one demo workspace" assertion see two rows.
 *
 * The advisory lock is why the isolation holds: the reclassify below only hides
 * sandbox rows that exist when its snapshot is taken, so without serialising
 * against the seed a reset committing mid-test would still be visible to the
 * next statement.
 */
async function inIsolatedWorkspaces(body: (tx: DbOrTx) => Promise<void>): Promise<void> {
  const ROLLBACK = new Error("rollback: this test must leave no trace");
  await expect(db.transaction(async (tx) => {
    await lockDemoSeed(tx);
    // Reclassified rather than deleted: `workspaces` cascades into
    // applications/facts/attempts, and locking that whole subtree is a far
    // bigger blast radius than these tests need. The resolver selects on
    // `kind`, so this is absence as far as it is concerned.
    await tx.update(workspaces).set({ kind: "personal" }).where(eq(workspaces.kind, "sandbox"));
    await body(tx);
    throw ROLLBACK;
  })).rejects.toBe(ROLLBACK);
}

d("getPersonalWorkspaceId", () => {
  it("resolves a personal workspace's id when demo mode is off", async () => {
    const [personal] = await db.insert(workspaces).values({ name: `worker-t-personal-${Date.now()}`, kind: "personal" }).returning();
    throwawayWorkspaceIds.push(personal!.id);
    const id = await getPersonalWorkspaceId(db, { demoMode: false });
    expect(id).not.toBeNull();
    expect(await kindOf(id!)).toBe("personal");
  });

  it("resolves the demo workspace's id in demo mode, not a personal one (spec P6 §3)", async () => {
    await inIsolatedWorkspaces(async (tx) => {
      const [demo] = await tx.insert(workspaces)
        .values({ name: DEMO_WORKSPACE_NAME, kind: "sandbox" }).returning();
      // Older than the demo row, so `asc(createdAt)` would prefer it if the
      // resolver ever fell back to "any workspace".
      const [personal] = await tx.insert(workspaces)
        .values({ name: "worker-t-personal-in-demo-mode", kind: "personal", createdAt: new Date(Date.now() - 60 * 60_000) })
        .returning();

      const id = await getPersonalWorkspaceId(tx, { demoMode: true });
      expect(id).toBe(demo!.id);
      expect(id).not.toBe(personal!.id);
    });
  });

  // The demo seed drops and recreates its workspace on every reset, so the demo
  // row is the NEWEST sandbox one — while the resolver takes the oldest match.
  // Matching on kind alone therefore resolves an OLDER, unrelated sandbox
  // workspace (the e2e suites own several), and the demo serves an empty one.
  //
  // The decoy is backdated for that reason: an earlier version of this test
  // inserted it after the demo row, where the buggy kind-only predicate would
  // have picked the demo row anyway, so the test passed with the bug reinstated.
  it("never resolves a sandbox workspace that is not the demo's", async () => {
    await inIsolatedWorkspaces(async (tx) => {
      const [older] = await tx.insert(workspaces).values({
        name: "worker-t-other-sandbox", kind: "sandbox",
        createdAt: new Date(Date.now() - 24 * 60 * 60_000),
      }).returning();
      const [demo] = await tx.insert(workspaces)
        .values({ name: DEMO_WORKSPACE_NAME, kind: "sandbox" }).returning();

      const id = await getPersonalWorkspaceId(tx, { demoMode: true });
      expect(id).not.toBe(older!.id);
      expect(id).toBe(demo!.id);
    });
  });
});
