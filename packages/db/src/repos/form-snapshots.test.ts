import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CanonicalForm, PlannedAnswer } from "@careerhq/contracts";
import { createDb, type Db, workspaces } from "../index.js";
import { applicationAttempts } from "../schema/index.js";
import { createApplication } from "./applications.js";
import { createSiteAttempt } from "./attempts.js";
import {
  findRequisitionAttempt, getLatestSnapshot, saveFormSnapshot, updateRecoveryState, updateSnapshotAnswers,
} from "./form-snapshots.js";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

let db: Db;
let workspaceId: string;

function canonicalForm(overrides: Partial<CanonicalForm> = {}): CanonicalForm {
  return {
    atsType: "greenhouse",
    parserVersion: "generic-v1",
    url: "https://acme.example/jobs/123/apply",
    requisitionKey: "acme.example/jobs/123",
    title: "Senior Engineer",
    companyName: "Acme",
    totalSteps: 1,
    fields: [{
      id: "field-1", kind: "text", label: "First name", helpText: "", required: true, options: [],
      step: 0, canonicalField: "first_name", mappingConfidence: 0.9, sensitive: false,
    }],
    blockers: [],
    parseConfidence: 0.9,
    ...overrides,
  };
}

function plannedAnswers(): PlannedAnswer[] {
  return [{
    fieldId: "field-1", value: "Alex", source: "user", sourceFactIds: [], confidence: 1,
    needsUser: false, differsFromApproved: false, note: "",
  }];
}

