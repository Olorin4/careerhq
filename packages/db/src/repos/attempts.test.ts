import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, workspaces } from "../index.js";
import { createApplication } from "./applications.js";
import { createSiteAttempt, getAttempt, markAttemptBlocked, markAttemptReady } from "./attempts.js";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

let db: Db;
let workspaceId: string;

beforeAll(async () => {
  if (!url) return;
  db = createDb(url);
  const [ws] = await db.insert(workspaces).values({ name: `t-site-att-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;
});

afterAll(async () => {
  if (!url) return;
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.$client.end();
});

d("attempts repo — createSiteAttempt (channel-agnostic extraction)", () => {
  it("creates a company_site attempt in DRAFT with the url in draft_payload", async () => {
    const app = await createApplication(db, { workspaceId, companyName: "Site Co", jobTitle: "Engineer" });
    const attempt = await createSiteAttempt(db, {
      applicationId: app.id, url: "https://acme.example/jobs/123/apply",
    });

    expect(attempt.applicationId).toBe(app.id);
    expect(attempt.channel).toBe("company_site");
    expect(attempt.status).toBe("DRAFT");
    expect(attempt.draftPayload).toEqual({ url: "https://acme.example/jobs/123/apply" });
  });
});

d("attempts repo — pausing an attempt", () => {
  async function siteAttempt(companyName: string): Promise<string> {
    const app = await createApplication(db, { workspaceId, companyName, jobTitle: "Engineer" });
    const attempt = await createSiteAttempt(db, { applicationId: app.id, url: "https://acme.example/apply" });
    return attempt.id;
  }

  it("parks a freshly captured DRAFT attempt in BLOCKED with a legible reason", async () => {
    const attemptId = await siteAttempt("Blocked Co");
    expect(await markAttemptBlocked(db, attemptId, "captcha: finish this one in your browser")).toEqual({ ok: true });

    const attempt = await getAttempt(db, attemptId);
    expect(attempt?.status).toBe("BLOCKED");
    expect(attempt?.failureReason).toBe("captcha: finish this one in your browser");
    expect(attempt?.submittedAt).toBeNull();
  });

  it("parks a READY attempt too, and refuses to reanimate a blocked one", async () => {
    const attemptId = await siteAttempt("Ready Then Blocked Co");
    expect(await markAttemptReady(db, attemptId)).toEqual({ ok: true });
    expect(await markAttemptBlocked(db, attemptId, "login_required: sign in first")).toEqual({ ok: true });

    const retry = await markAttemptReady(db, attemptId);
    expect(retry.ok).toBe(false);
    expect((await getAttempt(db, attemptId))?.status).toBe("BLOCKED");
  });

  it("reports a refusal instead of throwing for an unknown attempt", async () => {
    const missing = await markAttemptBlocked(db, "00000000-0000-0000-0000-000000000000", "gone");
    expect(missing.ok).toBe(false);
  });
});
