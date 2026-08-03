"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { applicationStateSchema } from "@careerhq/contracts";
import type { TransitionContext } from "@careerhq/core";
import {
  createApplication, getApplication, hasApprovedMaterials, setApplicationCvVariant, transitionApplication,
} from "@careerhq/db";
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

  let ctx: TransitionContext = {};
  if (args.to === "READY_FOR_REVIEW") {
    // Materials exist for the chosen channel (spec §6.2): at least one
    // approved generated_documents row, and a CV variant selected on the
    // application itself. Both are real database facts now, not the user's
    // say-so — a stale P1 shortcut used to hand-wave this to `true`.
    const [approved, application] = await Promise.all([
      hasApprovedMaterials(db, args.applicationId),
      getApplication(db, args.applicationId),
    ]);
    ctx = { hasMaterials: approved && application?.cvVariantId != null };
  }

  const result = await transitionApplication(db, {
    applicationId: args.applicationId, to: args.to, trigger: "user", ctx,
  });
  revalidatePath("/applications");
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

const selectCvSchema = z.object({
  applicationId: z.string().uuid(),
  cvVariantId: z.string().uuid().nullable(),
});

/** Sets (or clears) which CV variant an application will submit with. */
export async function selectCvAction(
  raw: { applicationId: string; cvVariantId: string | null },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const args = selectCvSchema.parse(raw);
  const db = getDb();
  const updated = await setApplicationCvVariant(db, args.applicationId, args.cvVariantId);
  if (!updated) return { ok: false, reason: "application not found" };
  revalidatePath(`/applications/${args.applicationId}`);
  return { ok: true };
}
