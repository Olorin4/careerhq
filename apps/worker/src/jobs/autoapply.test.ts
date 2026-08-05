import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@careerhq/config";
import type { CanonicalForm, PlannedAnswer } from "@careerhq/contracts";
import type { RawFormPage } from "@careerhq/autoapply";
import { DEMO_MAX_EVIDENCE_STORE_FILES, ORPHAN_GRACE_MS } from "@careerhq/core/storage";
import {
  createApplication, createCvVariant, createDb, createSiteAttempt, getAttempt,
  getLatestSnapshot, saveFormSnapshot, workspaces, type Db,
} from "@careerhq/db";
import type { BrowserSession } from "../autoapply/driver.js";
import { runCaptureJob, runSubmitJob } from "./autoapply.js";

const { openSessionMock, capturePageMock, fillAndSubmitMock, sessionCloseMock } = vi.hoisted(() => ({
  openSessionMock: vi.fn(),
  capturePageMock: vi.fn(),
  fillAndSubmitMock: vi.fn(),
  sessionCloseMock: vi.fn(),
}));

vi.mock("../autoapply/driver.js", () => ({
  openSession: openSessionMock,
  capturePage: capturePageMock,
  fillAndSubmit: fillAndSubmitMock,
}));

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

let db: Db;
let workspaceId: string;
let fileStorageDir: string;

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    databaseUrl: url ?? "",
    submissionsLiveEmail: false,
    submissionsLiveCompanySite: false,
    sandboxForceSafe: false,
    demoMode: false,
    demoRateLimitPerMin: 30,
    sandboxSmtpAllowedHost: "mailpit",
    sandboxSiteAllowedHost: "demo-ats",
    followUpDays: 7,
    fileStorageDir,
    openrouterApiKey: null,
    aiFastModels: ["test/fast-model"],
    aiWritingModels: ["test/writing-model"],
    aiReplayDir: "/tmp/careerhq-worker-test/replay",
    ingestCron: "0 */6 * * *",
    emailSyncCron: "*/15 * * * *",
    demoResetCron: "0 */6 * * *",
    aiMode: "live",
    masterKey: null,
    autoapplyBrowserTimeoutMs: 1_000,
    autoapplyMaxConcurrentBrowsers: 1,
    demoAtsUrl: "http://demo-ats:3001",
    ...overrides,
  };
}

function rawPage(overrides: Partial<RawFormPage> = {}): RawFormPage {
  return {
    url: "https://acme.example/jobs/1/apply",
    title: "Apply — Acme",
    bodyText: "Apply for this role",
    rootMarkers: ["id=application_form"],
    fields: [{
      selector: "#first_name", tag: "input", type: "text", name: "first_name", id: "first_name",
      labelText: "First name", nearbyText: "", placeholder: "", required: true, maxLength: null,
      accept: null, options: [], step: 0,
    }],
    buttons: [{ selector: "#btn_submit", id: "btn_submit", text: "Submit" }],
    totalSteps: 1,
    ...overrides,
  };
}

