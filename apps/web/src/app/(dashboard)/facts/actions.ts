"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { factCategorySchema, sensitivitySchema, TEXT_LIMITS } from "@careerhq/contracts";
import { createFact, reverifyFact, archiveFact } from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { describeZodIssue, submittedTextValues } from "../../../lib/form-state.js";
import { demoRateLimit } from "../../../lib/rate-limit.js";
import { getActiveWorkspace } from "../../../lib/workspace.js";

const factSchema = z.object({
  category: factCategorySchema,
  claim: z.string().trim().min(1).max(TEXT_LIMITS.headline),
  detail: z.string().max(TEXT_LIMITS.detail).optional(),
  evidenceUrl: z.string().url().max(TEXT_LIMITS.url).optional().or(z.literal("").transform(() => undefined)),
  sensitivity: sensitivitySchema.default("normal"),
  reviewBy: z.coerce.date(),
});

/**
 * Why the fact was not saved, plus the values that were typed so the form can
 * re-seed itself; `null` means saved. All three actions in this file returned
 * `void`, so a refusal could only ever have been thrown — and a thrown refusal
 * is the full-page error overlay, not a message. `useActionState` gives them
 * somewhere to put one.
 */
export type CreateFactState = { reason: string; values: Record<string, string> } | null;

function refuseCreate(reason: string, formData: FormData): CreateFactState {
  return { reason, values: submittedTextValues(formData) };
}

export async function createFactAction(
  _previous: CreateFactState,
  formData: FormData,
): Promise<CreateFactState> {
  const parsed = factSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return refuseCreate(describeZodIssue(parsed.error, "invalid fact"), formData);
  const limited = demoRateLimit("createFact");
  if (limited) return refuseCreate(limited, formData);

  const input = parsed.data;
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
  return null;
}

/**
 * The per-row actions carry no typed text worth preserving — a hidden id, and
 * for re-verify a date the row re-renders its own default for — so their state
 * is the reason alone. `null` means done.
 */
export type FactRowState = { reason: string } | null;

const reverifySchema = z.object({ id: z.string().uuid(), reviewBy: z.coerce.date() });

export async function reverifyFactAction(
  _previous: FactRowState,
  formData: FormData,
): Promise<FactRowState> {
  const parsed = reverifySchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { reason: describeZodIssue(parsed.error, "invalid re-verification") };
  const limited = demoRateLimit("reverifyFact");
  if (limited) return { reason: limited };

  const db = getDb();
  const ws = await getActiveWorkspace(db);
  await reverifyFact(db, ws.id, parsed.data.id, parsed.data.reviewBy);
  revalidatePath("/facts");
  return null;
}

const archiveSchema = z.object({ id: z.string().uuid() });

export async function archiveFactAction(
  _previous: FactRowState,
  formData: FormData,
): Promise<FactRowState> {
  const parsed = archiveSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { reason: describeZodIssue(parsed.error, "invalid fact") };
  const limited = demoRateLimit("archiveFact");
  if (limited) return { reason: limited };

  const db = getDb();
  const ws = await getActiveWorkspace(db);
  await archiveFact(db, ws.id, parsed.data.id);
  revalidatePath("/facts");
  return null;
}
