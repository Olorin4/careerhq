"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { emailMessages, setSuggestionState, transitionApplication } from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { demoRateLimit } from "../../../lib/rate-limit.js";

const messageIdSchema = z.object({ messageId: z.string().uuid() });

/**
 * Applies a suggestion's `suggestedTransition` (trigger "user" — spec §9.5,
 * this is the human's own confirmation of what the machine proposed) and, on
 * success, moves the suggestion out of the pending queue.
 *
 * `transitionApplication` itself refuses an illegal move (the application has
 * since moved on, a guard no longer holds, …); that refusal is returned as-is
 * and the suggestion is left completely untouched — still pending, so a
 * human can look again rather than losing the suggestion silently.
 */
export async function acceptSuggestionAction(
  raw: { messageId: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { messageId } = messageIdSchema.parse(raw);
  const limited = demoRateLimit("acceptSuggestion");
  if (limited) return { ok: false, reason: limited };
  const db = getDb();

  const [message] = await db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
  if (!message) return { ok: false, reason: "message not found" };
  if (!message.applicationId || !message.suggestedTransition) {
    return { ok: false, reason: "this suggestion has no application transition to apply" };
  }

  const result = await transitionApplication(db, {
    applicationId: message.applicationId,
    to: message.suggestedTransition,
    trigger: "user",
  });
  if (!result.ok) return { ok: false, reason: result.reason };

  await setSuggestionState(db, messageId, "accepted");
  revalidatePath("/inbox");
  revalidatePath(`/applications/${message.applicationId}`);
  return { ok: true };
}

/** Dismisses a suggestion with no effect on the application itself. */
export async function dismissSuggestionAction(
  raw: { messageId: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { messageId } = messageIdSchema.parse(raw);
  const limited = demoRateLimit("dismissSuggestion");
  if (limited) return { ok: false, reason: limited };
  const db = getDb();
  await setSuggestionState(db, messageId, "dismissed");
  revalidatePath("/inbox");
  return { ok: true };
}
