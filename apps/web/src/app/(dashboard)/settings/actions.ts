"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { atsTypeSchema, scoringProfileSchema } from "@careerhq/contracts";
import { addWatchlistEntry, removeWatchlistEntry, saveScoringProfile } from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { getActiveWorkspace } from "../../../lib/workspace.js";

/**
 * The profile form's roles/stack/boost/exclude fields are plain textareas
 * (one term per line) rather than dynamic list inputs — much simpler to build
 * and edit. Splitting/trimming/dropping-empties here keeps that UI choice
 * invisible to `scoringProfileSchema`, which only ever sees clean arrays.
 */
function parseLines(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string") return [];
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function saveScoringProfileAction(
  formData: FormData,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const raw = {
    roles: parseLines(formData.get("roles")),
    stack: parseLines(formData.get("stack")),
    boost: parseLines(formData.get("boost")),
    exclude: parseLines(formData.get("exclude")),
    requireRemote: formData.get("requireRemote") === "on",
    includeUnknownRemote: formData.get("includeUnknownRemote") === "on",
    minRoleHits: Number(formData.get("minRoleHits")),
    minStackHits: Number(formData.get("minStackHits")),
    topNForLlm: Number(formData.get("topNForLlm")),
  };
  const parsed = scoringProfileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    return { ok: false, reason: issue ? `${field ? `${field}: ` : ""}${issue.message}` : "invalid scoring profile" };
  }

  const db = getDb();
  const ws = await getActiveWorkspace(db);
  await saveScoringProfile(db, ws.id, parsed.data);
  revalidatePath("/settings");
  return { ok: true };
}

const watchlistEntrySchema = z.object({
  companyName: z.string().trim().min(1),
  atsType: atsTypeSchema,
  // The slug is interpolated straight into the ATS board URL by the fetchers,
  // so anything outside this set could reshape the request path.
  boardSlug: z.string().trim().min(1).regex(/^[A-Za-z0-9._-]+$/, {
    message: "board slug: letters, digits, dots, dashes, underscores only",
  }),
});

/**
 * `postgres` (the driver behind our Drizzle client) surfaces server errors as
 * a `PostgresError` with a `code` field carrying the raw SQLSTATE — '23505'
 * is unique_violation. Drizzle wraps that in a `DrizzleQueryError` whose own
 * `.code` is undefined; the SQLSTATE only shows up one level down, on
 * `.cause.code`. Checked at both levels by hand since neither driver exports
 * a type guard.
 */
function isUniqueViolation(err: unknown): boolean {
  const codeOf = (value: unknown): unknown =>
    (typeof value === "object" && value !== null && "code" in value ? (value as { code?: unknown }).code : undefined);
  const cause = typeof err === "object" && err !== null && "cause" in err ? (err as { cause?: unknown }).cause : undefined;
  return codeOf(err) === "23505" || codeOf(cause) === "23505";
}

export async function addWatchlistEntryAction(
  raw: { companyName: string; atsType: string; boardSlug: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = watchlistEntrySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues[0]?.message ?? "invalid watchlist entry" };
  }

  const db = getDb();
  const ws = await getActiveWorkspace(db);
  try {
    await addWatchlistEntry(db, { workspaceId: ws.id, ...parsed.data });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "already on the watchlist" };
    throw err;
  }
  revalidatePath("/settings");
  return { ok: true };
}

const watchlistIdSchema = z.object({ id: z.string().uuid() });

export async function removeWatchlistEntryAction(formData: FormData): Promise<void> {
  const { id } = watchlistIdSchema.parse(Object.fromEntries(formData));
  await removeWatchlistEntry(getDb(), id);
  revalidatePath("/settings");
}
