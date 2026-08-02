"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { factCategorySchema, sensitivitySchema } from "@careerhq/contracts";
import { createFact, reverifyFact, archiveFact } from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { getActiveWorkspace } from "../../../lib/workspace.js";

const factSchema = z.object({
  category: factCategorySchema,
  claim: z.string().trim().min(1),
  detail: z.string().optional(),
  evidenceUrl: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  sensitivity: sensitivitySchema.default("normal"),
  reviewBy: z.coerce.date(),
});

export async function createFactAction(formData: FormData): Promise<void> {
  const input = factSchema.parse(Object.fromEntries(formData));
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  await createFact(db, {
    workspaceId: ws.id,
    category: input.category,
    claim: input.claim,
    detail: input.detail,
    evidenceUrl: input.evidenceUrl,
    sensitivity: input.sensitivity,
    reviewBy: input.reviewBy,
  });
  revalidatePath("/facts");
}

const reverifySchema = z.object({ id: z.string().uuid(), reviewBy: z.coerce.date() });

export async function reverifyFactAction(formData: FormData): Promise<void> {
  const input = reverifySchema.parse(Object.fromEntries(formData));
  const db = getDb();
  await reverifyFact(db, input.id, input.reviewBy);
  revalidatePath("/facts");
}

const archiveSchema = z.object({ id: z.string().uuid() });

export async function archiveFactAction(formData: FormData): Promise<void> {
  const input = archiveSchema.parse(Object.fromEntries(formData));
  const db = getDb();
  await archiveFact(db, input.id);
  revalidatePath("/facts");
}
