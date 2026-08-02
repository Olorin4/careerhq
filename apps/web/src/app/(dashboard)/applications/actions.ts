"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { applicationStateSchema } from "@careerhq/contracts";
import { createApplication, transitionApplication } from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { getActiveWorkspace } from "../../../lib/workspace.js";

const createSchema = z.object({
  companyName: z.string().trim().min(1),
  jobTitle: z.string().trim().min(1),
  jobUrl: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  notes: z.string().optional(),
  external: z.coerce.boolean().default(false),
  submittedAt: z.coerce.date().optional(),
});

export async function createApplicationAction(formData: FormData): Promise<void> {
  const input = createSchema.parse(Object.fromEntries(formData));
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  await createApplication(db, {
    workspaceId: ws.id, companyName: input.companyName, jobTitle: input.jobTitle,
    jobUrl: input.jobUrl, notes: input.notes,
    asExternalSubmitted: input.external, submittedAt: input.submittedAt,
  });
  revalidatePath("/applications");
}

const transitionSchema = z.object({ applicationId: z.string().uuid(), to: applicationStateSchema });

export async function transitionApplicationAction(
  raw: { applicationId: string; to: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const args = transitionSchema.parse(raw);
  const db = getDb();
  const result = await transitionApplication(db, {
    applicationId: args.applicationId, to: args.to, trigger: "user",
    // P1: the user's click is the materials assertion; replaced by a real check in P3.
    ctx: args.to === "READY_FOR_REVIEW" ? { hasMaterials: true } : {},
  });
  revalidatePath("/applications");
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}
