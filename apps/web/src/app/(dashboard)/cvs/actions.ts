"use server";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { cvFormatSchema } from "@careerhq/contracts";
import { createCvVariant, listCvFilePaths } from "@careerhq/db";
import { loadConfig } from "@careerhq/config";
import { getDb } from "../../../lib/db.js";
import { reserveCvUpload } from "../../../lib/cv-storage.js";
import { demoRateLimit } from "../../../lib/rate-limit.js";
import { getActiveWorkspace } from "../../../lib/workspace.js";

const metaSchema = z.object({ label: z.string().trim().min(1), format: cvFormatSchema });

/**
 * Why the upload did nothing, plus the label that was typed so the form can
 * re-seed it — `null` means uploaded. Shaped for `useActionState`, exactly as
 * `createManualDocumentAction` is: a refusal is reported in the form, never
 * thrown. Throwing from a server action reaches the user as an error overlay
 * or a blank 500, which is not a way to tell someone their PDF was too big.
 */
export type CvUploadState = { reason: string; label: string } | null;

function refuse(reason: string, formData: FormData): CvUploadState {
  const label = formData.get("label");
  return { reason, label: typeof label === "string" ? label : "" };
}

/**
 * Writes an uploaded CV to `${FILE_STORAGE_DIR}/cvs` and records the variant.
 *
 * This is the only path in the app that turns a request into bytes on the
 * host's disk, and on the hosted demo it is reachable by anyone with the URL,
 * so it carries two guards the cheap row-writing actions do not need
 * (P6 task-3 review advisory B / fixwave A5):
 *
 *   - the demo rate limit, in the `uploadCv` bucket, capped at the heavy-bucket
 *     rate rather than the click-y 30/min default; and
 *   - a demo-only size and store ceiling (`reserveCvUpload`), because a rate
 *     bounds how often a visitor writes, not how much they accumulate.
 *
 * Both are checked before `arrayBuffer()`, so a refused upload never even
 * pulls the file into memory, let alone onto the disk. Outside demo mode both
 * are inert and the behaviour is the original 5 MB check and nothing else.
 */
export async function uploadCvAction(_previous: CvUploadState, formData: FormData): Promise<CvUploadState> {
  const meta = metaSchema.safeParse({ label: formData.get("label"), format: formData.get("format") });
  if (!meta.success) {
    const issue = meta.error.issues[0];
    const field = issue?.path.join(".");
    return refuse(issue ? `${field ? `${field}: ` : ""}${issue.message}` : "invalid CV details", formData);
  }

  const limited = demoRateLimit("uploadCv");
  if (limited) return refuse(limited, formData);

  const file = formData.get("file");
  if (!(file instanceof File) || file.type !== "application/pdf") {
    return refuse("a PDF file is required", formData);
  }

  const config = loadConfig();
  const dir = path.join(config.fileStorageDir, "cvs");
  const db = getDb();
  const refusal = await reserveCvUpload({
    dir,
    incomingBytes: file.size,
    // Only the demo prunes and measures its store, so only the demo pays for
    // the query that tells it which files are still live.
    referencedPaths: config.demoMode ? await listCvFilePaths(db) : [],
    demoMode: config.demoMode,
  });
  if (refusal) return refuse(refusal, formData);

  const bytes = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${randomUUID()}.pdf`);
  await writeFile(filePath, bytes);
  const ws = await getActiveWorkspace(db);
  await createCvVariant(db, { workspaceId: ws.id, ...meta.data, filePath, sha256 });
  revalidatePath("/cvs");
  return null;
}
