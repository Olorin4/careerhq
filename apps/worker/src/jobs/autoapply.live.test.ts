/**
 * `runSubmitJob` against a real browser, a real database and a real ATS.
 *
 * The unit suite next door (`autoapply.test.ts`) mocks the driver away, so
 * every claim it makes about "no second submission" is a claim about a mock
 * call count — which is exactly what a fix that broke the world while
 * satisfying its own bookkeeping would still satisfy. The one question this
 * job's retry safety is really about is whether a SECOND APPLICATION REACHES
 * THE ATS, and only demo-ats can answer that. So this file drives the whole
 * thing end to end and asserts against `demo-ats`'s `/api/submissions`, which
 * is ground truth.
 *
 * Lives in its own file rather than in `autoapply.test.ts` because `vi.mock`
 * is hoisted per file: there is no way to have the real driver and the mocked
 * one in the same suite.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import type { AppConfig } from "@careerhq/config";
import type { PlannedAnswer } from "@careerhq/contracts";
import { parseForm, rawFieldId } from "@careerhq/autoapply";
import {
  createApplication, createCvVariant, createDb, createSiteAttempt, getLatestSnapshot,
  saveFormSnapshot, updateRecoveryState, updateSnapshotAnswers, workspaces, type Db,
} from "@careerhq/db";
import { capturePage, openSession } from "../autoapply/driver.js";
import { runSubmitJob } from "./autoapply.js";

const DEMO_ATS_URL = (process.env["DEMO_ATS_URL"] ?? "http://localhost:3001").replace(/\/+$/, "");
const DEMO_ATS_HOST = new URL(DEMO_ATS_URL).hostname;
const dbUrl = process.env["TEST_DATABASE_URL"];

async function probeDemoAts(): Promise<boolean> {
  try {
    return (await fetch(`${DEMO_ATS_URL}/`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

async function probeBrowser(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ headless: true, timeout: 15_000 });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const demoAtsUp = await probeDemoAts();
const browserAvailable = await probeBrowser();
const live = describe.skipIf(!dbUrl || !demoAtsUp || !browserAvailable);

/**
 * The demo-ats store is process-global and shared with other suites running
 * against the same server, so nothing here may assert on its total size. Every
 * test below invents a job id of its own, which makes its slice of the store
 * exactly the submissions it caused — a scoped delta, not an absolute.
 */
async function submissionsFor(jobId: string): Promise<Array<{ id: string; jobId: string }>> {
  const all = (await (await fetch(`${DEMO_ATS_URL}/api/submissions`)).json()) as Array<{
    id: string; jobId: string;
  }>;
  return all.filter((submission) => submission.jobId === jobId);
}

let db: Db;
let workspaceId: string;
let resumePath: string;

/**
 * A `FILE_STORAGE_DIR` that cannot be created: a path *inside* a regular file,
 * so the job's post-click `mkdir`/`writeFile` fails with a real ENOTDIR. The
 * failure this whole file is about is provoked by the filesystem itself — no
 * `node:fs/promises` mock — so what is under test is the job's behaviour on a
 * genuine evidence-write failure, not on a simulated one.
 */
function unwritableStorageDir(): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "careerhq-live-unwritable-")), "not-a-directory");
  writeFileSync(file, "this is a file, not a directory");
  return path.join(file, "storage");
}

/**
 * A sandbox workspace pointed at demo-ats: the capture policy refuses loopback
 * hosts in every workspace kind EXCEPT the configured sandbox host, which is
 * what makes `localhost:3001` reachable at all.
 */
function config(fileStorageDir: string): AppConfig {
  return {
    databaseUrl: dbUrl ?? "",
    submissionsLiveEmail: false,
    submissionsLiveCompanySite: false,
    sandboxForceSafe: false,
    demoMode: false,
    demoRateLimitPerMin: 30,
    sandboxSmtpAllowedHost: "mailpit",
    sandboxSiteAllowedHost: DEMO_ATS_HOST,
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
    autoapplyBrowserTimeoutMs: 30_000,
    autoapplyMaxConcurrentBrowsers: 1,
    demoAtsUrl: DEMO_ATS_URL,
  };
}