beforeAll(async () => {
  if (!url) return;
  db = createDb(url);
  const [ws] = await db.insert(workspaces).values({ name: `t-snap-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;
});

afterAll(async () => {
  if (!url) return;
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.$client.end();
});

async function siteAttempt(companyName: string, requestUrl = "https://acme.example/jobs/123/apply"): Promise<{
  applicationId: string; attemptId: string;
}> {
  const app = await createApplication(db, { workspaceId, companyName, jobTitle: "Engineer" });
  const attempt = await createSiteAttempt(db, { applicationId: app.id, url: requestUrl });
  return { applicationId: app.id, attemptId: attempt.id };
}

d("form-snapshots repo", () => {
  it("round-trips a saved snapshot through getLatestSnapshot", async () => {
    const { attemptId } = await siteAttempt("Snapshot Co");
    const form = canonicalForm();
    const answers = plannedAnswers();

    const saved = await saveFormSnapshot(db, { attemptId, form, answers });
    expect(saved.attemptId).toBe(attemptId);
    expect(saved.atsType).toBe("greenhouse");
    expect(saved.url).toBe(form.url);
    expect(saved.requisitionKey).toBe(form.requisitionKey);
    expect(saved.parserVersion).toBe(form.parserVersion);
    expect(saved.canonicalForm).toEqual(form);
    expect(saved.plannedAnswers).toEqual(answers);
    expect(saved.currentStep).toBe(0);
    expect(saved.recoveryState).toBeNull();
    expect(saved.capturedAt).toBeInstanceOf(Date);

    const latest = await getLatestSnapshot(db, attemptId);
    expect(latest?.id).toBe(saved.id);
    expect(latest?.canonicalForm).toEqual(form);
    expect(latest?.plannedAnswers).toEqual(answers);
  });

  it("returns null from getLatestSnapshot when the attempt has no snapshot yet", async () => {
    const { attemptId } = await siteAttempt("No Snapshot Co");
    expect(await getLatestSnapshot(db, attemptId)).toBeNull();
  });

  it("getLatestSnapshot returns the most recently captured snapshot for the attempt", async () => {
    const { attemptId } = await siteAttempt("Multi Snapshot Co");
    await saveFormSnapshot(db, { attemptId, form: canonicalForm(), answers: plannedAnswers() });
    const second = await saveFormSnapshot(db, {
      attemptId, form: canonicalForm({ title: "Staff Engineer" }), answers: plannedAnswers(),
    });

    const latest = await getLatestSnapshot(db, attemptId);
    expect(latest?.id).toBe(second.id);
    expect((latest?.canonicalForm as CanonicalForm).title).toBe("Staff Engineer");
  });

  it("updateSnapshotAnswers replaces the planned-answers array", async () => {
    const { attemptId } = await siteAttempt("Update Answers Co");
    const saved = await saveFormSnapshot(db, { attemptId, form: canonicalForm(), answers: plannedAnswers() });

    const replacement: PlannedAnswer[] = [{
      fieldId: "field-1", value: "Alexandra", source: "ai", sourceFactIds: ["fact-1"], confidence: 0.8,
      needsUser: true, differsFromApproved: true, note: "needs review",
    }];
    const updated = await updateSnapshotAnswers(db, saved.id, replacement);
    expect(updated?.plannedAnswers).toEqual(replacement);

    const latest = await getLatestSnapshot(db, attemptId);
    expect(latest?.plannedAnswers).toEqual(replacement);
  });

  it("updateSnapshotAnswers returns null for an unknown snapshot id", async () => {
    expect(await updateSnapshotAnswers(db, "00000000-0000-0000-0000-000000000000", plannedAnswers())).toBeNull();
  });

  it("updateRecoveryState persists the current step and recovery state", async () => {
    const { attemptId } = await siteAttempt("Recovery Co");
    const saved = await saveFormSnapshot(db, { attemptId, form: canonicalForm(), answers: plannedAnswers() });

    await updateRecoveryState(db, saved.id, 2, { lastFieldId: "field-1", note: "resumed after crash" });

    const latest = await getLatestSnapshot(db, attemptId);
    expect(latest?.currentStep).toBe(2);
    expect(latest?.recoveryState).toEqual({ lastFieldId: "field-1", note: "resumed after crash" });
  });

  it("findRequisitionAttempt returns null for a requisition key with no prior attempt", async () => {
    expect(await findRequisitionAttempt(db, workspaceId, "never-seen/req-key")).toBeNull();
  });

  it("findRequisitionAttempt finds the confirmed (SUBMITTED) attempt for a duplicate requisition key", async () => {
    const key = `dup-key-${Date.now()}`;
    const { applicationId, attemptId } = await siteAttempt("Duplicate Co");
    await saveFormSnapshot(db, { attemptId, form: canonicalForm({ requisitionKey: key }), answers: plannedAnswers() });
    await db.update(applicationAttempts).set({ status: "SUBMITTED", submittedAt: new Date() })
      .where(eq(applicationAttempts.id, attemptId));

    const found = await findRequisitionAttempt(db, workspaceId, key);
    expect(found).toEqual({ attemptId, applicationId });
  });

  it("findRequisitionAttempt returns null when the only prior attempt FAILED — not a duplicate", async () => {
    const key = `failed-key-${Date.now()}`;
    const { attemptId } = await siteAttempt("Failed Prior Co");
    await saveFormSnapshot(db, { attemptId, form: canonicalForm({ requisitionKey: key }), answers: plannedAnswers() });
    await db.update(applicationAttempts).set({ status: "FAILED", failureReason: "blocked by captcha" })
      .where(eq(applicationAttempts.id, attemptId));

    expect(await findRequisitionAttempt(db, workspaceId, key)).toBeNull();
  });

  it("findRequisitionAttempt is scoped to the workspace: a SUBMITTED attempt in another workspace does not match", async () => {
    const key = `cross-ws-key-${Date.now()}`;
    const [otherWs] = await db.insert(workspaces).values({ name: `t-snap-other-${Date.now()}`, kind: "personal" }).returning();
    try {
      const app = await createApplication(db, { workspaceId: otherWs!.id, companyName: "Other WS Co", jobTitle: "Engineer" });
      const attempt = await createSiteAttempt(db, { applicationId: app.id, url: "https://acme.example/jobs/999/apply" });
      await saveFormSnapshot(db, {
        attemptId: attempt.id, form: canonicalForm({ requisitionKey: key }), answers: plannedAnswers(),
      });
      await db.update(applicationAttempts).set({ status: "SUBMITTED", submittedAt: new Date() })
        .where(eq(applicationAttempts.id, attempt.id));

      expect(await findRequisitionAttempt(db, workspaceId, key)).toBeNull();
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, otherWs!.id));
    }
  });
});
