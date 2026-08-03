import { and, desc, eq, sql } from "drizzle-orm";
import type { AnswerOrigin, ApprovalState, DocumentKind } from "@careerhq/contracts";
import type { Db } from "../client.js";
import { generatedDocuments } from "../schema/index.js";
import type { GeneratedDocument } from "../index.js";

export interface CreateDocumentInput {
  applicationId: string;
  kind: DocumentKind;
  contentMd: string;
  sourceFactIds: string[];
  model?: string | null;
  origin?: AnswerOrigin; // default "ai"
}

export async function createDocument(db: Db, input: CreateDocumentInput): Promise<GeneratedDocument> {
  const [doc] = await db.insert(generatedDocuments).values({
    applicationId: input.applicationId,
    kind: input.kind,
    contentMd: input.contentMd,
    sourceFactIds: input.sourceFactIds,
    model: input.model,
    origin: input.origin ?? "ai",
  }).returning();
  return doc!;
}

export async function setDocumentApproval(
  db: Db,
  id: string,
  approval: ApprovalState,
): Promise<GeneratedDocument | null> {
  const [updated] = await db.update(generatedDocuments).set({
    approval,
    approvedAt: approval === "approved" ? sql`now()` : null,
  }).where(eq(generatedDocuments.id, id)).returning();
  return updated ?? null;
}

export async function listDocuments(db: Db, applicationId: string): Promise<GeneratedDocument[]> {
  return db.select().from(generatedDocuments)
    .where(eq(generatedDocuments.applicationId, applicationId))
    .orderBy(desc(generatedDocuments.createdAt));
}

/**
 * Whether the application has at least one approved `generated_documents`
 * row. This is the "materials exist" half of the READY_FOR_REVIEW gate (the
 * other half — a selected CV variant — lives on the application row itself
 * and is checked by the caller).
 */
export async function hasApprovedMaterials(db: Db, applicationId: string): Promise<boolean> {
  const [row] = await db.select({ id: generatedDocuments.id }).from(generatedDocuments)
    .where(and(
      eq(generatedDocuments.applicationId, applicationId),
      eq(generatedDocuments.approval, "approved"),
    ))
    .limit(1);
  return row !== undefined;
}
