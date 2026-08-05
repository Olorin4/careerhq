import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { normalizeQuestion } from "@careerhq/core";
import type { AnswerOrigin, Sensitivity } from "@careerhq/contracts";
import type { Db, DbOrTx } from "../client.js";
import { applicationAnswers, applications } from "../schema/index.js";
import type { ApplicationAnswer } from "../index.js";

export interface CreateAnswerInput {
  applicationId: string;
  questionRaw: string;
  answer: string;
  origin: AnswerOrigin;
  sourceFactIds?: string[];
  confidence?: number | null;
  sensitivity?: Sensitivity;
}

export async function createAnswer(db: DbOrTx, input: CreateAnswerInput): Promise<ApplicationAnswer> {
  const [answer] = await db.insert(applicationAnswers).values({
    applicationId: input.applicationId,
    questionRaw: input.questionRaw,
    questionNorm: normalizeQuestion(input.questionRaw),
    answer: input.answer,
    origin: input.origin,
    sourceFactIds: input.sourceFactIds ?? [],
    confidence: input.confidence,
    sensitivity: input.sensitivity,
  }).returning();
  return answer!;
}

function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  result.setMonth(result.getMonth() + months);
  return result;
}

/**
 * Scoped to `workspaceId` via the answer's application (there is no
 * `workspace_id` column on `application_answers` itself) — mirrors
 * `listReusableAnswers`'s application join so an answer can only be
 * approved by the workspace that owns its application.
 */
export async function approveAnswer(
  db: DbOrTx,
  workspaceId: string,
  id: string,
  opts: { reusable: boolean; reviewBy?: Date },
): Promise<ApplicationAnswer | null> {
  const reviewBy = opts.reviewBy ?? (opts.reusable ? addMonths(new Date(), 12) : null);
  const [updated] = await db.update(applicationAnswers).set({
    approval: "approved",
    approvedAt: sql`clock_timestamp()`,
    reusable: opts.reusable,
    reviewBy,
  }).where(and(
    eq(applicationAnswers.id, id),
    inArray(
      applicationAnswers.applicationId,
      db.select({ id: applications.id }).from(applications).where(eq(applications.workspaceId, workspaceId)),
    ),
  )).returning();
  return updated ?? null;
}

/** Scoped to `workspaceId` via the answer's application — see `approveAnswer`. */
export async function rejectAnswer(db: Db, workspaceId: string, id: string): Promise<ApplicationAnswer | null> {
  const [updated] = await db.update(applicationAnswers).set({ approval: "rejected" })
    .where(and(
      eq(applicationAnswers.id, id),
      inArray(
        applicationAnswers.applicationId,
        db.select({ id: applications.id }).from(applications).where(eq(applications.workspaceId, workspaceId)),
      ),
    )).returning();
  return updated ?? null;
}

export async function listAnswers(db: Db, applicationId: string): Promise<ApplicationAnswer[]> {
  return db.select().from(applicationAnswers)
    .where(eq(applicationAnswers.applicationId, applicationId))
    // `id` last so equal-timestamped rows cannot swap places between renders.
    .orderBy(asc(applicationAnswers.createdAt), asc(applicationAnswers.id));
}

export async function listReusableAnswers(
  db: DbOrTx,
  workspaceId: string,
): Promise<Array<ApplicationAnswer & { staleForReuse: boolean }>> {
  const rows = await db.select({ answer: applicationAnswers })
    .from(applicationAnswers)
    .innerJoin(applications, eq(applicationAnswers.applicationId, applications.id))
    .where(and(
      eq(applications.workspaceId, workspaceId),
      eq(applicationAnswers.approval, "approved"),
      eq(applicationAnswers.reusable, true),
    ))
    // Two applications answering the same question normalize to the same
    // `question_norm`, so this key ties by construction — `id` decides.
    .orderBy(asc(applicationAnswers.questionNorm), asc(applicationAnswers.id));

  const now = new Date();
  return rows.map(({ answer }) => ({
    ...answer,
    staleForReuse: answer.reviewBy !== null && answer.reviewBy < now,
  }));
}
