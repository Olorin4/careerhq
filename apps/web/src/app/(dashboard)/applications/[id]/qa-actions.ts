"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { sensitivitySchema } from "@careerhq/contracts";
import { classifyQuestionSensitivity } from "@careerhq/core";
import { approveAnswer, createAnswer, rejectAnswer } from "@careerhq/db";
import { loadConfig } from "@careerhq/config";
import { getDb } from "../../../../lib/db.js";
import { getActiveWorkspace } from "../../../../lib/workspace.js";
import { runGeneration, type GenerationOutcome } from "../../../../lib/generation.js";

const askSchema = z.object({
  applicationId: z.string().uuid(),
  question: z.string().trim().min(3),
});

export interface AskQuestionResult {
  outcome: GenerationOutcome;
  /**
   * Set only alongside an `ai_unavailable` outcome: `prepareGeneration` returns
   * `ai_unavailable` before it ever reaches the sensitive-question ruleset (the
   * api-key gate runs first), so an install with no key would otherwise never
   * warn about a sensitive question at all. Running the pure, client-agnostic
   * `classifyQuestionSensitivity` here — no AI call, no key needed — lets the
   * panel still show the "this looks sensitive" warning next to the manual
   * form even when AI is off.
   */
  rulesetSensitive?: { matchedTerms: string[] };
}

export async function askQuestionAction(
  raw: { applicationId: string; question: string },
): Promise<AskQuestionResult> {
  const args = askSchema.parse(raw);
  const db = getDb();
  const config = loadConfig();
  const ws = await getActiveWorkspace(db);
  const outcome = await runGeneration(
    { db, config },
    { workspaceId: ws.id, applicationId: args.applicationId, kind: "question", question: args.question },
  );
  revalidatePath(`/applications/${args.applicationId}`);

  if (outcome.status === "ai_unavailable") {
    const ruling = classifyQuestionSensitivity(args.question);
    if (ruling.sensitive) return { outcome, rulesetSensitive: { matchedTerms: ruling.matchedTerms } };
  }
  return { outcome };
}

const manualAnswerSchema = z.object({
  applicationId: z.string().uuid(),
  question: z.string().trim().min(3),
  answer: z.string().trim().min(1),
  sensitivity: sensitivitySchema.default("normal"),
});

/**
 * The manual answer form's save action. Always inserts a new draft row with
 * `origin: "user"` — same append-only convention as
 * `createManualDocumentAction`, and the only path that can ever write a
 * `sensitivity: "sensitive"` row, since `runGeneration` never persists an AI
 * answer to a sensitive question.
 */
export async function saveManualAnswerAction(formData: FormData): Promise<void> {
  const input = manualAnswerSchema.parse(Object.fromEntries(formData));
  const db = getDb();
  await createAnswer(db, {
    applicationId: input.applicationId,
    questionRaw: input.question,
    answer: input.answer,
    origin: "user",
    sensitivity: input.sensitivity,
  });
  revalidatePath(`/applications/${input.applicationId}`);
}

const approveSchema = z.object({ id: z.string().uuid(), reusable: z.boolean() });

export async function approveAnswerAction(
  raw: { id: string; reusable: boolean },
): Promise<{ ok: boolean }> {
  const { id, reusable } = approveSchema.parse(raw);
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  const updated = await approveAnswer(db, ws.id, id, { reusable });
  if (updated) {
    revalidatePath(`/applications/${updated.applicationId}`);
    if (updated.reusable) revalidatePath("/answers");
  }
  return { ok: updated !== null };
}

const idSchema = z.object({ id: z.string().uuid() });

export async function rejectAnswerAction(raw: { id: string }): Promise<{ ok: boolean }> {
  const { id } = idSchema.parse(raw);
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  const updated = await rejectAnswer(db, ws.id, id);
  if (updated) revalidatePath(`/applications/${updated.applicationId}`);
  return { ok: updated !== null };
}
