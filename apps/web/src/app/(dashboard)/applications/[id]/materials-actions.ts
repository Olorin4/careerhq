"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { documentKindSchema } from "@careerhq/contracts";
import { createDocument, setDocumentApproval } from "@careerhq/db";
import { loadConfig } from "@careerhq/config";
import { getDb } from "../../../../lib/db.js";
import { getActiveWorkspace } from "../../../../lib/workspace.js";
import { runGeneration, type GenerationOutcome } from "../../../../lib/generation.js";

const generateSchema = z.object({ applicationId: z.string().uuid(), kind: documentKindSchema });

/**
 * The blocking, non-streaming generation path. The materials panel's primary
 * "Generate" button drives the SSE route instead (so the user sees the draft
 * arrive token by token), and falls back to calling this directly if the
 * stream never starts (route unreachable, network error before any bytes)
 * or dies mid-flight — so the outcome contract has to match the SSE route's
 * final `done` event exactly, which it does: both bottom out in
 * `runGeneration`.
 */
export async function generateDocumentAction(
  raw: { applicationId: string; kind: string },
): Promise<GenerationOutcome> {
  const args = generateSchema.parse(raw);
  const db = getDb();
  const config = loadConfig();
  const ws = await getActiveWorkspace(db);
  const outcome = await runGeneration(
    { db, config },
    { workspaceId: ws.id, applicationId: args.applicationId, kind: args.kind },
  );
  revalidatePath(`/applications/${args.applicationId}`);
  return outcome;
}

const approvalIdSchema = z.object({ id: z.string().uuid() });

export async function approveDocumentAction(raw: { id: string }): Promise<{ ok: boolean }> {
  const { id } = approvalIdSchema.parse(raw);
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  const updated = await setDocumentApproval(db, ws.id, id, "approved");
  if (updated) revalidatePath(`/applications/${updated.applicationId}`);
  return { ok: updated !== null };
}

export async function rejectDocumentAction(raw: { id: string }): Promise<{ ok: boolean }> {
  const { id } = approvalIdSchema.parse(raw);
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  const updated = await setDocumentApproval(db, ws.id, id, "rejected");
  if (updated) revalidatePath(`/applications/${updated.applicationId}`);
  return { ok: updated !== null };
}

const manualDocumentSchema = z.object({
  applicationId: z.string().uuid(),
  kind: documentKindSchema,
  content: z.string().trim().min(1),
});

/**
 * The manual editor's save action. Always inserts a new draft row with
 * `origin: "user"` — documents are append-only history, not edited in
 * place, so a manual edit (even of a previously AI-drafted document) becomes
 * its own new latest version rather than mutating the AI-authored row.
 */
export async function createManualDocumentAction(formData: FormData): Promise<void> {
  const input = manualDocumentSchema.parse(Object.fromEntries(formData));
  const db = getDb();
  await createDocument(db, {
    applicationId: input.applicationId,
    kind: input.kind,
    contentMd: input.content,
    sourceFactIds: [],
    origin: "user",
  });
  revalidatePath(`/applications/${input.applicationId}`);
}
