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
  it("resolves the sandbox workspace in demo mode, creating it when absent", async () => {
    const ws = await getActiveWorkspace(db, { demoMode: true });
    expect(ws.kind).toBe("sandbox");
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
