import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { FactCategory, Sensitivity } from "@careerhq/contracts";
import type { Db, DbOrTx } from "../client.js";
import { candidateFacts } from "../schema/index.js";
import type { CandidateFact } from "../index.js";

export interface FactInput {
  workspaceId: string; category: FactCategory; claim: string;
  detail?: string; evidenceUrl?: string; sensitivity?: Sensitivity;
  reviewBy: Date;
}

export async function createFact(db: DbOrTx, input: FactInput): Promise<CandidateFact> {
  const [fact] = await db.insert(candidateFacts).values({
    workspaceId: input.workspaceId,
    category: input.category,
    claim: input.claim,
    detail: input.detail,
    evidenceUrl: input.evidenceUrl,
    sensitivity: input.sensitivity,
    reviewBy: input.reviewBy,
  }).returning();
  return fact!;
}

export async function updateFact(
  db: Db,
  workspaceId: string,
  id: string,
  patch: Partial<Omit<FactInput, "workspaceId">>,
): Promise<CandidateFact | null> {
  const [updated] = await db.update(candidateFacts).set({
    ...(patch.category !== undefined ? { category: patch.category } : {}),
    ...(patch.claim !== undefined ? { claim: patch.claim } : {}),
    ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
    ...(patch.evidenceUrl !== undefined ? { evidenceUrl: patch.evidenceUrl } : {}),
    ...(patch.sensitivity !== undefined ? { sensitivity: patch.sensitivity } : {}),
    ...(patch.reviewBy !== undefined ? { reviewBy: patch.reviewBy } : {}),
  }).where(and(eq(candidateFacts.id, id), eq(candidateFacts.workspaceId, workspaceId))).returning();
  return updated ?? null;
}

export async function archiveFact(db: Db, workspaceId: string, id: string): Promise<void> {
  await db.update(candidateFacts).set({ archivedAt: sql`clock_timestamp()` })
    .where(and(eq(candidateFacts.id, id), eq(candidateFacts.workspaceId, workspaceId)));
}

export async function reverifyFact(
  db: Db,
  workspaceId: string,
  id: string,
  reviewBy: Date,
): Promise<CandidateFact | null> {
  const [updated] = await db.update(candidateFacts).set({
    verifiedAt: sql`clock_timestamp()`,
    reviewBy,
  }).where(and(eq(candidateFacts.id, id), eq(candidateFacts.workspaceId, workspaceId))).returning();
  return updated ?? null;
}

export async function listFacts(
  db: Db,
  workspaceId: string,
  opts?: { includeArchived?: boolean },
): Promise<CandidateFact[]> {
  const conditions = opts?.includeArchived
    ? eq(candidateFacts.workspaceId, workspaceId)
    : and(eq(candidateFacts.workspaceId, workspaceId), isNull(candidateFacts.archivedAt));
  return db.select().from(candidateFacts)
    .where(conditions)
    .orderBy(asc(candidateFacts.category), asc(candidateFacts.createdAt));
}

export function isFactStale(fact: Pick<CandidateFact, "reviewBy">, now?: Date): boolean {
  return fact.reviewBy.getTime() < (now ?? new Date()).getTime();
}
