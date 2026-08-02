import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { companies, createDb, type Db, workspaces } from "../index.js";
import { createApplication, transitionApplication, getApplicationDetail } from "./applications.js";
import { getOrCreateCompany } from "./discovery.js";

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

d("applications repo", () => {
  it("creates an application at DISCOVERED with a creation event", async () => {
    const app = await createApplication(db, { workspaceId, companyName: "Acme", jobTitle: "Engineer" });
    expect(app.state).toBe("DISCOVERED");
    const detail = await getApplicationDetail(db, app.id);
    expect(detail?.events).toHaveLength(1);
    expect(detail?.events[0]?.toState).toBe("DISCOVERED");
  });

  it("performs a guarded transition and appends an event", async () => {
    const app = await createApplication(db, { workspaceId, companyName: "Beta", jobTitle: "Dev" });
    const r = await transitionApplication(db, { applicationId: app.id, to: "SHORTLISTED", trigger: "user" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.application.state).toBe("SHORTLISTED");
      expect(r.application.nextAction).toBe("Start preparing");
    }
    const detail = await getApplicationDetail(db, app.id);
    expect(detail?.events).toHaveLength(2);
  });

  it("refuses an illegal transition and appends nothing", async () => {
    const app = await createApplication(db, { workspaceId, companyName: "Gamma", jobTitle: "Dev" });
    const r = await transitionApplication(db, { applicationId: app.id, to: "SUBMITTED", trigger: "user" });
    expect(r.ok).toBe(false);
    const detail = await getApplicationDetail(db, app.id);
    expect(detail?.application.state).toBe("DISCOVERED");
    expect(detail?.events).toHaveLength(1);
  });

  it("logs a manual external application at SUBMITTED with an external attempt", async () => {
    const submittedAt = new Date("2026-08-01T00:00:00Z");
    const app = await createApplication(db, {
      workspaceId, companyName: "Delta", jobTitle: "Dev", asExternalSubmitted: true, submittedAt,
    });
    expect(app.state).toBe("SUBMITTED");
    expect(app.nextAction).toBe("Follow up");
    expect(app.nextActionDue?.toISOString()).toBe("2026-08-08T00:00:00.000Z");
  });

  // Migration 0001 added UNIQUE(workspace_id, name) on companies, and discovery
  // ingest populates that table en masse. A bare insert here would raise
  // SQLSTATE 23505 the moment someone files a manual application against a
  // company discovery already knows about.
  it("reuses an existing company row instead of violating companies_workspace_name", async () => {
    const companyId = await getOrCreateCompany(db, workspaceId, "Epsilon");

    const app = await createApplication(db, { workspaceId, companyName: "Epsilon", jobTitle: "Dev" });

    const detail = await getApplicationDetail(db, app.id);
    expect(detail?.job.companyId).toBe(companyId);
    const rows = await db.select().from(companies)
      .where(and(eq(companies.workspaceId, workspaceId), eq(companies.name, "Epsilon")));
    expect(rows).toHaveLength(1);
  });

  it("creates the company on first use and reuses it on a second application", async () => {
    const first = await createApplication(db, { workspaceId, companyName: "Zeta", jobTitle: "Dev" });
    const second = await createApplication(db, { workspaceId, companyName: "Zeta", jobTitle: "Staff Dev" });

    const firstDetail = await getApplicationDetail(db, first.id);
    const secondDetail = await getApplicationDetail(db, second.id);
    expect(firstDetail?.job.companyId).toBe(secondDetail?.job.companyId);
    const rows = await db.select().from(companies)
      .where(and(eq(companies.workspaceId, workspaceId), eq(companies.name, "Zeta")));
    expect(rows).toHaveLength(1);
  });
});
