"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { dismissJob, promoteJob } from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { demoRateLimit } from "../../../lib/rate-limit.js";
import { getActiveWorkspace } from "../../../lib/workspace.js";

const jobIdSchema = z.object({ jobId: z.string().uuid() });

export async function promoteJobAction(
  raw: { jobId: string },
): Promise<{ ok: true; applicationId: string } | { ok: false; reason: string }> {
  const { jobId } = jobIdSchema.parse(raw);
  const limited = demoRateLimit("promoteJob");
  if (limited) return { ok: false, reason: limited };
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  const result = await promoteJob(db, ws.id, jobId);
  revalidatePath("/jobs");
  if (!result.ok) return result;
  revalidatePath("/applications");
  return result;
}

/** Reports refusals (currently only the demo rate limit) instead of failing silently. */
export async function dismissJobAction(
  raw: { jobId: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { jobId } = jobIdSchema.parse(raw);
  const limited = demoRateLimit("dismissJob");
  if (limited) return { ok: false, reason: limited };
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  await dismissJob(db, ws.id, jobId);
  revalidatePath("/jobs");
  return { ok: true };
}
