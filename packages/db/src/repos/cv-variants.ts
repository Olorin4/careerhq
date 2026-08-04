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

/**
 * Every stored CV path, across all workspaces — the live set for the demo's
 * `cvs/` garbage collector (`apps/web/src/lib/cv-storage.ts`). Deliberately
 * NOT workspace-scoped: the collector deletes whatever it does not see here,
 * so scoping it to one workspace would delete another workspace's files.
 *
 * The join is on the PATH STRING, and that coupling is load-bearing: the
 * collector resolves both sides with `path.resolve` and then compares them for
 * exact equality, so a row whose `file_path` is not the same absolute path the
 * file was written to does not protect that file — it gets collected as an
 * orphan. Every writer today builds the path with `path.join` against
 * `config.fileStorageDir`, which `@careerhq/config` guarantees absolute, so the
 * two sides agree by construction. Anything that starts storing a relative
 * path, a symlinked path or a `~`-expanded path here must teach the collector
 * the same normalisation FIRST, because the failure mode is deleting a file a
 * user still has a row for.
 */
export async function listCvFilePaths(db: Db): Promise<string[]> {
  const rows = await db.select({ filePath: cvVariants.filePath }).from(cvVariants);
  return rows.map((row) => row.filePath);
}
