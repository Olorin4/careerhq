import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, workspaces } from "../index.js";
import { createApplication } from "./applications.js";
import { createSiteAttempt } from "./attempts.js";

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
