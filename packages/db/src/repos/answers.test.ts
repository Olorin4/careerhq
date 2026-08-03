import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createApplication, createDb, type Db, workspaces } from "../index.js";
import {
  approveAnswer, createAnswer, listAnswers, listReusableAnswers, rejectAnswer,
} from "./answers.js";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

let db: Db;
let workspaceId: string;
let applicationId: string;

beforeAll(async () => {
  if (!url) return;
  db = createDb(url);
  const [ws] = await db.insert(workspaces).values({ name: `t-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;
  const app = await createApplication(db, {
    workspaceId, companyName: "Acme Corp", jobTitle: "Engineer",
  });
  applicationId = app.id;
});

afterAll(async () => {
  if (!url) return;
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.$client.end();
});

d("answers repo", () => {
  it("normalizes the question and starts as draft", async () => {
    const a = await createAnswer(db, {
      applicationId, questionRaw: "Why THIS job?!", answer: "Because.", origin: "user",
    });
    expect(a.questionNorm).toBe("why this job");
    expect(a.approval).toBe("draft");
  });

  it("approve with reusable sets reviewBy and surfaces in the workspace bank; stale flagged", async () => {
    const a = await createAnswer(db, {
      applicationId, questionRaw: "Notice period?", answer: "Two weeks", origin: "user",
    });
    await approveAnswer(db, a.id, { reusable: true, reviewBy: new Date(Date.now() - 86400_000) });
    const bank = await listReusableAnswers(db, workspaceId);
    const row = bank.find((r) => r.id === a.id);
    expect(row?.staleForReuse).toBe(true);
  });

  it("approve with reusable and no reviewBy defaults to twelve months out and is not stale", async () => {
    const a = await createAnswer(db, {
      applicationId, questionRaw: "Are you willing to relocate?", answer: "Yes", origin: "user",
    });
    const approved = await approveAnswer(db, a.id, { reusable: true });
    expect(approved?.reviewBy).toBeInstanceOf(Date);
    const twelveMonthsOut = new Date();
    twelveMonthsOut.setMonth(twelveMonthsOut.getMonth() + 11);
    expect(approved!.reviewBy!.getTime()).toBeGreaterThan(twelveMonthsOut.getTime());
    const bank = await listReusableAnswers(db, workspaceId);
    expect(bank.find((r) => r.id === a.id)?.staleForReuse).toBe(false);
  });

  it("non-reusable approvals do not enter the bank", async () => {
    const a = await createAnswer(db, {
      applicationId, questionRaw: "One-off?", answer: "Yes", origin: "ai",
    });
    await approveAnswer(db, a.id, { reusable: false });
    expect((await listReusableAnswers(db, workspaceId)).find((r) => r.id === a.id)).toBeUndefined();
  });

  it("rejecting sets approval to rejected", async () => {
    const a = await createAnswer(db, {
      applicationId, questionRaw: "Rejected question?", answer: "No", origin: "ai",
    });
    await rejectAnswer(db, a.id);
    const [found] = await listAnswers(db, applicationId).then((rows) => rows.filter((r) => r.id === a.id));
    expect(found?.approval).toBe("rejected");
  });

  it("lists answers for an application in creation order", async () => {
    const rows = await listAnswers(db, applicationId);
    const createdAts = rows.map((r) => r.createdAt.getTime());
    const sorted = [...createdAts].sort((a, b) => a - b);
    expect(createdAts).toEqual(sorted);
  });

  it("the reusable bank is ordered by normalized question ascending", async () => {
    const bank = await listReusableAnswers(db, workspaceId);
    const norms = bank.map((r) => r.questionNorm);
    const sorted = [...norms].sort();
    expect(norms).toEqual(sorted);
  });

  it("scopes the reusable bank to its own workspace, never surfacing another workspace's reusable answers", async () => {
    const [otherWs] = await db.insert(workspaces)
      .values({ name: `t-other-${Date.now()}`, kind: "personal" }).returning();
    const otherWorkspaceId = otherWs!.id;
    const otherApplication = await createApplication(db, {
      workspaceId: otherWorkspaceId, companyName: "Other Corp", jobTitle: "Other Engineer",
    });
    const otherAnswer = await createAnswer(db, {
      applicationId: otherApplication.id, questionRaw: "Other workspace question?",
      answer: "Other workspace answer", origin: "user",
    });
    await approveAnswer(db, otherAnswer.id, { reusable: true });

    try {
      const thisBank = await listReusableAnswers(db, workspaceId);
      expect(thisBank.find((r) => r.id === otherAnswer.id)).toBeUndefined();

      const otherBank = await listReusableAnswers(db, otherWorkspaceId);
      expect(otherBank.find((r) => r.id === otherAnswer.id)).toBeDefined();
      // And the inverse: the throwaway workspace must not see this suite's
      // own reusable answers either — isolation cuts both ways.
      expect(otherBank.some((r) => r.questionRaw !== "Other workspace question?")).toBe(false);
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, otherWorkspaceId));
    }
  });
});