/**
 * Everything `runSubmitJob` reads: an application, a company-site attempt, and
 * a form snapshot holding the form as a REAL capture of the live page parsed
 * it, with an answer for every field the page requires. Built with a browser
 * session that is closed again before the job runs, because the process-wide
 * browser limit is one at a time and the job opens its own.
 */
interface PlannedAttempt {
  attemptId: string;
  snapshotId: string;
  answers: PlannedAnswer[];
  /** The field whose planned answer is a CV-variant id — the pre-click refusal below breaks this one. */
  resumeFieldId: string;
}

async function plannedAttempt(jobId: string): Promise<PlannedAttempt> {
  const url = `${DEMO_ATS_URL}/lever/jobs/${jobId}`;
  const session = await openSession();
  let form;
  let answers: PlannedAnswer[];
  let resumeFieldId: string;
  try {
    const raw = await capturePage(session, url, {
      timeoutMs: 30_000,
      isNavigationAllowed: () => true,
    });
    form = parseForm(raw);

    const idFor = (name: string): string => {
      const field = raw.fields.find((f) => f.name === name);
      if (!field) throw new Error(`no raw field named ${name}`);
      return rawFieldId(field);
    };
    const variant = await createCvVariant(db, {
      workspaceId, label: "ATS CV", format: "ats", filePath: resumePath, sha256: randomUUID().replace(/-/g, "").padEnd(64, "0"),
    });
    resumeFieldId = idFor("resume");
    answers = ([
      [idFor("name"), "Ada Lovelace"],
      [idFor("email"), "ada@example.com"],
      [resumeFieldId, variant.id],
      [idFor("notice_period"), "2_weeks"],
    ] as Array<[string, string]>).map(([fieldId, value]) => ({
      fieldId, value, source: "user" as const, sourceFactIds: [], confidence: 1,
      needsUser: false, differsFromApproved: false, note: "",
    }));
  } finally {
    await session.close();
  }

  const application = await createApplication(db, {
    workspaceId, companyName: "Northwind Robotics", jobTitle: "Autonomy Software Engineer",
  });
  const attempt = await createSiteAttempt(db, { applicationId: application.id, url });
  const snapshot = await saveFormSnapshot(db, { attemptId: attempt.id, form, answers });
  return { attemptId: attempt.id, snapshotId: snapshot.id, answers, resumeFieldId };
}

