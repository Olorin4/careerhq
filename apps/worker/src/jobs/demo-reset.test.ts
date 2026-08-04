import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { loadConfig, type AppConfig } from "@careerhq/config";
import {
  DEMO_WORKSPACE_NAME, applicationAnswers, applicationAttempts, applicationEvents, applications,
  candidateFacts, createApplication, createDb, createFact, credentials, cvVariants,
  emailConnections, emailMessages, generateMasterKeyB64, generatedDocuments, jobs, workspaces,
  type Db,
} from "@careerhq/db";
import { runDemoResetOnce } from "./demo-reset.js";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

let db: Db;
let config: AppConfig;
/** Workspaces this suite inserts directly (never the demo one — the reset owns that). */
const throwawayWorkspaceIds: string[] = [];

beforeAll(async () => {
  if (!url) return;
  db = createDb(url);
  config = loadConfig({
    DATABASE_URL: url,
    // A private tree per run: the seed writes CV files and a screenshot, and
    // pointing at the repo's var/files would leave litter behind every test run.
    FILE_STORAGE_DIR: mkdtempSync(path.join(tmpdir(), "careerhq-demo-seed-")),
    CAREERHQ_MASTER_KEY: await generateMasterKeyB64(),
  });
});

afterAll(async () => {
  if (!url) return;
  for (const id of throwawayWorkspaceIds) {
    await db.delete(workspaces).where(eq(workspaces.id, id));
  }
  await db.$client.end();
});

/** Every demo workspace row — there must never be more than one. */
async function demoWorkspaces() {
  return db.select().from(workspaces)
    .where(and(eq(workspaces.kind, "sandbox"), eq(workspaces.name, DEMO_WORKSPACE_NAME)));
}

/**
 * Row counts across everything the seed builds, so "ran twice, same shape" is a
 * real assertion rather than a spot check. The per-application tables have no
 * `workspace_id` of their own and are counted through their application.
 */
async function countsFor(workspaceId: string): Promise<Record<string, number>> {
  const appIds = db.select({ id: applications.id }).from(applications)
    .where(eq(applications.workspaceId, workspaceId));
  const len = async (rows: Promise<unknown[]>): Promise<number> => (await rows).length;
  return {
    facts: await len(db.select({ id: candidateFacts.id }).from(candidateFacts)
      .where(eq(candidateFacts.workspaceId, workspaceId))),
    cvVariants: await len(db.select({ id: cvVariants.id }).from(cvVariants)
      .where(eq(cvVariants.workspaceId, workspaceId))),
    jobs: await len(db.select({ id: jobs.id }).from(jobs).where(eq(jobs.workspaceId, workspaceId))),
    applications: await len(db.select({ id: applications.id }).from(applications)
      .where(eq(applications.workspaceId, workspaceId))),
    events: await len(db.select({ id: applicationEvents.id }).from(applicationEvents)
      .where(inArray(applicationEvents.applicationId, appIds))),
    attempts: await len(db.select({ id: applicationAttempts.id }).from(applicationAttempts)
      .where(inArray(applicationAttempts.applicationId, appIds))),
    documents: await len(db.select({ id: generatedDocuments.id }).from(generatedDocuments)
      .where(inArray(generatedDocuments.applicationId, appIds))),
    answers: await len(db.select({ id: applicationAnswers.id }).from(applicationAnswers)
      .where(inArray(applicationAnswers.applicationId, appIds))),
    emailConnections: await len(db.select({ id: emailConnections.id }).from(emailConnections)
      .where(eq(emailConnections.workspaceId, workspaceId))),
    emailMessages: await len(db.select({ id: emailMessages.id }).from(emailMessages)
      .where(eq(emailMessages.workspaceId, workspaceId))),
    credentials: await len(db.select({ id: credentials.id }).from(credentials)
      .where(eq(credentials.workspaceId, workspaceId))),
  };
}