function canonicalForm(overrides: Partial<CanonicalForm> = {}): CanonicalForm {
  return {
    atsType: "greenhouse",
    parserVersion: "generic-v1",
    url: "https://acme.example/jobs/1/apply",
    requisitionKey: "acme.example/jobs/1",
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

async function siteAttempt(companyName: string): Promise<{ applicationId: string; attemptId: string }> {
  const app = await createApplication(db, { workspaceId, companyName, jobTitle: "Engineer" });
  const attempt = await createSiteAttempt(db, { applicationId: app.id, url: "https://acme.example/jobs/1/apply" });
  return { applicationId: app.id, attemptId: attempt.id };
}

/**
 * The predicate the job hands the driver must be the real capture policy, not
 * a placeholder — these jobs had NO host gate at all before the P6 fix-wave
 * review (A2), and the driver now depends on this predicate to judge every
 * redirect hop. Asserting only that a function was passed would pass for
 * `() => true`, which is the exact regression worth catching.
 */
function expectPolicyPredicate(deps: { isNavigationAllowed: (url: string) => boolean }): void {
  expect(deps.isNavigationAllowed("https://acme.example/jobs/1/apply")).toBe(true);
  expect(deps.isNavigationAllowed("http://169.254.169.254/latest/meta-data/")).toBe(false);
  expect(deps.isNavigationAllowed("http://127.0.0.1:9100/secret")).toBe(false);
  expect(deps.isNavigationAllowed("file:///etc/passwd")).toBe(false);
}

const fakeSession: BrowserSession = {
  newPage: () => {
    throw new Error("newPage should be unused — capturePage/fillAndSubmit are mocked directly");
  },
  close: sessionCloseMock,
};

beforeAll(async () => {
  if (!url) return;
  db = createDb(url);
  fileStorageDir = mkdtempSync(path.join(tmpdir(), "careerhq-autoapply-jobs-"));
  const [ws] = await db.insert(workspaces).values({ name: `t-autoapply-jobs-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;
});

afterAll(async () => {
  if (!url) return;
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.$client.end();
});

beforeEach(() => {
  vi.clearAllMocks();
  openSessionMock.mockResolvedValue(fakeSession);
});

d("runCaptureJob", () => {
  it("stores the captured RawFormPage on the attempt's latest snapshot recoveryState, and always closes the session", async () => {
    const { applicationId, attemptId } = await siteAttempt("Capture Co");
    await saveFormSnapshot(db, { attemptId, form: canonicalForm(), answers: plannedAnswers() });
    const page = rawPage();
    capturePageMock.mockResolvedValueOnce(page);

    await runCaptureJob(db, config(), {
      workspaceId, applicationId, attemptId, url: "https://acme.example/jobs/1/apply",
    });

    expect(capturePageMock).toHaveBeenCalledWith(fakeSession, "https://acme.example/jobs/1/apply", {
      timeoutMs: 1_000,
      isNavigationAllowed: expect.any(Function) as unknown as (url: string) => boolean,
    });
    expect(sessionCloseMock).toHaveBeenCalledTimes(1);
    expectPolicyPredicate(capturePageMock.mock.calls[0]?.[2] as { isNavigationAllowed: (u: string) => boolean });

    const latest = await getLatestSnapshot(db, attemptId);
    expect(latest?.recoveryState).toEqual({ kind: "raw_page", page });

    // The gate owns transitions — capture never advances the attempt's own status.
    const attempt = await getAttempt(db, attemptId);
    expect(attempt?.status).toBe("DRAFT");
  });

  it("a driver throw leaves the snapshot untouched and records nothing partial, but still closes the session", async () => {
    const { applicationId, attemptId } = await siteAttempt("Capture Boom Co");
    await saveFormSnapshot(db, { attemptId, form: canonicalForm(), answers: plannedAnswers() });
    capturePageMock.mockRejectedValueOnce(new Error("navigation boom"));

    await expect(runCaptureJob(db, config(), {
      workspaceId, applicationId, attemptId, url: "https://acme.example/jobs/1/apply",
    })).rejects.toThrow("navigation boom");

    expect(sessionCloseMock).toHaveBeenCalledTimes(1);
    const latest = await getLatestSnapshot(db, attemptId);
    expect(latest?.recoveryState).toBeNull();
    const attempt = await getAttempt(db, attemptId);
    expect(attempt?.status).toBe("DRAFT");
  });

  /**
   * The gap the fix-wave review called structural (A2): this job had no host
   * gate whatsoever — `data.url` went straight to `capturePage`, with only the
   * driver's protocol floor between a queue payload and
   * `http://169.254.169.254/`. It was unreachable only because main.ts does not
   * register the consumer, so registering it would have shipped the hole.
   */
  it("refuses an internal target before a browser is ever started", async () => {
    const { applicationId, attemptId } = await siteAttempt("Internal Target Co");
    await saveFormSnapshot(db, { attemptId, form: canonicalForm(), answers: plannedAnswers() });

    await expect(runCaptureJob(db, config(), {
      workspaceId, applicationId, attemptId, url: "http://169.254.169.254/latest/meta-data/",
    })).rejects.toThrow(/internal network/);

    expect(openSessionMock).not.toHaveBeenCalled();
    expect(capturePageMock).not.toHaveBeenCalled();
    expect((await getLatestSnapshot(db, attemptId))?.recoveryState).toBeNull();
  });

  it("refuses before opening a session when the attempt has no snapshot yet", async () => {
    const { applicationId, attemptId } = await siteAttempt("No Snapshot Co");

    await expect(runCaptureJob(db, config(), {
      workspaceId, applicationId, attemptId, url: "https://acme.example/jobs/1/apply",
    })).rejects.toThrow(/no form snapshot/);

    expect(openSessionMock).not.toHaveBeenCalled();
    expect(capturePageMock).not.toHaveBeenCalled();
  });

  it("refuses before opening a session when the attempt does not belong to the given workspace", async () => {
    const { applicationId, attemptId } = await siteAttempt("Cross WS Co");
    await saveFormSnapshot(db, { attemptId, form: canonicalForm(), answers: plannedAnswers() });

    await expect(runCaptureJob(db, config(), {
      workspaceId: "00000000-0000-0000-0000-000000000000", applicationId, attemptId,
      url: "https://acme.example/jobs/1/apply",
    })).rejects.toThrow();

    expect(openSessionMock).not.toHaveBeenCalled();
  });
});

d("runSubmitJob", () => {
  it("fills and submits from the stored snapshot, writes the screenshot under fileStorageDir/autoapply, and records the result on recoveryState", async () => {
    const { attemptId } = await siteAttempt("Submit Co");
    const variant = await createCvVariant(db, {
      workspaceId, label: "ATS CV", format: "ats", filePath: "/var/files/cv/alex.pdf", sha256: "a".repeat(64),
    });
    const form = canonicalForm({
      fields: [
        { id: "field-1", kind: "text", label: "First name", helpText: "", required: true, options: [], step: 0, canonicalField: "first_name", mappingConfidence: 0.9, sensitive: false },
        { id: "field-cv", kind: "file", label: "Resume", helpText: "", required: true, options: [], step: 0, canonicalField: "resume_file", mappingConfidence: 0.9, sensitive: false },
      ],
    });
    const answers: PlannedAnswer[] = [
      ...plannedAnswers(),
      { fieldId: "field-cv", value: variant.id, source: "document", sourceFactIds: [], confidence: 1, needsUser: false, differsFromApproved: false, note: "" },
    ];
    await saveFormSnapshot(db, { attemptId, form, answers });

    fillAndSubmitMock.mockResolvedValueOnce({
      confirmationId: "NR-abc123",
      finalUrl: "https://acme.example/apply/1/done",
      screenshotPng: Buffer.from("fake-png-bytes"),
      pageText: "Thanks for applying!",
    });

    await runSubmitJob(db, config(), { workspaceId, attemptId });

    expect(fillAndSubmitMock).toHaveBeenCalledWith(fakeSession, {
      url: form.url,
      form,
      answers,
      files: { "field-cv": "/var/files/cv/alex.pdf" },
      deps: {
        timeoutMs: 1_000,
        isNavigationAllowed: expect.any(Function) as unknown as (url: string) => boolean,
      },
    });
    expect(sessionCloseMock).toHaveBeenCalledTimes(1);
    expectPolicyPredicate(
      (fillAndSubmitMock.mock.calls[0]?.[1] as { deps: { isNavigationAllowed: (u: string) => boolean } }).deps,
    );

    const screenshotPath = path.join(fileStorageDir, "autoapply", `${attemptId}.png`);
    expect(readFileSync(screenshotPath).toString()).toBe("fake-png-bytes");

    const latest = await getLatestSnapshot(db, attemptId);
    expect(latest?.recoveryState).toEqual({
      kind: "submit_result",
      confirmationId: "NR-abc123",
      finalUrl: "https://acme.example/apply/1/done",
      screenshotPath,
      pageText: "Thanks for applying!",
    });

    const attempt = await getAttempt(db, attemptId);
    expect(attempt?.status).toBe("DRAFT");
  });

  it("a driver throw writes no screenshot and leaves recoveryState untouched, but still closes the session", async () => {
    const { attemptId } = await siteAttempt("Submit Boom Co");
    await saveFormSnapshot(db, { attemptId, form: canonicalForm(), answers: plannedAnswers() });
    fillAndSubmitMock.mockRejectedValueOnce(new Error("submit boom"));

    await expect(runSubmitJob(db, config(), { workspaceId, attemptId })).rejects.toThrow("submit boom");

    expect(sessionCloseMock).toHaveBeenCalledTimes(1);
    const screenshotPath = path.join(fileStorageDir, "autoapply", `${attemptId}.png`);
    expect(() => readFileSync(screenshotPath)).toThrow();

    const latest = await getLatestSnapshot(db, attemptId);
    expect(latest?.recoveryState).toBeNull();
    const attempt = await getAttempt(db, attemptId);
    expect(attempt?.status).toBe("DRAFT");
  });

  it("refuses before opening a session when a file field's document id does not resolve to a CV variant", async () => {
    const { attemptId } = await siteAttempt("Missing CV Co");
    const form = canonicalForm({
      fields: [{ id: "field-cv", kind: "file", label: "Resume", helpText: "", required: true, options: [], step: 0, canonicalField: "resume_file", mappingConfidence: 0.9, sensitive: false }],
    });
    const answers: PlannedAnswer[] = [{
      fieldId: "field-cv", value: "00000000-0000-0000-0000-000000000000", source: "document",
      sourceFactIds: [], confidence: 1, needsUser: false, differsFromApproved: false, note: "",
    }];
    await saveFormSnapshot(db, { attemptId, form, answers });

    await expect(runSubmitJob(db, config(), { workspaceId, attemptId })).rejects.toThrow(/no longer exists/);
    expect(openSessionMock).not.toHaveBeenCalled();
  });

  it("refuses before opening a session when the attempt has no snapshot yet", async () => {
    const app = await createApplication(db, { workspaceId, companyName: "No Snapshot Submit Co", jobTitle: "Engineer" });
    const attempt = await createSiteAttempt(db, { applicationId: app.id, url: "https://acme.example/jobs/1/apply" });

    await expect(runSubmitJob(db, config(), { workspaceId, attemptId: attempt.id })).rejects.toThrow(/no form snapshot/);
    expect(openSessionMock).not.toHaveBeenCalled();
  });

  it("refuses before opening a session when the attempt does not belong to the given workspace", async () => {
    const { attemptId } = await siteAttempt("Cross WS Submit Co");
    await saveFormSnapshot(db, { attemptId, form: canonicalForm(), answers: plannedAnswers() });

    await expect(runSubmitJob(db, config(), {
      workspaceId: "00000000-0000-0000-0000-000000000000", attemptId,
    })).rejects.toThrow();
    expect(openSessionMock).not.toHaveBeenCalled();
  });
  /**
   * The demo's evidence-screenshot ceiling, from the worker's side. This job
   * and apps/web's interactive path write into the SAME store (this
   * directory plus `site-screenshots/`), so the guard has to be the same one,
   * checked in the same place: before a browser opens, where a refusal costs
   * nothing.
   */
  describe("the demo's evidence-screenshot store", () => {
    /** A `FILE_STORAGE_DIR` of its own, so the store is exactly what the test put there. */
    function demoStore(): string {
      return mkdtempSync(path.join(tmpdir(), "careerhq-worker-shots-"));
    }

    function fillStore(dir: string, sub: string, count: number, ageMs: number): void {
      const dirPath = path.join(dir, sub);
      mkdirSync(dirPath, { recursive: true });
      const stamp = (Date.now() - ageMs) / 1000;
      for (let i = 0; i < count; i += 1) {
        const filePath = path.join(dirPath, `shot-${i}.png`);
        writeFileSync(filePath, "png");
        utimesSync(filePath, stamp, stamp);
      }
    }

    it("refuses before opening a session when the store is full, writing nothing and claiming no evidence", async () => {
      const dir = demoStore();
      const { attemptId } = await siteAttempt("Full Store Co");
      await saveFormSnapshot(db, { attemptId, form: canonicalForm(), answers: plannedAnswers() });
      // Inside the grace window: every one of these could be an in-flight
      // write, so none is reclaimable and the ceiling is what must answer.
      fillStore(dir, "site-screenshots", DEMO_MAX_EVIDENCE_STORE_FILES, 0);

      await expect(runSubmitJob(db, config({ demoMode: true, fileStorageDir: dir }), { workspaceId, attemptId }))
        .rejects.toThrow(/storage is full/);

      // The whole point of refusing here rather than at the write: no browser
      // was started, so no click happened, and the snapshot carries no
      // recovery state claiming a screenshot that does not exist.
      expect(openSessionMock).not.toHaveBeenCalled();
      expect(fillAndSubmitMock).not.toHaveBeenCalled();
      expect((await getLatestSnapshot(db, attemptId))?.recoveryState).toBeNull();
      expect(() => readFileSync(path.join(dir, "autoapply", `${attemptId}.png`))).toThrow();
      // It did not delete live-looking files to make room, either.
      expect(readdirSync(path.join(dir, "site-screenshots"))).toHaveLength(DEMO_MAX_EVIDENCE_STORE_FILES);
    });

    it("reclaims the orphans a reset left across BOTH directories and then submits", async () => {
      const dir = demoStore();
      const { attemptId } = await siteAttempt("Reclaimed Store Co");
      await saveFormSnapshot(db, { attemptId, form: canonicalForm(), answers: plannedAnswers() });
      // What the six-hourly reset leaves: the PNGs of every past submission,
      // web's and the worker's alike, with every row that pointed at them gone.
      fillStore(dir, "site-screenshots", DEMO_MAX_EVIDENCE_STORE_FILES, ORPHAN_GRACE_MS + 60_000);
      fillStore(dir, "autoapply", 20, ORPHAN_GRACE_MS + 60_000);

      fillAndSubmitMock.mockResolvedValueOnce({
        confirmationId: "NR-reclaimed",
        finalUrl: "https://acme.example/apply/1/done",
        screenshotPng: Buffer.from("fake-png-bytes"),
        pageText: "Thanks for applying!",
      });

      await runSubmitJob(db, config({ demoMode: true, fileStorageDir: dir }), { workspaceId, attemptId });

      expect(readdirSync(path.join(dir, "site-screenshots"))).toEqual([]);
      // Only this job's own screenshot is left in its directory.
      expect(readdirSync(path.join(dir, "autoapply"))).toEqual([`${attemptId}.png`]);
      const latest = await getLatestSnapshot(db, attemptId);
      expect(latest?.recoveryState).toMatchObject({
        kind: "submit_result", screenshotPath: path.join(dir, "autoapply", `${attemptId}.png`),
      });
    });

    it("never reclaims a screenshot a form snapshot's recovery state still points at", async () => {
      const dir = demoStore();
      const { attemptId: keptAttemptId } = await siteAttempt("Kept Worker Evidence Co");
      await saveFormSnapshot(db, { attemptId: keptAttemptId, form: canonicalForm(), answers: plannedAnswers() });
      fillAndSubmitMock.mockResolvedValueOnce({
        confirmationId: "NR-kept",
        finalUrl: "https://acme.example/apply/1/done",
        screenshotPng: Buffer.from("fake-png-bytes"),
        pageText: "Thanks for applying!",
      });
      await runSubmitJob(db, config({ demoMode: true, fileStorageDir: dir }), { workspaceId, attemptId: keptAttemptId });

      // Age its evidence well past the grace window and add a true orphan
      // beside it, then run a second job's collector over the same store.
      const kept = path.join(dir, "autoapply", `${keptAttemptId}.png`);
      const stamp = (Date.now() - (ORPHAN_GRACE_MS + 60_000)) / 1000;
      utimesSync(kept, stamp, stamp);
      const orphan = path.join(dir, "autoapply", "orphan.png");
      writeFileSync(orphan, "png");
      utimesSync(orphan, stamp, stamp);

      const { attemptId } = await siteAttempt("Second Worker Job Co");
      await saveFormSnapshot(db, { attemptId, form: canonicalForm(), answers: plannedAnswers() });
      fillAndSubmitMock.mockResolvedValueOnce({
        confirmationId: "NR-second",
        finalUrl: "https://acme.example/apply/1/done",
        screenshotPng: Buffer.from("fake-png-bytes"),
        pageText: "Thanks for applying!",
      });
      await runSubmitJob(db, config({ demoMode: true, fileStorageDir: dir }), { workspaceId, attemptId });

      expect(readdirSync(path.join(dir, "autoapply")).sort())
        .toEqual([`${attemptId}.png`, `${keptAttemptId}.png`].sort());
    });

    it("neither refuses nor reclaims outside demo mode — a self-hoster's evidence is a record, not garbage", async () => {
      const dir = demoStore();
      const { attemptId } = await siteAttempt("Self Hosted Worker Co");
      await saveFormSnapshot(db, { attemptId, form: canonicalForm(), answers: plannedAnswers() });
      fillStore(dir, "site-screenshots", DEMO_MAX_EVIDENCE_STORE_FILES + 5, ORPHAN_GRACE_MS + 60_000);

      fillAndSubmitMock.mockResolvedValueOnce({
        confirmationId: "NR-selfhosted",
        finalUrl: "https://acme.example/apply/1/done",
        screenshotPng: Buffer.from("fake-png-bytes"),
        pageText: "Thanks for applying!",
      });

      await runSubmitJob(db, config({ fileStorageDir: dir }), { workspaceId, attemptId });

      expect(readdirSync(path.join(dir, "site-screenshots")))
        .toHaveLength(DEMO_MAX_EVIDENCE_STORE_FILES + 5);
    });
  });
});
