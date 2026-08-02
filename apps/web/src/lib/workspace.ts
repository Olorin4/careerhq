import { workspaces, type Db, type Workspace } from "@careerhq/db";
import { eq } from "drizzle-orm";

export async function getActiveWorkspace(db: Db): Promise<Workspace> {
  const existing = await db.select().from(workspaces).where(eq(workspaces.kind, "personal")).limit(1);
  if (existing[0]) return existing[0];
  const created = await db.insert(workspaces).values({ name: "My workspace", kind: "personal" }).returning();
  if (!created[0]) throw new Error("failed to bootstrap workspace");
  return created[0];
}
