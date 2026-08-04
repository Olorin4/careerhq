import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { loadConfig, type AppConfig } from "@careerhq/config";
import {
  DEMO_MAILBOX_PASSWORD, DEMO_WORKSPACE_NAME, applicationAnswers, applicationAttempts,
  applicationEvents, applications, candidateFacts, createApplication, createDb, createFact,
  credentials, cvVariants, emailConnections, emailMessages, formSnapshots, generateMasterKeyB64,
  generatedDocuments, jobs, workspaces, type Db,
} from "@careerhq/db";
import { runDemoResetOnce } from "./demo-reset.js";

// Every test here runs at least one full reset — a whole workspace deleted and
// rebuilt through the real repo calls — which takes 0.4–1.0 s on its own and
// serialises behind any other reset on the same database via the seed's
// advisory lock. Vitest's 5 s default sat close enough to that to time out
// under load, and a timed-out test does not stop its seed: the abandoned
// promise kept writing while the next test's reset deleted underneath it,
// which is how a timeout turned into `SHORTLISTED refused: application not
// found` several tests later. Generous on purpose — this budget exists to make
// the failure mode impossible, not to police the runtime.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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
    // Sealed, not stored: the ciphertext must not contain the plaintext. The
    // assertion names the actual password — an earlier version looked for
    // "demo", which does not appear in "mailpit-has-no-auth" whether it is
    // sealed or written out verbatim.
    expect(DEMO_MAILBOX_PASSWORD).toBeTruthy();
    expect(Buffer.from(credential!.ciphertext).toString("utf-8")).not.toContain(DEMO_MAILBOX_PASSWORD);
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

  // The receipt and the application render on the same screen. `completeSubmission`
  // stamps `submitted_at = now()` through the real guard, so a receipt claiming
  // the ATS accepted the application four days earlier contradicted the row
  // right beside it.
  it("dates the auto-apply receipt consistently with the application it belongs to", async () => {
    const appIds = db.select({ id: applications.id }).from(applications)
      .where(eq(applications.workspaceId, workspaceId));
    const attempts = await db.select().from(applicationAttempts)
      .where(inArray(applicationAttempts.applicationId, appIds));
    const site = attempts.find((a) => a.channel === "company_site" && a.status === "SUBMITTED")!;
    const [app] = await db.select().from(applications).where(eq(applications.id, site.applicationId));

    const accepted = new Date((site.confirmedReceipt as { acceptedAt: string }).acceptedAt).getTime();
    const started = new Date((site.pendingReceipt as { startedAt: string }).startedAt).getTime();
    const submitted = app!.submittedAt!.getTime();

    expect(started).toBeLessThanOrEqual(accepted);
    // The ATS accepted it before the application was marked submitted, and
    // within the same sitting rather than days earlier.
    expect(accepted).toBeLessThanOrEqual(submitted);
    expect(submitted - accepted).toBeLessThan(30 * 60_000);
  });

  // The CV picker distinguishes variants by digest. Two byte-identical files
  // made the "designed vs ATS-safe" choice the demo shows a label with nothing
  // behind it.
  it("seeds two genuinely different CV variants", async () => {
    const variants = await db.select().from(cvVariants).where(eq(cvVariants.workspaceId, workspaceId));
    expect(variants).toHaveLength(2);
    expect(new Set(variants.map((v) => v.sha256)).size).toBe(2);
    expect(new Set(variants.map((v) => v.filePath)).size).toBe(2);
    for (const variant of variants) expect(existsSync(variant.filePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The two places the demo's central claims live: grounded provenance, and the
// LLM's rationale for a ranking. Both were silently wrong — sources chosen by
// array position, rationales attached by ranking position — and both render on
// the screens the walkthrough films.
// ---------------------------------------------------------------------------

d("the seeded content says true things about itself", () => {
  let workspaceId: string;

  beforeAll(async () => {
    if (!url) return;
    ({ workspaceId } = await runDemoResetOnce(db, config));
  });

  /**
   * A fact, and the phrasing that counts as an artifact restating it. An
   * artifact whose text matches the pattern MUST cite the fact: the fact bank's
   * whole claim is that a generated sentence can be traced to the thing it came
   * from, and a provenance chip naming the wrong fact refutes that claim on
   * camera.
   */
  const EVIDENCE: ReadonlyArray<readonly [claimFragment: string, restates: RegExp]> = [
    ["6 years as a backend engineer at Northwind Robotics", /Northwind Robotics|six years of backend engineering/i],
    ["2 years as engineering lead at Vertex Logistics", /Vertex Logistics/i],
    ["Migrated a monolith to event-driven services", /strangler-fig|monolith|nine months migrating/i],
    ["TypeScript and Node.js, production, six years", /TypeScript/i],
    ["PostgreSQL: schema design", /PostgreSQL/i],
    ["Prefers remote-first teams in European time zones", /remote-first in a European time zone/i],
    ["Available four weeks after signing", /four weeks after signing/i],
    ["EU work authorization: citizen", /EU citizenship|no sponsorship/i],
  ];

  it("cites, on every document and answer, the facts its own text restates", async () => {
    const facts = await db.select().from(candidateFacts)
      .where(eq(candidateFacts.workspaceId, workspaceId));
    const idOf = (fragment: string): string => {
      const matches = facts.filter((f) => f.claim.includes(fragment));
      expect(matches, `expected exactly one seeded fact matching "${fragment}"`).toHaveLength(1);
      return matches[0]!.id;
    };
    const byId = new Map(facts.map((f) => [f.id, f]));

    const appIds = db.select({ id: applications.id }).from(applications)
      .where(eq(applications.workspaceId, workspaceId));
    const docs = await db.select().from(generatedDocuments)
      .where(inArray(generatedDocuments.applicationId, appIds));
    const answers = await db.select().from(applicationAnswers)
      .where(inArray(applicationAnswers.applicationId, appIds));

    const artifacts = [
      ...docs.map((doc) => ({ label: `document ${doc.kind}`, text: doc.contentMd, sources: doc.sourceFactIds })),
      ...answers.map((a) => ({ label: `answer "${a.questionRaw}"`, text: a.answer, sources: a.sourceFactIds })),
    ];
    expect(artifacts.length).toBeGreaterThanOrEqual(6);

    for (const artifact of artifacts) {
      expect(artifact.sources.length, `${artifact.label} is ungrounded`).toBeGreaterThan(0);

      for (const [fragment, restates] of EVIDENCE) {
        if (!restates.test(artifact.text)) continue;
        expect(artifact.sources, `${artifact.label} restates "${fragment}" without citing it`)
          .toContain(idOf(fragment));
      }

      // The failure the review actually caught: `factIds.slice(0, 4)` is
      // name / name / email / phone, so a cover letter about a nine-month
      // migration rendered chips reading "Preferred name: Alex".
      for (const id of artifact.sources) {
        const fact = byId.get(id);
        expect(fact, `${artifact.label} cites a fact outside its workspace`).toBeDefined();
        expect(
          ["identity", "contact"],
          `${artifact.label} cites the ${fact!.category} fact "${fact!.claim}", which its prose does not use`,
        ).not.toContain(fact!.category);
      }
    }
  });

  // Same family: the auto-apply form plan's evidence panel renders these ids,
  // and a field annotated "answered from an approved fact" with no source says
  // the opposite of what it means to.
  it("names the fact behind every fact-sourced field in the auto-apply form plan", async () => {
    const factIds = new Set((await db.select({ id: candidateFacts.id }).from(candidateFacts)
      .where(eq(candidateFacts.workspaceId, workspaceId))).map((f) => f.id));
    const [authorization] = await db.select().from(candidateFacts)
      .where(and(eq(candidateFacts.workspaceId, workspaceId), eq(candidateFacts.category, "authorization")));

    const appIds = db.select({ id: applications.id }).from(applications)
      .where(eq(applications.workspaceId, workspaceId));
    const attemptIds = db.select({ id: applicationAttempts.id }).from(applicationAttempts)
      .where(inArray(applicationAttempts.applicationId, appIds));
    const [snapshot] = await db.select().from(formSnapshots)
      .where(inArray(formSnapshots.attemptId, attemptIds));
    expect(snapshot).toBeDefined();

    const planned = snapshot!.plannedAnswers as Array<{ fieldId: string; source: string; sourceFactIds: string[] }>;
    const grounded = planned.filter((a) => a.source === "fact" || a.source === "saved_answer");
    expect(grounded.length).toBeGreaterThanOrEqual(5);
    for (const answer of grounded) {
      expect(answer.sourceFactIds, `planned answer ${answer.fieldId} has no source fact`).not.toHaveLength(0);
      for (const id of answer.sourceFactIds) {
        expect(factIds, `planned answer ${answer.fieldId} cites an unknown fact`).toContain(id);
      }
    }
    // The sensitive one, by name: "sensitive: answered from an approved fact".
    const visa = planned.find((a) => a.fieldId === "f-auth")!;
    expect(visa.sourceFactIds).toEqual([authorization!.id]);
  });

  /**
   * Each checkable assertion a seeded rationale or red flag makes, and what has
   * to be true of the listing it is attached to.
   *
   * `RERANK_NOTES` used to be authored index-aligned with the job seeds but
   * consumed index-aligned with the keyword ranking, so nine of ten landed on
   * the wrong listing: Kingsley Logistics' €90k–€110k Platform Engineer carried
   * "salary band is above the target", and Cobalt Freight's SENIOR Platform
   * Engineer carried "the seniority reads a step below".
   */
  const SENIOR_TITLE = /senior|staff|principal|lead|founding/i;
  /** Lowest figure in a band like "€90k–€110k" or "CHF 120k–140k", in thousands. */
  const salaryFloor = (raw: string | null): number => Number(/(\d+)k/i.exec(raw ?? "")?.[1] ?? NaN);

  const RERANK_CLAIMS: ReadonlyArray<{
    phrase: string;
    holds: (job: { title: string; salaryRaw: string | null; location: string | null; descriptionMd: string | null }) => boolean;
  }> = [
    // The target base is €110k (a seeded `compensation` fact).
    { phrase: "salary band is above the target", holds: (j) => salaryFloor(j.salaryRaw) > 110 },
    { phrase: "compensation is partly equity", holds: (j) => /equity/i.test(j.salaryRaw ?? "") },
    { phrase: "the seniority reads a step below", holds: (j) => !SENIOR_TITLE.test(j.title) },
    { phrase: "level may be junior to the target", holds: (j) => !SENIOR_TITLE.test(j.title) },
    { phrase: "Staff scope", holds: (j) => /staff/i.test(j.title) },
    { phrase: "Founding-engineer scope", holds: (j) => /founding/i.test(j.title) },
    { phrase: "full-stack match", holds: (j) => /full-stack/i.test(j.title) },
    { phrase: "Ledger correctness", holds: (j) => /ledger/i.test(`${j.title} ${j.descriptionMd ?? ""}`) },
    { phrase: "async-writing culture", holds: (j) => /async writing/i.test(j.descriptionMd ?? "") },
    { phrase: "Remote-global", holds: (j) => /global/i.test(j.location ?? "") },
    { phrase: "dispatch experience", holds: (j) => /dispatch/i.test(j.descriptionMd ?? "") },
    { phrase: "Kubernetes platform work", holds: (j) => /kubernetes/i.test(j.descriptionMd ?? "") },
    { phrase: "Developer-tools focus", holds: (j) => /developer tools/i.test(j.descriptionMd ?? "") },
    { phrase: "Terraform/Kubernetes platform", holds: (j) => /terraform/i.test(j.descriptionMd ?? "") },
  ];

  it("attaches every re-rank rationale to the listing it was written about", async () => {
    const ranked = (await db.select().from(jobs).where(eq(jobs.workspaceId, workspaceId)))
      .filter((job) => job.llmRationale !== null);
    expect(ranked).toHaveLength(10);

    // The batch is a fixed, named set — not "whatever the keyword ranking put
    // in the top ten", which is the ordering the notes were mis-keyed to.
    expect(ranked.map((j) => j.externalId).sort()).toEqual([
      "demo-001", "demo-002", "demo-003", "demo-004", "demo-005",
      "demo-006", "demo-007", "demo-008", "demo-009", "demo-010",
    ]);

    let checked = 0;
    for (const job of ranked) {
      const said = `${job.llmRationale} ${(job.llmRedFlags as string[] | null)?.join(" ") ?? ""}`;
      for (const claim of RERANK_CLAIMS) {
        if (!said.includes(claim.phrase)) continue;
        checked += 1;
        expect(
          claim.holds(job),
          `${job.externalId} "${job.title}" (${job.salaryRaw}) is told "${claim.phrase}", which its own listing contradicts`,
        ).toBe(true);
      }
    }
    // Guards the guard: a typo'd phrase would silently check nothing.
    expect(checked).toBeGreaterThanOrEqual(RERANK_CLAIMS.length);
  });
});
