import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { AnswerOrigin, ApprovalState, DocumentKind } from "@careerhq/contracts";
import type { Db, DbOrTx } from "../client.js";
import { applications, generatedDocuments } from "../schema/index.js";
import type { GeneratedDocument } from "../index.js";

export interface CreateDocumentInput {
  applicationId: string;
  kind: DocumentKind;
  contentMd: string;
  sourceFactIds: string[];
  model?: string | null;
  origin?: AnswerOrigin; // default "ai"
}

export async function createDocument(db: DbOrTx, input: CreateDocumentInput): Promise<GeneratedDocument> {
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

/**
 * Scoped to `workspaceId` via the document's application (there is no
 * `workspace_id` column on `generated_documents` itself) — mirrors
 * `listReusableAnswers`'s application join so a document can only be
 * approved/rejected by the workspace that owns its application.
 */
export async function setDocumentApproval(
  db: DbOrTx,
  workspaceId: string,
  id: string,
  approval: ApprovalState,
): Promise<GeneratedDocument | null> {
  const [updated] = await db.update(generatedDocuments).set({
    approval,
    approvedAt: approval === "approved" ? sql`clock_timestamp()` : null,
  }).where(and(
    eq(generatedDocuments.id, id),
    inArray(
      generatedDocuments.applicationId,
      db.select({ id: applications.id }).from(applications).where(eq(applications.workspaceId, workspaceId)),
    ),
  )).returning();
  return updated ?? null;
}

export async function listDocuments(db: Db, applicationId: string): Promise<GeneratedDocument[]> {
  return db.select().from(generatedDocuments)
    .where(eq(generatedDocuments.applicationId, applicationId))
    // `id` last so equal-timestamped rows cannot swap places between renders.
    .orderBy(desc(generatedDocuments.createdAt), asc(generatedDocuments.id));
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
