import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, workspaces, type Db } from "@careerhq/db";
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

d("getActiveWorkspace", () => {
  it("resolves the sandbox workspace in demo mode", async () => {
    const ws = await getActiveWorkspace(db, { demoMode: true });
    expect(ws.kind).toBe("sandbox");
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
  it("bootstraps 'CareerHQ Demo' when no sandbox workspace exists at all", async () => {
    const before = await db.select().from(workspaces).where(eq(workspaces.kind, "sandbox"));
    const ROLLBACK = new Error("rollback: this test must leave no trace");
    let bootstrappedId = "";

    await expect(db.transaction(async (tx) => {
      // Reclassified rather than deleted: `workspaces` cascades into
      // applications/facts/attempts, and locking that whole subtree is a far
      // bigger blast radius than this test needs. `getActiveWorkspace` selects
      // on `kind`, so this is absence as far as it is concerned.
      await tx.update(workspaces).set({ kind: "personal" }).where(eq(workspaces.kind, "sandbox"));
      expect(await tx.select().from(workspaces).where(eq(workspaces.kind, "sandbox"))).toHaveLength(0);

      const created = await getActiveWorkspace(tx, { demoMode: true });
      bootstrappedId = created.id;
      expect(created.kind).toBe("sandbox");
      expect(created.name).toBe("CareerHQ Demo");

      // Idempotent: a second call returns the same row, it does not bootstrap again.
      expect((await getActiveWorkspace(tx, { demoMode: true })).id).toBe(created.id);
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);

    // The bootstrapped row went with the rollback, and every pre-existing
    // sandbox workspace is a sandbox workspace again.
    const after = await db.select().from(workspaces).where(eq(workspaces.kind, "sandbox"));
    expect(after.map((w) => w.id).sort()).toEqual(before.map((w) => w.id).sort());
    expect(after.map((w) => w.id)).not.toContain(bootstrappedId);
  });

  it("resolves the personal workspace when demo mode is off", async () => {
    const ws = await getActiveWorkspace(db, { demoMode: false });
    expect(ws.kind).toBe("personal");
  });

  it("never returns a personal workspace in demo mode even when one exists", async () => {
    const [personal] = await db.insert(workspaces).values({ name: `t-personal-${Date.now()}`, kind: "personal" }).returning();
    throwawayWorkspaceIds.push(personal!.id);
    const ws = await getActiveWorkspace(db, { demoMode: true });
    expect(ws.kind).toBe("sandbox");
  });
});
