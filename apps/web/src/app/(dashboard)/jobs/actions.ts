"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { dismissJob, promoteJob } from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { getActiveWorkspace } from "../../../lib/workspace.js";

const jobIdSchema = z.object({ jobId: z.string().uuid() });

export async function promoteJobAction(
  raw: { jobId: string },
): Promise<{ ok: true; applicationId: string } | { ok: false; reason: string }> {
  const { jobId } = jobIdSchema.parse(raw);
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  const result = await promoteJob(db, ws.id, jobId);
  revalidatePath("/jobs");
  if (!result.ok) return result;
  revalidatePath("/applications");
  return result;
}

export async function dismissJobAction(raw: { jobId: string }): Promise<void> {
  const { jobId } = jobIdSchema.parse(raw);
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  await dismissJob(db, ws.id, jobId);
  revalidatePath("/jobs");
}