d("runDemoResetOnce", () => {
  it("seeds exactly one sandbox workspace named DEMO_WORKSPACE_NAME", async () => {
    const { workspaceId, durationMs } = await runDemoResetOnce(db, config);
    expect(durationMs).toBeGreaterThanOrEqual(0);

    const rows = await demoWorkspaces();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(workspaceId);
    expect(rows[0]!.kind).toBe("sandbox");
    expect(rows[0]!.name).toBe(DEMO_WORKSPACE_NAME);
  });

  it("is idempotent: a second run rebuilds the same shape, not a second workspace", async () => {
    const first = await runDemoResetOnce(db, config);
    const before = await countsFor(first.workspaceId);

    const second = await runDemoResetOnce(db, config);
    const after = await countsFor(second.workspaceId);

    expect(await demoWorkspaces()).toHaveLength(1);
    expect(after).toEqual(before);
    // Every count is a real one: an all-zero "match" would prove nothing.
    for (const [table, n] of Object.entries(after)) {
      expect(n, `${table} should be seeded`).toBeGreaterThan(0);
    }
  });

  it("throws away a visitor's edits", async () => {
    const { workspaceId } = await runDemoResetOnce(db, config);
    const visitorApp = await createApplication(db, {
      workspaceId, companyName: "Visitor Co", jobTitle: "Something A Visitor Filed",
    });
    expect(await db.select().from(applications).where(eq(applications.id, visitorApp.id))).toHaveLength(1);

    await runDemoResetOnce(db, config);
    expect(await db.select().from(applications).where(eq(applications.id, visitorApp.id))).toHaveLength(0);
  });

  // The point of the task: a self-hoster whose worker is misconfigured into
  // demo mode must not lose their real data. The reset is scoped by the demo
  // workspace's id, resolved by kind AND name — never "delete the sandbox rows".
  it("never touches a personal workspace in the same database", async () => {
    const [personal] = await db.insert(workspaces)
      .values({ name: `t-demo-reset-personal-${Date.now()}`, kind: "personal" }).returning();
    throwawayWorkspaceIds.push(personal!.id);
    const fact = await createFact(db, {
      workspaceId: personal!.id, category: "skill", claim: "Real, personal, not the demo's",
      reviewBy: new Date("2030-01-01"),
    });
    const app = await createApplication(db, {
      workspaceId: personal!.id, companyName: "Real Employer", jobTitle: "Real Role",
    });

    await runDemoResetOnce(db, config);

    expect(await db.select().from(workspaces).where(eq(workspaces.id, personal!.id))).toHaveLength(1);
    const facts = await db.select().from(candidateFacts).where(eq(candidateFacts.id, fact.id));
    expect(facts).toHaveLength(1);
    expect(facts[0]!.claim).toBe("Real, personal, not the demo's");
    expect(await db.select().from(applications).where(eq(applications.id, app.id))).toHaveLength(1);
  });

  // The demo compose deploys without a master key. The seeded mailbox password
  // goes through the normal libsodium seal path or not at all — a credential
  // nothing can open would be worse than no mailbox — so the rest of the demo
  // must still build without one.
  it("seeds everything except the mailbox when no master key is configured", async () => {
    const keyless = loadConfig({
      DATABASE_URL: url!,
      FILE_STORAGE_DIR: mkdtempSync(path.join(tmpdir(), "careerhq-demo-seed-nokey-")),
    });
    const { workspaceId } = await runDemoResetOnce(db, keyless);
    const counts = await countsFor(workspaceId);

    expect(counts.emailConnections).toBe(0);
    expect(counts.credentials).toBe(0);
    expect(counts.emailMessages).toBe(0);
    expect(counts.applications).toBeGreaterThan(0);
    expect(counts.attempts).toBeGreaterThan(0);
    expect(counts.documents).toBeGreaterThan(0);
  });

  // The same protection for a sandbox workspace that simply is not the demo's:
  // the e2e suites own sandbox-kind fixtures, and so may a self-hoster.
  it("never touches a sandbox workspace that is not the demo's", async () => {
    const [other] = await db.insert(workspaces)
      .values({ name: `t-demo-reset-sandbox-${Date.now()}`, kind: "sandbox" }).returning();
    throwawayWorkspaceIds.push(other!.id);

    await runDemoResetOnce(db, config);

    expect(await db.select().from(workspaces).where(eq(workspaces.id, other!.id))).toHaveLength(1);
  });
});

