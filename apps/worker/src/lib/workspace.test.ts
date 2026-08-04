import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, workspaces, type Db } from "@careerhq/db";
import { getPersonalWorkspaceId } from "./workspace.js";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

let db: Db;
// Only the throwaway rows this suite inserts directly get cleaned up. This
// suite never asserts "no sandbox/personal workspace exists" — doing so
// against the shared dev/CI database would mean deleting rows other suites
// (or a real demo deployment) may depend on, such as the "CareerHQ Demo"
// singleton apps/web/src/lib/workspace.test.ts bootstraps.
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

d("getPersonalWorkspaceId", () => {
  it("resolves a personal workspace's id when demo mode is off", async () => {
    const [personal] = await db.insert(workspaces).values({ name: `worker-t-personal-${Date.now()}`, kind: "personal" }).returning();
    throwawayWorkspaceIds.push(personal!.id);
    const id = await getPersonalWorkspaceId(db, { demoMode: false });
    expect(id).not.toBeNull();
    expect(await kindOf(id!)).toBe("personal");
  });

  it("resolves a sandbox workspace's id in demo mode, not a personal one (spec P6 §3)", async () => {
    const [sandbox] = await db.insert(workspaces).values({ name: `worker-t-sandbox-${Date.now()}`, kind: "sandbox" }).returning();
    throwawayWorkspaceIds.push(sandbox!.id);
    const [personal] = await db.insert(workspaces).values({ name: `worker-t-personal2-${Date.now()}`, kind: "personal" }).returning();
    throwawayWorkspaceIds.push(personal!.id);
    const id = await getPersonalWorkspaceId(db, { demoMode: true });
    expect(id).not.toBeNull();
    expect(await kindOf(id!)).toBe("sandbox");
  });
});
