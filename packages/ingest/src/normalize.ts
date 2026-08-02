import { createHash } from "node:crypto";
import type { NormalizedJob } from "@careerhq/contracts";

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

export function stripHtml(html: string): string {
  let text = html.replace(/<[^>]*>/g, " ");
  for (const [entity, char] of Object.entries(ENTITIES)) text = text.replaceAll(entity, char);
  return text.replace(/\s+/g, " ").trim();
}

export function contentHashOf(job: Pick<NormalizedJob, "companyName" | "title" | "descriptionMd">): string {
  const desc = stripHtml(job.descriptionMd ?? "").toLowerCase().slice(0, 500);
  const key = `${job.companyName.toLowerCase().trim()}|${job.title.toLowerCase().trim()}|${desc}`;
  return createHash("sha256").update(key).digest("hex");
}