d("the seeded demo story", () => {
  let workspaceId: string;

  beforeAll(async () => {
    if (!url) return;
    ({ workspaceId } = await runDemoResetOnce(db, config));
  });

  it("has a fact bank with one stale and one sensitive fact", async () => {
    const facts = await db.select().from(candidateFacts)
      .where(eq(candidateFacts.workspaceId, workspaceId));
    expect(facts.length).toBeGreaterThanOrEqual(12);
    expect(facts.filter((f) => f.reviewBy.getTime() < Date.now()).length).toBeGreaterThanOrEqual(1);
    expect(facts.filter((f) => f.sensitivity === "sensitive").length).toBeGreaterThanOrEqual(1);
  });

  it("spreads applications across every state", async () => {
    const apps = await db.select().from(applications).where(eq(applications.workspaceId, workspaceId));
    expect(apps.length).toBeGreaterThanOrEqual(12);
    expect(new Set(apps.map((a) => a.state))).toEqual(new Set([
      "DISCOVERED", "SHORTLISTED", "PREPARING", "READY_FOR_REVIEW", "SUBMITTED",
      "ACKNOWLEDGED", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN", "EXPIRED",
    ]));
  });

  it("builds every application state through real transitions, so the event log is genuine", async () => {
    const appIds = db.select({ id: applications.id }).from(applications)
      .where(eq(applications.workspaceId, workspaceId));
    const events = await db.select().from(applicationEvents)
      .where(inArray(applicationEvents.applicationId, appIds));
    // Every application has at least its creation event, and the multi-step
    // stories add more: an empty or one-event-per-application log would mean
    // the states were written directly.
    const apps = await db.select().from(applications).where(eq(applications.workspaceId, workspaceId));
    expect(events.length).toBeGreaterThan(apps.length);
    for (const app of apps) {
      const mine = events.filter((e) => e.applicationId === app.id);
      expect(mine.length, `application ${app.id} has no events`).toBeGreaterThan(0);
      expect(mine.at(-1)).toBeDefined();
    }
    // The terminal event of each application matches the state it sits in.
    for (const app of apps) {
      const mine = events.filter((e) => e.applicationId === app.id)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      expect(mine.at(-1)!.toState).toBe(app.state);
    }
  });

  it("has a scored discovery inbox with keyword breakdowns and a re-rank", async () => {
    const inbox = await db.select().from(jobs)
      .where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.status, "inbox")));
    expect(inbox.length).toBeGreaterThanOrEqual(25);
    expect(inbox.every((j) => j.keywordScore !== null)).toBe(true);
    expect(inbox.every((j) => j.keywordBreakdown !== null)).toBe(true);
    expect(inbox.filter((j) => j.llmScore !== null).length).toBeGreaterThan(0);
    expect(inbox.filter((j) => j.llmRationale !== null).length).toBeGreaterThan(0);
  });

  it("has an approved cover letter and an approved email body", async () => {
    const appIds = db.select({ id: applications.id }).from(applications)
      .where(eq(applications.workspaceId, workspaceId));
    const docs = await db.select().from(generatedDocuments)
      .where(inArray(generatedDocuments.applicationId, appIds));
    const approved = docs.filter((doc) => doc.approval === "approved");
    expect(approved.map((doc) => doc.kind).sort()).toEqual(["cover_letter", "email_body"]);
    // Provenance chips need source facts, and the demo runs with no API key —
    // so the content is seeded, not generated.
    expect(approved.every((doc) => doc.sourceFactIds.length > 0)).toBe(true);
  });

  it("has two approved reusable answers", async () => {
    const appIds = db.select({ id: applications.id }).from(applications)
      .where(eq(applications.workspaceId, workspaceId));
    const answers = await db.select().from(applicationAnswers)
      .where(inArray(applicationAnswers.applicationId, appIds));
    expect(answers.filter((a) => a.reusable && a.approval === "approved")).toHaveLength(2);
  });

  it("has a Mailpit-backed email connection whose password went through the seal path", async () => {
    const [connection] = await db.select().from(emailConnections)
      .where(eq(emailConnections.workspaceId, workspaceId));
    expect(connection).toBeDefined();
    expect((connection!.smtp as { host: string }).host).toBe(config.sandboxSmtpAllowedHost);
    const [credential] = await db.select().from(credentials)
      .where(eq(credentials.id, connection!.smtpCredentialId));
    expect(credential).toBeDefined();
    // Sealed, not stored: the ciphertext must not contain the plaintext.
    expect(Buffer.from(credential!.ciphertext).toString("utf-8")).not.toContain("demo");
  });

  it("has inbound messages, one of them a pending classification suggestion", async () => {
    const messages = await db.select().from(emailMessages)
      .where(eq(emailMessages.workspaceId, workspaceId));
    expect(messages.filter((m) => m.direction === "inbound").length).toBeGreaterThanOrEqual(2);
    const pending = messages.filter((m) => m.suggestionState === "pending");
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending[0]!.classification).not.toBeNull();
    expect(pending[0]!.suggestedTransition).not.toBeNull();
  });

  it("has a SUBMITTED company_site attempt with a receipt and a screenshot on disk", async () => {
    const appIds = db.select({ id: applications.id }).from(applications)
      .where(eq(applications.workspaceId, workspaceId));
    const attempts = await db.select().from(applicationAttempts)
      .where(inArray(applicationAttempts.applicationId, appIds));
    const site = attempts.find((a) => a.channel === "company_site" && a.status === "SUBMITTED");
    expect(site).toBeDefined();
    const receipt = site!.confirmedReceipt as { confirmationId: string; screenshotPath: string };
    expect(receipt.confirmationId).toBeTruthy();
    expect(existsSync(receipt.screenshotPath)).toBe(true);
    expect(site!.pendingReceipt).not.toBeNull();
  });
});
