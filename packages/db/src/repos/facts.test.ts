import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { candidateFacts, createDb, type Db, workspaces } from "../index.js";
import {
  archiveFact, createFact, isFactStale, listFacts, reverifyFact,
} from "./facts.js";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

let db: Db;
let workspaceId: string;

beforeAll(async () => {
  if (!url) return;
  db = createDb(url);
  const [ws] = await db.insert(workspaces).values({ name: `t-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;
});

// The throwaway workspace would otherwise accumulate in the dev database and
// compete with the seeded one for `getActiveWorkspace`. Deleting it cascades
// to everything these tests created.
afterAll(async () => {
  if (!url) return;
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.$client.end();
});

d("facts repo", () => {
  it("creates, lists, archives", async () => {
    const fact = await createFact(db, {
      workspaceId, category: "skill", claim: "TypeScript (5 years)",
      reviewBy: new Date("2027-01-01"),
    });
    expect(fact.sensitivity).toBe("normal");
    await archiveFact(db, workspaceId, fact.id);
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
    const updated = await reverifyFact(db, workspaceId, fact.id, new Date("2027-06-01"));
    expect(updated?.reviewBy.toISOString()).toBe("2027-06-01T00:00:00.000Z");
  });

  it("listFacts returns the same order on every read when category and created_at tie", async () => {
    const claims = Array.from({ length: 8 }, (_, i) => `tie fact ${i}`);
    for (const claim of claims) {
      await createFact(db, {
        workspaceId, category: "skill", claim, reviewBy: new Date("2027-01-01"),
      });
    }
    // A seed that inserts a batch inside one transaction can land several facts
    // on the same created_at; pinning them here reproduces that exactly.
    await db.update(candidateFacts).set({ createdAt: new Date("2026-06-01T00:00:00Z") })
      .where(and(eq(candidateFacts.workspaceId, workspaceId), inArray(candidateFacts.claim, claims)));

    const readOrder = async (): Promise<string[]> => (await listFacts(db, workspaceId))
      .filter((f) => f.claim.startsWith("tie fact "))
      .map((f) => f.id);

    const first = await readOrder();
    expect(first).toHaveLength(claims.length);
    // Each UPDATE rewrites its row at the end of the heap, which is what made
    // the untied query come back in a different order between reads.
    for (const id of first) {
      await db.update(candidateFacts).set({ verifiedAt: new Date() }).where(eq(candidateFacts.id, id));
      expect(await readOrder()).toEqual(first);
    }
    expect(first).toEqual([...first].sort());
  });

  it("refuses to archive a fact belonging to another workspace", async () => {
    const other = await db.insert(workspaces).values({ name: `t-other-${Date.now()}`, kind: "personal" }).returning();
    const otherId = other[0]!.id;
    try {
      const fact = await createFact(db, {
        workspaceId: otherId, category: "skill", claim: "Other workspace fact", reviewBy: new Date("2027-01-01"),
      });
      await archiveFact(db, workspaceId, fact.id);              // wrong workspace
      const stillVisible = await listFacts(db, otherId);
      expect(stillVisible.find((f) => f.id === fact.id)).toBeDefined();  // untouched
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, otherId));
    }
  });
});
