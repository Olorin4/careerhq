import { asc, eq } from "drizzle-orm";
import type { CvFormat } from "@careerhq/contracts";
import type { Db, DbOrTx } from "../client.js";
import { cvVariants } from "../schema/index.js";
import type { CvVariant } from "../index.js";

export async function createCvVariant(db: DbOrTx, input: {
  workspaceId: string; label: string; format: CvFormat; filePath: string; sha256: string;
}): Promise<CvVariant> {
  const [variant] = await db.insert(cvVariants).values({
    workspaceId: input.workspaceId,
    label: input.label,
    format: input.format,
    filePath: input.filePath,
    sha256: input.sha256,
  }).returning();
  return variant!;
}

export async function listCvVariants(db: Db, workspaceId: string): Promise<CvVariant[]> {
  return db.select().from(cvVariants)
    .where(eq(cvVariants.workspaceId, workspaceId))
    .orderBy(asc(cvVariants.createdAt));
}
