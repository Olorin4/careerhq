"use server";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { cvFormatSchema } from "@careerhq/contracts";
import { createCvVariant } from "@careerhq/db";
import { loadConfig } from "@careerhq/config";
import { getDb } from "../../../lib/db.js";
import { getActiveWorkspace } from "../../../lib/workspace.js";

const metaSchema = z.object({ label: z.string().trim().min(1), format: cvFormatSchema });
const MAX_BYTES = 5 * 1024 * 1024;

export async function uploadCvAction(formData: FormData): Promise<void> {
  const meta = metaSchema.parse({ label: formData.get("label"), format: formData.get("format") });
  const file = formData.get("file");
  if (!(file instanceof File) || file.type !== "application/pdf") throw new Error("a PDF file is required");
  if (file.size > MAX_BYTES) throw new Error("PDF exceeds 5 MB limit");
  const bytes = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dir = path.join(loadConfig().fileStorageDir, "cvs");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${randomUUID()}.pdf`);
  await writeFile(filePath, bytes);
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  await createCvVariant(db, { workspaceId: ws.id, ...meta, filePath, sha256 });
  revalidatePath("/cvs");
}
