import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CanonicalForm } from "@careerhq/contracts";
import { applicationAttempts, createDb, type Db, workspaces } from "../index.js";
import { createApplication } from "./applications.js";
import {
  createSiteAttempt, getAttempt, listEvidenceScreenshotPaths, markAttemptBlocked, markAttemptReady,
} from "./attempts.js";
import { saveFormSnapshot, updateRecoveryState } from "./form-snapshots.js";

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

d("attempts repo — listEvidenceScreenshotPaths (the demo screenshot collector's live set)", () => {
  /**
   * The collector DELETES every file it does not see here, so the only thing
   * that matters about this query is that it misses nothing. Both writers are
   * exercised: apps/web records its screenshot on the attempt's confirmed
   * receipt, the worker's queue job records its own on the form snapshot's
   * recovery state, and they share one directory tree.
   */
  it("returns both writers' paths and ignores rows that carry no screenshot", async () => {
    const app = await createApplication(db, { workspaceId, companyName: "Shots Co", jobTitle: "Engineer" });
    const stamp = `${Date.now()}-${Math.random()}`;
    const receiptPath = `/app/var/files/site-screenshots/${stamp}-web.png`;
    const recoveryPath = `/app/var/files/autoapply/${stamp}-worker.png`;

    const withReceipt = await createSiteAttempt(db, { applicationId: app.id, url: "https://acme.example/a" });
    await db.update(applicationAttempts)
      .set({ confirmedReceipt: { channel: "company_site", screenshotPath: receiptPath } })
      .where(eq(applicationAttempts.id, withReceipt.id));

    // An attempt with a receipt that has no screenshot at all — the `->>` must
    // yield NULL and be dropped, not turned into an empty path that matches
    // nothing and would be harmless only by luck.
    const noShot = await createSiteAttempt(db, { applicationId: app.id, url: "https://acme.example/b" });
    await db.update(applicationAttempts)
      .set({ confirmedReceipt: { channel: "email", messageId: "x" } })
      .where(eq(applicationAttempts.id, noShot.id));

    const forSnapshot = await createSiteAttempt(db, { applicationId: app.id, url: "https://acme.example/c" });
    const snapshot = await saveFormSnapshot(db, {
      attemptId: forSnapshot.id,
      form: {
        atsType: "generic", url: "https://acme.example/c", requisitionKey: "c",
        parserVersion: "1", fields: [],
      } as unknown as CanonicalForm,
      answers: [],
    });
    await updateRecoveryState(db, snapshot.id, 1, { kind: "submit_result", screenshotPath: recoveryPath });

    // And a snapshot whose recovery state is the CAPTURE step's — no
    // screenshot in it, and it must not contribute a bogus entry.
    const capturedOnly = await createSiteAttempt(db, { applicationId: app.id, url: "https://acme.example/d" });
    const rawSnapshot = await saveFormSnapshot(db, {
      attemptId: capturedOnly.id,
      form: {
        atsType: "generic", url: "https://acme.example/d", requisitionKey: "d",
        parserVersion: "1", fields: [],
      } as unknown as CanonicalForm,
      answers: [],
    });
    await updateRecoveryState(db, rawSnapshot.id, 0, { kind: "raw_page", page: { html: "" } });

    const paths = await listEvidenceScreenshotPaths(db);
    expect(paths).toContain(receiptPath);
    expect(paths).toContain(recoveryPath);
    expect(paths.filter((p) => p.includes(stamp))).toHaveLength(2);
    expect(paths.every((p) => typeof p === "string" && p.length > 0)).toBe(true);
  });
});
