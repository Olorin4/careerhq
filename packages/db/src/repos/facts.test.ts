import { beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, workspaces } from "../index.js";
import {
  archiveFact, createFact, isFactStale, listFacts, reverifyFact,
} from "./facts.js";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

let db: Db;
let workspaceId: string;

beforeAll(async () => {
  db = createDb(url!);
  const [ws] = await db.insert(workspaces).values({ name: `t-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;
});

d("facts repo", () => {
  it("creates, lists, archives", async () => {
    const fact = await createFact(db, {
      workspaceId, category: "skill", claim: "TypeScript (5 years)",
      reviewBy: new Date("2027-01-01"),
    });
    expect(fact.sensitivity).toBe("normal");
    await archiveFact(db, fact.id);
    const visible = await listFacts(db, workspaceId);
    expect(visible.find((f) => f.id === fact.id)).toBeUndefined();
    const all = await listFacts(db, workspaceId, { includeArchived: true });
    expect(all.find((f) => f.id === fact.id)).toBeDefined();
  });

  it("flags stale facts past review_by (spec §7.1)", () => {
    expect(isFactStale({ reviewBy: new Date("2026-01-01") }, new Date("2026-08-01"))).toBe(true);
    expect(isFactStale({ reviewBy: new Date("2027-01-01") }, new Date("2026-08-01"))).toBe(false);
  });

  it("re-verifying resets verified_at and review_by", async () => {
    const fact = await createFact(db, {
      workspaceId, category: "experience", claim: "Built a TMS", reviewBy: new Date("2026-01-01"),
    });
    const updated = await reverifyFact(db, fact.id, new Date("2027-06-01"));
    expect(updated?.reviewBy.toISOString()).toBe("2027-06-01T00:00:00.000Z");
  });
});