beforeAll(async () => {
  if (!dbUrl || !demoAtsUp || !browserAvailable) return;
  db = createDb(dbUrl);
  const [ws] = await db.insert(workspaces)
    .values({ name: `t-autoapply-live-${Date.now()}`, kind: "sandbox" }).returning();
  workspaceId = ws!.id;
  resumePath = path.join(mkdtempSync(path.join(tmpdir(), "careerhq-live-cv-")), "resume.pdf");
  writeFileSync(resumePath, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF\n");
});

afterAll(async () => {
  if (!dbUrl || !demoAtsUp || !browserAvailable) return;
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.$client.end();
});

live("runSubmitJob retry safety, against demo-ats", () => {
  /**
   * The hazard the roadmap named, reproduced against the real thing: the click
   * lands, the evidence write fails, and pg-boss runs the job again.
   *
   * Before the fix the write threw, pg-boss retried, and the retry filled and
   * clicked a SECOND time — one user intent, two applications at the employer.
   * The assertion that matters is the last one, and it is not about the job's
   * return value or a mock: it is the count of rows demo-ats actually holds.
   */
  it("a post-click evidence failure does not become a second application on retry", async () => {
    const jobId = `dc-evidence-${randomUUID().slice(0, 8)}`;
    const { attemptId } = await plannedAttempt(jobId);
    const cfg = config(unwritableStorageDir());

    // The job id is unique to this test, so its slice of the shared store
    // starts empty by construction rather than by wiping anything.
    expect(await submissionsFor(jobId)).toEqual([]);

    // Run 1: the click lands, the screenshot cannot be written. It must NOT
    // throw — a throw is what pg-boss retries.
    await runSubmitJob(db, cfg, { workspaceId, attemptId });

    const afterFirst = await submissionsFor(jobId);
    expect(afterFirst).toHaveLength(1);

    // The receipt is honest in both directions: it records the submission that
    // happened, and it does not claim the evidence that did not.
    const recovery = (await getLatestSnapshot(db, attemptId))?.recoveryState as {
      kind: string; confirmationId: string | null; screenshotPath: string | null; evidenceError: string | null;
    };
    expect(recovery.kind).toBe("submit_result");
    expect(recovery.confirmationId).toBe(afterFirst[0]?.id);
    expect(recovery.screenshotPath).toBeNull();
    expect(recovery.evidenceError).toMatch(/screenshot could not be saved/);

    // Run 2 — the retry pg-boss would have made. Ground truth: still one.
    await runSubmitJob(db, cfg, { workspaceId, attemptId });
    await runSubmitJob(db, cfg, { workspaceId, attemptId });

    const afterRetries = await submissionsFor(jobId);
    expect(afterRetries).toHaveLength(1);
    expect(afterRetries[0]?.id).toBe(afterFirst[0]?.id);
  }, 120_000);

  /**
   * The case no post-click write can cover: the process is killed between the
   * pre-click marker and the result, so the row says a click was in progress
   * and nothing says how it went. The retry has to refuse on the marker alone
   * — and refusing means demo-ats never hears from it.
   */
  it("a retry that finds an in-flight marker never reaches the ATS", async () => {
    const jobId = `dc-inflight-${randomUUID().slice(0, 8)}`;
    const { attemptId, snapshotId } = await plannedAttempt(jobId);
    const snapshot = await getLatestSnapshot(db, attemptId);
    expect(snapshot?.id).toBe(snapshotId);
    await updateRecoveryState(db, snapshot!.id, snapshot!.currentStep, {
      kind: "submit_in_flight", startedAt: new Date().toISOString(),
    });

    await runSubmitJob(db, config(unwritableStorageDir()), { workspaceId, attemptId });

    expect(await submissionsFor(jobId)).toEqual([]);
    const recovery = (await getLatestSnapshot(db, attemptId))?.recoveryState as {
      kind: string; reason: string;
    };
    expect(recovery.kind).toBe("submit_unknown");
    expect(recovery.reason).toMatch(/already clicked Submit/);
  }, 120_000);

  /**
   * The other half of the contract, and the reason the fix is not simply "make
   * every failure terminal": a job that failed BEFORE the click has submitted
   * nothing, and pg-boss retrying it is the correct behaviour. Provoked with a
   * planned answer for a CV document that no longer exists — a pre-browser
   * refusal — then repaired, and the retry submits exactly once.
   */
  it("a pre-click failure still throws, still retries, and the retry submits exactly once", async () => {
    const jobId = `dc-preclick-${randomUUID().slice(0, 8)}`;
    const { attemptId, snapshotId, answers, resumeFieldId } = await plannedAttempt(jobId);

    // Point the resume answer at a document id that does not exist: the job
    // refuses in `resolveFilePaths`, before a browser is ever started.
    await updateSnapshotAnswers(db, snapshotId, answers.map((answer) => (
      answer.fieldId === resumeFieldId
        ? { ...answer, value: "00000000-0000-0000-0000-000000000000" }
        : answer
    )));

    await expect(runSubmitJob(db, config(unwritableStorageDir()), { workspaceId, attemptId }))
      .rejects.toThrow(/no longer exists/);
    expect(await submissionsFor(jobId)).toEqual([]);
    // Nothing was clicked, so nothing was marked: the row is as clean as it
    // was, which is what keeps the retry below a real retry.
    expect((await getLatestSnapshot(db, attemptId))?.recoveryState).toBeNull();

    await updateSnapshotAnswers(db, snapshotId, answers);
    await runSubmitJob(db, config(unwritableStorageDir()), { workspaceId, attemptId });

    expect(await submissionsFor(jobId)).toHaveLength(1);
  }, 120_000);
});
