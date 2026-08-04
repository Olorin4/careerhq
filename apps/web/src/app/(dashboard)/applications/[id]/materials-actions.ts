"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { documentKindSchema } from "@careerhq/contracts";
import { createDocument, setDocumentApproval } from "@careerhq/db";
import { loadConfig } from "@careerhq/config";
import { getDb } from "../../../../lib/db.js";
import { demoRateLimit } from "../../../../lib/rate-limit.js";
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
  // "generateDocument" is deliberately the SSE route's bucket too
  // (`app/api/generate/stream/route.ts`): they are two transports for one
  // user-visible click, so one budget covers both — driving the pair must not
  // buy twice the generations. (A "use server" module may only export async
  // functions, so the name is repeated here rather than shared as a const.)
  const limited = demoRateLimit("generateDocument");
  if (limited) return { status: "failed", error: limited };
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

/** Carries a reason so the panel can say WHY, rather than only that it failed. */
export type ApprovalActionResult = { ok: true } | { ok: false; reason: string };

async function setApproval(
  raw: { id: string },
  approval: "approved" | "rejected",
  bucket: string,
): Promise<ApprovalActionResult> {
  const { id } = approvalIdSchema.parse(raw);
  const limited = demoRateLimit(bucket);
  if (limited) return { ok: false, reason: limited };
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  const updated = await setDocumentApproval(db, ws.id, id, approval);
  if (!updated) return { ok: false, reason: "this document no longer exists" };
  revalidatePath(`/applications/${updated.applicationId}`);
  return { ok: true };
}

export async function approveDocumentAction(raw: { id: string }): Promise<ApprovalActionResult> {
  return setApproval(raw, "approved", "approveDocument");
}

export async function rejectDocumentAction(raw: { id: string }): Promise<ApprovalActionResult> {
  return setApproval(raw, "rejected", "rejectDocument");
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
 *
 * Shaped for `useActionState`: it returns the reason it did nothing (or null
 * on success) rather than throwing, so a rate-limited save is visible in the
 * form instead of silently dropping what the user typed.
 */
export async function createManualDocumentAction(
  _previous: string | null,
  formData: FormData,
): Promise<string | null> {
  const input = manualDocumentSchema.parse(Object.fromEntries(formData));
  const limited = demoRateLimit("createManualDocument");
  if (limited) return limited;
  const db = getDb();
  await createDocument(db, {
    applicationId: input.applicationId,
    kind: input.kind,
    contentMd: input.content,
    sourceFactIds: [],
    origin: "user",
  });
  revalidatePath(`/applications/${input.applicationId}`);
  return null;
}
