import { workspaces, type Db, type Workspace } from "@careerhq/db";
import { asc, eq } from "drizzle-orm";

/**
 * The single-tenant app binds to one personal workspace. Several paths can
 * create one (this bootstrap, `pnpm seed`'s "Alex Demo", integration tests),
 * so the selection must be deterministic: always the oldest personal
 * workspace, with the id as a tiebreaker. Following the quickstart (seed, then
 * `next dev`) that is the seeded "Alex Demo" workspace, not an empty one.
 */
export async function getActiveWorkspace(db: Db): Promise<Workspace> {
  const existing = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.kind, "personal"))
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1);
  if (existing[0]) return existing[0];
  const created = await db.insert(workspaces).values({ name: "My workspace", kind: "personal" }).returning();
  if (!created[0]) throw new Error("failed to bootstrap workspace");
  return created[0];
}
