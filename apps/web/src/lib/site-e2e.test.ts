/**
 * The full-stack proof for the company-site channel (spec §11 DoD; the P5
 * counterpart to email-e2e.test.ts's Mailpit suite): a REAL db, a REAL
 * headless Chromium session driving a REAL demo-ats (apps/demo-ats,
 * `localhost:3001` by default) through the exact production seam —
 * `./site-driver.ts`'s `makeSiteCapture`/`makeSiteSubmit`, which reach Task
 * 8's Playwright driver via the `@careerhq/worker/autoapply` package export
 * (see site-driver.ts's own comment, and task-13-report.md, for why a
 * relative cross-app import is a build-time error here — nothing in this
 * file reaches into `apps/worker/src` directly).
 *
 * Two deviations from task-14-brief.md, both directed by the controller
 * after Task 12's review (see the brief's "IMPORTANT deviations" section and
 * progress.md's Task 12 FINDING):
 *
 *   1. The happy-path round trip runs against LEVER's `/lever/jobs/eng-2`,
 *      not greenhouse, for reasons that predate the 2026-08-04 attestation
 *      revision below and still hold independently of it (the greenhouse
 *      fixture's multi-step flow is exercised directly by apps/worker's
 *      driver.test.ts instead).
 *
 *      Revision (2026-08-04): a required attestation CHECKBOX (the
 *      greenhouse fixture's `legal_attestation`) is no longer a permanent
 *      page-level blocker — it is field-level consent the user ticks on the
 *      review screen (spec §10.6, revised). The greenhouse fixture now
 *      reaches "ready" and is this file's proof of that demotion (case 6a
 *      below). What still cannot be rendered honestly, and so still blocks
 *      with kind `legal_attestation`, is a typed-signature/date attestation
 *      (demo-ats's `/signature/jobs/:id` fixture) — that is this file's
 *      `blocked` proof instead (case 6b), alongside a captcha URL (case 6c).
 *   2. The `apps/worker` ⇄ `apps/web` package-export seam (`exports` on
 *      apps/worker/package.json, `apps/worker/src/autoapply/index.ts`,
 *      `@careerhq/worker` as an apps/web dependency) was wired in Task 13,
 *      not here — this file only consumes the already-seamed
 *      `./site-driver.ts`.
 *
 * Skips cleanly (not a failure) when any dependency is missing:
 *   - no `TEST_DATABASE_URL` → no db to run against.
 *   - demo-ats unreachable, probed via `GET /api/submissions` with a short
 *     timeout (the brief's own probe target — it doubles as the assertion
 *     surface below).
 *   - Chromium unavailable, probed with a real `openSession()`/`close()`
 *     round trip through the same `@careerhq/worker/autoapply` export the
 *     real driver uses (not a direct `playwright` import — apps/web has no
 *     reason to depend on that package directly, and this keeps the same
 *     boundary the driver itself is bound by).
 * All three probes happen at module load (top-level `await`), before
 * `describe.skipIf` is evaluated — see email-e2e.test.ts's identical note on
 * why a `beforeAll` cannot retroactively skip the suite itself.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { loadConfig, type AppConfig } from "@careerhq/config";
import type { CanonicalForm, PlannedAnswer } from "@careerhq/contracts";
import { openSession } from "@careerhq/worker/autoapply";
import {
  applications, createApplication, createCvVariant, createDb, createFact, getActiveConfirmation,
  getAttempt, getLatestSnapshot,
  listAttemptsForApplication, transitionApplication, updateSnapshotAnswers, workspaces, type Db,
} from "@careerhq/db";
import {
  confirmAndSubmitSite, prepareSiteApplication, previewSiteSubmission, updatePlannedAnswer, type SiteDeps,
} from "./site-submission.js";
import { makeSiteCapture, makeSiteSubmit } from "./site-driver.js";

const url = process.env.TEST_DATABASE_URL;

/** Same default/override convention as apps/worker's driver.test.ts. */
const DEMO_ATS_URL = (process.env.DEMO_ATS_URL ?? "http://localhost:3001").replace(/\/+$/, "");
/** The hostname the user retypes at confirm time, and what `payload.host` will be. */
const HOST = new URL(DEMO_ATS_URL).hostname;

async function probeDemoAts(): Promise<boolean> {
  try {
    const res = await fetch(`${DEMO_ATS_URL}/api/submissions`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function probeBrowser(): Promise<boolean> {
  try {
    const session = await openSession();
    await session.close();
    return true;
  } catch {
    return false;
  }
}

const demoAtsUp = url ? await probeDemoAts() : false;
const browserAvailable = url && demoAtsUp ? await probeBrowser() : false;
if (url && (!demoAtsUp || !browserAvailable)) {
  console.warn(
    `[site-e2e] skipping — demo-ats up: ${demoAtsUp} (${DEMO_ATS_URL}), chromium available: ${browserAvailable}`,
  );
}
const d = describe.skipIf(!url || !demoAtsUp || !browserAvailable);

/** Real headless Chromium round trips; generous relative to vitest's 5s default. */
const BROWSER_TIMEOUT_MS = 60_000;

const leverUrl = (jobId: string): string => `${DEMO_ATS_URL}/lever/jobs/${jobId}`;
const greenhouseUrl = (jobId: string): string => `${DEMO_ATS_URL}/greenhouse/jobs/${jobId}`;
const captchaUrl = (jobId: string): string => `${DEMO_ATS_URL}/captcha/jobs/${jobId}`;
const signatureUrl = (jobId: string): string => `${DEMO_ATS_URL}/signature/jobs/${jobId}`;

const FACT_EMAIL = "alex.rivera@example.com";

/** A syntactically valid minimal one-page PDF (real xref offsets), same builder as email-e2e.test.ts. */
function buildTinyPdf(): Buffer {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body));
    body += obj;
  }
  const xrefStart = Buffer.byteLength(body);
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${off.toString().padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body + xref + trailer);
}

const CV_BYTES = buildTinyPdf();
const CV_SHA256 = createHash("sha256").update(CV_BYTES).digest("hex");

let db: Db;
let workspaceId: string;
let cvPath: string;

function config(over: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: url ?? "postgres://u:p@localhost:5432/careerhq",
    SUBMISSIONS_LIVE_COMPANY_SITE: "true",
    // The ORIGIN spelling, not the bare host: `SANDBOX_SITE_ALLOWED_HOST` is
    // compared as scheme + host + port, and a sandbox pointed at a bare
    // `localhost` could reach every other port on the box (carried out of P6).
    // This suite runs the spelling README now recommends, so the origin
    // comparison is exercised by the full-stack path and not only by
    // target-policy.test.ts.
    SANDBOX_SITE_ALLOWED_HOST: DEMO_ATS_URL,
    // This suite drives a demo-ats on `localhost`, which is a loopback name,
    // and the capture policy's exemption for the configured sandbox host is
    // scoped to sandbox-EFFECTIVE workspaces (fix-wave review A3 — honouring
    // it for a personal workspace made every local port reachable). So the
    // outside-compose local setup this suite models has to say so: this is the
    // same flag the deployed demo sets, and README's auto-apply env table
    // documents it as the required companion to
    // `SANDBOX_SITE_ALLOWED_HOST=localhost`. Nothing about the flows below
    // changes — the gate matrix's only sandbox-specific rule is
    // `sandboxTargetAllowed`, which HOST satisfies by construction.
    SANDBOX_FORCE_SAFE: "true",
    DEMO_ATS_URL,
    ...over,
  });
}

/** Real `capture`/`submit`, built from the actual config so an overridden config (e.g. the gate-closed test) rebuilds them too. */
function deps(over: Partial<SiteDeps> = {}): SiteDeps {
  const cfg = over.config ?? config();
  return { db, config: cfg, capture: makeSiteCapture(cfg), submit: makeSiteSubmit(cfg), ...over };
}

/** An application walked to READY_FOR_REVIEW through the real guarded transitions. */
async function readyApplication(companyName: string, jobUrl: string): Promise<string> {
  const app = await createApplication(db, {
    workspaceId, companyName, jobTitle: "Autonomy Software Engineer", jobUrl,
  });
  for (const to of ["SHORTLISTED", "PREPARING"] as const) {
    expect((await transitionApplication(db, { applicationId: app.id, to, trigger: "user" })).ok).toBe(true);
  }
  const ready = await transitionApplication(db, {
    applicationId: app.id, to: "READY_FOR_REVIEW", trigger: "user", ctx: { hasMaterials: true },
  });
  expect(ready.ok).toBe(true);
  return app.id;
}

interface ReadyPrepare { snapshotId: string; form: CanonicalForm; blocking: string[] }

/**
 * The fact bank (seeded in `beforeAll`) resolves every profile-mapped field
 * on the Lever fixture deterministically — name, email, phone, LinkedIn,
 * portfolio, resume — leaving exactly two fields for the user: "Notice
 * Period" (`notice_period` is unconditionally sensitive, spec §7.2.5) and
 * "Additional information" (a screening question with no saved answer and no
 * AI pass configured, so it stays unresolved). Any other blocking field means
 * a fact-bank assumption drifted from the real demo-ats markup — fail loudly
 * rather than silently leaving it blank.
 */
const LEVER_SETTLE_VALUES: Record<string, string> = {
  "Notice Period": "2_weeks",
  "Additional information": "Looking forward to contributing to Northwind's autonomy stack.",
};

async function settleLeverBlocking(prepared: ReadyPrepare): Promise<void> {
  for (const fieldId of prepared.blocking) {
    const field = prepared.form.fields.find((f) => f.id === fieldId);
    if (!field) throw new Error(`blocking field ${fieldId} missing from the parsed form`);
    const value = LEVER_SETTLE_VALUES[field.label];
    if (value === undefined) {
      throw new Error(`no settle value configured for blocking field "${field.label}" — update LEVER_SETTLE_VALUES`);
    }
    const result = await updatePlannedAnswer(deps(), {
      workspaceId, snapshotId: prepared.snapshotId, fieldId, value,
    });
    expect(result).toEqual({ ok: true });
  }
}

/**
 * The fact bank resolves the greenhouse fixture's identity/contact/resume
 * fields the same way it resolves Lever's (see `LEVER_SETTLE_VALUES`), and
 * the demographics radios are optional (spec: voluntary self-identification
 * is never required). That leaves three sensitive-but-reusable fields for
 * the user, plus the now-demoted `legal_attestation` checkbox — the
 * "demotes the greenhouse checkbox attestation" case below settles the
 * attestation itself (it is the thing under test) and calls this for the
 * rest via `skip`.
 */
const GREENHOUSE_SETTLE_VALUES: Record<string, string> = {
  "Are you legally authorized to work in the country of this job posting? (Work Authorization)": "yes",
  "Will you now or in the future require visa sponsorship?": "no",
  "Why do you want to work at Northwind Robotics?": "Looking forward to contributing to Northwind's autonomy stack.",
};

async function settleGreenhouseBlocking(prepared: ReadyPrepare, skip: Set<string>): Promise<void> {
  for (const fieldId of prepared.blocking) {
    if (skip.has(fieldId)) continue;
    const field = prepared.form.fields.find((f) => f.id === fieldId);
    if (!field) throw new Error(`blocking field ${fieldId} missing from the parsed form`);
    // The generic parser gives every "Voluntary Self-Identification" radio
    // option (gender, veteran status) its own field id, each individually
    // sensitive (canonicalField "demographics") and therefore `needsUser`
    // regardless of the HTML `required` attribute — none of them carry it,
    // this section is opt-in. The user declines each by leaving it blank,
    // exactly the "deliberately left empty" path `updatePlannedAnswer`'s doc
    // comment describes for an optional field the planner could not settle.
    const value = field.canonicalField === "demographics" ? "" : GREENHOUSE_SETTLE_VALUES[field.label];
    if (value === undefined) {
      throw new Error(
        `no settle value configured for blocking field "${field.label}" — update GREENHOUSE_SETTLE_VALUES`,
      );
    }
    const result = await updatePlannedAnswer(deps(), {
      workspaceId, snapshotId: prepared.snapshotId, fieldId, value,
    });
    expect(result).toEqual({ ok: true });
  }
}

interface DemoSubmission {
  id: string;
  source: "greenhouse" | "lever";
  jobId: string;
  fields: Record<string, string>;
  files: Array<{ filename: string; contentType: string; size: number }>;
  submittedAt: string;
}

async function getSubmissions(): Promise<DemoSubmission[]> {
  const res = await fetch(`${DEMO_ATS_URL}/api/submissions`);
  return (await res.json()) as DemoSubmission[];
}

/**
 * demo-ats's store is process-global and SHARED: apps/worker's driver.test.ts
 * drives the same server from a separate turbo task, in parallel by default.
 * So this suite never wipes the store and never asserts on its total size —
 * both used to race that suite, which is why the documented gate was only
 * reproducible at TURBO_CONCURRENCY=1. Every assertion below is scoped to a job
 * id used by exactly one test in this file (driver.test.ts submits only to
 * greenhouse `eng-1`, which nothing here submits to).
 */
async function submissionsFor(jobId: string): Promise<DemoSubmission[]> {
  return (await getSubmissions()).filter((submission) => submission.jobId === jobId);
}

beforeAll(async () => {
  if (!url || !demoAtsUp || !browserAvailable) return;
  db = createDb(url);

  const dir = mkdtempSync(path.join(tmpdir(), "careerhq-site-e2e-cv-"));
  cvPath = path.join(dir, "alex-cv.pdf");
  writeFileSync(cvPath, CV_BYTES);

  const [ws] = await db.insert(workspaces).values({ name: `t-site-e2e-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;

  await createCvVariant(db, {
    workspaceId, label: "ATS CV", format: "ats", filePath: cvPath, sha256: CV_SHA256,
  });

  const reviewBy = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
  const facts = [
    { category: "identity" as const, claim: "Full legal name: Alex Rivera" },
    { category: "contact" as const, claim: `Email: ${FACT_EMAIL}` },
    { category: "contact" as const, claim: "Phone: +1-555-0142" },
    { category: "contact" as const, claim: "LinkedIn: https://www.linkedin.com/in/alexrivera" },
    { category: "contact" as const, claim: "Portfolio: https://alexrivera.dev" },
  ];
  for (const fact of facts) await createFact(db, { workspaceId, ...fact, reviewBy });
});

afterAll(async () => {
  if (!url || !demoAtsUp || !browserAvailable) return;
  // Deliberately no `DELETE /api/submissions`: see `submissionsFor`. The store
  // is in-memory and dies with the demo-ats process anyway.
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.$client.end();
});

d("company-site end-to-end round trip against demo-ats", () => {
  it(
    "full round trip on lever/eng-2: prepare -> resolve needs-you fields -> preview -> confirm -> submitted",
    async () => {
      const jobUrl = leverUrl("eng-2");
      const applicationId = await readyApplication("Happy Path Robotics Co", jobUrl);
      const before = await submissionsFor("eng-2");

      const outcome = await prepareSiteApplication(deps(), { workspaceId, applicationId, url: jobUrl });
      expect(outcome.status).toBe("ready");
      if (outcome.status !== "ready") throw new Error(`prepare failed: ${JSON.stringify(outcome)}`);

      await settleLeverBlocking(outcome);

      const preview = await previewSiteSubmission(deps(), { workspaceId, attemptId: outcome.attemptId });
      expect(preview.status).toBe("ok");
      if (preview.status !== "ok") throw new Error(`preview failed: ${JSON.stringify(preview)}`);
      expect(preview.payload.host).toBe(HOST);

      const confirm = await confirmAndSubmitSite(deps(), {
        workspaceId, attemptId: outcome.attemptId, presentedToken: preview.token, retypedTarget: HOST,
      });
      expect(confirm.status).toBe("submitted");
      if (confirm.status !== "submitted") throw new Error(`confirm failed: ${JSON.stringify(confirm)}`);
      expect(confirm.confirmationId).toMatch(/^NR-[0-9a-f]{8}$/);
      expect(confirm.screenshotPath).not.toBeNull();
      expect(existsSync(confirm.screenshotPath as string)).toBe(true);

      const [application] = await db.select().from(applications).where(eq(applications.id, applicationId));
      expect(application?.state).toBe("SUBMITTED");

      // Exactly one new submission landed in demo-ats, carrying the fact-bank
      // email and the resume's actual on-disk filename (the driver uploads
      // the file at its real path — `attachmentFilename`'s sanitized label is
      // payload/fingerprint metadata only, never what the browser uploads).
      const after = await submissionsFor("eng-2");
      expect(after.length).toBe(before.length + 1);
      const created = after.find((s) => s.id === confirm.confirmationId);
      expect(created).toBeDefined();
      expect(created?.fields["email"]).toBe(FACT_EMAIL);
      expect(created?.files[0]?.filename).toBe(path.basename(cvPath));
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    "blocks a confirm while the env gate is off -> gate_closed, nothing submitted",
    async () => {
      const jobUrl = leverUrl("e2e-gate-off");
      const applicationId = await readyApplication("Gate Off Robotics Co", jobUrl);
      const outcome = await prepareSiteApplication(deps(), { workspaceId, applicationId, url: jobUrl });
      expect(outcome.status).toBe("ready");
      if (outcome.status !== "ready") throw new Error(`prepare failed: ${JSON.stringify(outcome)}`);
      await settleLeverBlocking(outcome);

      const preview = await previewSiteSubmission(deps(), { workspaceId, attemptId: outcome.attemptId });
      expect(preview.status).toBe("ok");
      if (preview.status !== "ok") throw new Error(`preview failed: ${JSON.stringify(preview)}`);

      const before = await submissionsFor("e2e-gate-off");
      const closedConfig = config({ SUBMISSIONS_LIVE_COMPANY_SITE: "false" });
      const confirm = await confirmAndSubmitSite(deps({ config: closedConfig }), {
        workspaceId, attemptId: outcome.attemptId, presentedToken: preview.token, retypedTarget: HOST,
      });
      expect(confirm).toMatchObject({ status: "blocked", code: "gate_closed" });
      expect(await submissionsFor("e2e-gate-off")).toHaveLength(before.length);
      expect((await getAttempt(db, outcome.attemptId))?.status).toBe("PENDING_CONFIRMATION");
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    "blocks a confirm whose answers changed after the preview -> fingerprint_mismatch",
    async () => {
      const jobUrl = leverUrl("e2e-tamper");
      const applicationId = await readyApplication("Tamper Robotics Co", jobUrl);
      const outcome = await prepareSiteApplication(deps(), { workspaceId, applicationId, url: jobUrl });
      expect(outcome.status).toBe("ready");
      if (outcome.status !== "ready") throw new Error(`prepare failed: ${JSON.stringify(outcome)}`);
      await settleLeverBlocking(outcome);

      const preview = await previewSiteSubmission(deps(), { workspaceId, attemptId: outcome.attemptId });
      expect(preview.status).toBe("ok");
      if (preview.status !== "ok") throw new Error(`preview failed: ${JSON.stringify(preview)}`);

      const emailField = outcome.form.fields.find((f) => f.label === "Email");
      if (!emailField) throw new Error("no Email field on the lever fixture");
      const snapshot = await getLatestSnapshot(db, outcome.attemptId);
      const answers = (snapshot!.plannedAnswers as PlannedAnswer[]).map((a) =>
        (a.fieldId === emailField.id ? { ...a, value: "tampered@example.com" } : a));
      await updateSnapshotAnswers(db, outcome.snapshotId, answers);

      const before = await submissionsFor("e2e-tamper");
      const confirm = await confirmAndSubmitSite(deps(), {
        workspaceId, attemptId: outcome.attemptId, presentedToken: preview.token, retypedTarget: HOST,
      });
      expect(confirm).toMatchObject({ status: "blocked", code: "fingerprint_mismatch" });
      expect(await submissionsFor("e2e-tamper")).toHaveLength(before.length);
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    "blocks a confirm whose retyped host does not match -> target_mismatch",
    async () => {
      const jobUrl = leverUrl("e2e-mismatch");
      const applicationId = await readyApplication("Mistyped Robotics Co", jobUrl);
      const outcome = await prepareSiteApplication(deps(), { workspaceId, applicationId, url: jobUrl });
      expect(outcome.status).toBe("ready");
      if (outcome.status !== "ready") throw new Error(`prepare failed: ${JSON.stringify(outcome)}`);
      await settleLeverBlocking(outcome);

      const preview = await previewSiteSubmission(deps(), { workspaceId, attemptId: outcome.attemptId });
      expect(preview.status).toBe("ok");
      if (preview.status !== "ok") throw new Error(`preview failed: ${JSON.stringify(preview)}`);

      const before = await submissionsFor("e2e-mismatch");
      const confirm = await confirmAndSubmitSite(deps(), {
        workspaceId, attemptId: outcome.attemptId, presentedToken: preview.token,
        retypedTarget: "totally-wrong-host.example",
      });
      expect(confirm).toMatchObject({ status: "blocked", code: "target_mismatch" });
      expect(await submissionsFor("e2e-mismatch")).toHaveLength(before.length);
      expect((await getAttempt(db, outcome.attemptId))?.status).toBe("PENDING_CONFIRMATION");
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    "refuses a second prepare for the same requisition -> duplicate, no attempt created",
    async () => {
      const jobUrl = leverUrl("e2e-duplicate");
      const firstApplicationId = await readyApplication("Duplicate First Robotics Co", jobUrl);
      const first = await prepareSiteApplication(deps(), { workspaceId, applicationId: firstApplicationId, url: jobUrl });
      expect(first.status).toBe("ready");
      if (first.status !== "ready") throw new Error(`prepare failed: ${JSON.stringify(first)}`);
      await settleLeverBlocking(first);

      const preview = await previewSiteSubmission(deps(), { workspaceId, attemptId: first.attemptId });
      expect(preview.status).toBe("ok");
      if (preview.status !== "ok") throw new Error(`preview failed: ${JSON.stringify(preview)}`);

      const confirm = await confirmAndSubmitSite(deps(), {
        workspaceId, attemptId: first.attemptId, presentedToken: preview.token, retypedTarget: HOST,
      });
      expect(confirm.status).toBe("submitted");

      const secondApplicationId = await readyApplication("Duplicate Second Robotics Co", jobUrl);
      const second = await prepareSiteApplication(deps(), { workspaceId, applicationId: secondApplicationId, url: jobUrl });
      expect(second).toEqual({ status: "duplicate", existingApplicationId: firstApplicationId });
      // A refused prepare leaves nothing behind for the second application.
      expect(await listAttemptsForApplication(db, secondApplicationId)).toHaveLength(0);
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    "pauses on the signature fixture's required legal attestation -> blocked, no submission recorded",
    async () => {
      // A required attestation CHECKBOX (the greenhouse fixture's
      // `legal_attestation`) is demoted to field-level consent as of the
      // 2026-08-04 revision — see the "demotes the greenhouse checkbox
      // attestation" case below for that proof. What still cannot be
      // rendered as a tick CareerHQ could honestly complete on the user's
      // behalf is a typed-signature/date attestation, so that fixture is
      // this file's `blocked` proof now. Any signature job id renders the
      // same required signature fields; this one is unique to this test so
      // the assertion cannot collide with other suites.
      const jobUrl = signatureUrl("e2e-attestation");
      const applicationId = await readyApplication("Attestation Robotics Co", jobUrl);
      const before = await submissionsFor("e2e-attestation");

      const outcome = await prepareSiteApplication(deps(), { workspaceId, applicationId, url: jobUrl });
      expect(outcome.status).toBe("blocked");
      if (outcome.status !== "blocked") throw new Error(`expected blocked, got ${JSON.stringify(outcome)}`);
      expect(outcome.kind).toBe("legal_attestation");

      const attempts = await listAttemptsForApplication(db, applicationId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe("BLOCKED");
      // A paused attempt captured nothing to submit — no snapshot, no click.
      expect(await getLatestSnapshot(db, attempts[0]!.id)).toBeNull();
      expect(await submissionsFor("e2e-attestation")).toHaveLength(before.length);
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    "demotes the greenhouse checkbox attestation to a consent tick: prepare -> ready -> user ticks it -> submitted, ticked",
    async () => {
      // Any greenhouse job id renders the same required attestation checkbox;
      // this one is unique to this test so the assertion cannot collide with
      // driver.test.ts, which submits to greenhouse `eng-1` in parallel.
      const jobUrl = greenhouseUrl("e2e-attestation-demoted");
      const applicationId = await readyApplication("Consent Tick Robotics Co", jobUrl);
      const before = await submissionsFor("e2e-attestation-demoted");

      const outcome = await prepareSiteApplication(deps(), { workspaceId, applicationId, url: jobUrl });
      expect(outcome.status).toBe("ready");
      if (outcome.status !== "ready") throw new Error(`prepare failed: ${JSON.stringify(outcome)}`);

      const attestationField = outcome.form.fields.find((f) => f.canonicalField === "legal_attestation");
      if (!attestationField) throw new Error("no legal_attestation field on the greenhouse fixture");
      // Never pre-ticked, never profile/ai-sourced: the planner hands it back
      // to the user with an empty value, exactly like any other consent-only
      // field (spec §10.6, revised).
      const plannedAttestation = outcome.answers.find((a) => a.fieldId === attestationField.id);
      expect(plannedAttestation).toMatchObject({ needsUser: true, source: "user", value: "" });
      expect(outcome.blocking).toContain(attestationField.id);

      // The user personally ticks it, seeing the exact attestation text.
      const tick = await updatePlannedAnswer(deps(), {
        workspaceId, snapshotId: outcome.snapshotId, fieldId: attestationField.id, value: "true",
      });
      expect(tick).toEqual({ ok: true });

      await settleGreenhouseBlocking(outcome, new Set([attestationField.id]));

      const preview = await previewSiteSubmission(deps(), { workspaceId, attemptId: outcome.attemptId });
      expect(preview.status).toBe("ok");
      if (preview.status !== "ok") throw new Error(`preview failed: ${JSON.stringify(preview)}`);
      expect(preview.payload.host).toBe(HOST);
      // The tick is inside the fingerprinted payload — source "user", value "true".
      const previewedAttestation = preview.payload.answers.find((a) => a.fieldId === attestationField.id);
      expect(previewedAttestation).toMatchObject({ value: "true", source: "user" });

      const confirm = await confirmAndSubmitSite(deps(), {
        workspaceId, attemptId: outcome.attemptId, presentedToken: preview.token, retypedTarget: HOST,
      });
      expect(confirm.status).toBe("submitted");
      if (confirm.status !== "submitted") throw new Error(`confirm failed: ${JSON.stringify(confirm)}`);

      const [application] = await db.select().from(applications).where(eq(applications.id, applicationId));
      expect(application?.state).toBe("SUBMITTED");

      // The recorded demo-ats submission carries the attestation as ticked.
      const after = await submissionsFor("e2e-attestation-demoted");
      expect(after.length).toBe(before.length + 1);
      const created = after.find((s) => s.id === confirm.confirmationId);
      expect(created).toBeDefined();
      expect(created?.fields["legal_attestation"]).toBe("true");
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    "hands the token back for a consent box it cannot untick — pre-click, never needs_reconcile",
    async () => {
      // The fixture ships the consent box pre-ticked inside a display:none
      // wrapper, so `uncheck()` waits for actionability and throws a
      // TimeoutError. Every Playwright timeout used to collapse onto
      // `kind: "timeout"`, which sits OUTSIDE PRE_CLICK_DRIVER_ERROR_KINDS —
      // so a field that could not be ticked took the assume-the-worst branch
      // and parked the attempt for a human to reconcile a submission that was
      // never made. Interacting with a form control cannot submit the form.
      //
      // This is the whole-stack proof of the P6 final review's BLOCKING 1: the
      // refusal is raised INSIDE `submit`, after `beginSubmission`, so being
      // pre-click used to still cost the visitor their confirmation and leave a
      // terminal FAILED attempt that could not be re-previewed. A refusal that
      // provably typed nothing must cost nothing.
      const jobUrl = `${DEMO_ATS_URL}/hidden-consent/jobs/e2e-hidden-consent`;
      const applicationId = await readyApplication("Untickable Robotics Co", jobUrl);
      const before = await submissionsFor("e2e-hidden-consent");

      // Short browser timeout: the failure IS the assertion, so there is
      // nothing worth waiting the 45s default for.
      const fastConfig = config({ AUTOAPPLY_BROWSER_TIMEOUT_MS: "2000" });
      const fastDeps = deps({ config: fastConfig });

      const outcome = await prepareSiteApplication(fastDeps, { workspaceId, applicationId, url: jobUrl });
      expect(outcome.status).toBe("ready");
      if (outcome.status !== "ready") throw new Error(`prepare failed: ${JSON.stringify(outcome)}`);

      const consentField = outcome.form.fields.find((f) => f.label.includes("background check"));
      if (!consentField) throw new Error("no background-check consent field on the hidden-consent fixture");
      // Declined, the same way the review screen's consent row commits it.
      for (const fieldId of outcome.blocking) {
        const result = await updatePlannedAnswer(fastDeps, {
          workspaceId, snapshotId: outcome.snapshotId, fieldId, value: "",
        });
        expect(result).toEqual({ ok: true });
      }
      expect(outcome.blocking).toContain(consentField.id);

      const preview = await previewSiteSubmission(fastDeps, { workspaceId, attemptId: outcome.attemptId });
      expect(preview.status).toBe("ok");
      if (preview.status !== "ok") throw new Error(`preview failed: ${JSON.stringify(preview)}`);

      const confirm = await confirmAndSubmitSite(fastDeps, {
        workspaceId, attemptId: outcome.attemptId, presentedToken: preview.token, retypedTarget: HOST,
      });
      expect(confirm).toMatchObject({ status: "blocked", code: "driver_refused" });
      expect(confirm.status).not.toBe("needs_reconcile");

      // Nothing reached the site, so there is nothing for a human to
      // reconcile — and nothing was spent either: the attempt is back where the
      // preview left it and its confirmation is live again, so the same token
      // still works.
      const attempt = await getAttempt(db, outcome.attemptId);
      expect(attempt?.status).toBe("PENDING_CONFIRMATION");
      expect(attempt?.pendingReceipt).toBeNull();
      expect((await getActiveConfirmation(db, outcome.attemptId))?.consumedAt ?? null).toBeNull();
      expect(await submissionsFor("e2e-hidden-consent")).toHaveLength(before.length);
    },
    BROWSER_TIMEOUT_MS,
  );

  it(
    "pauses on a captcha page -> blocked with kind captcha, no submission recorded",
    async () => {
      const jobUrl = captchaUrl("e2e-captcha");
      const applicationId = await readyApplication("Captcha Robotics Co", jobUrl);
      const before = await submissionsFor("e2e-captcha");

      const outcome = await prepareSiteApplication(deps(), { workspaceId, applicationId, url: jobUrl });
      expect(outcome.status).toBe("blocked");
      if (outcome.status !== "blocked") throw new Error(`expected blocked, got ${JSON.stringify(outcome)}`);
      expect(outcome.kind).toBe("captcha");

      expect(await submissionsFor("e2e-captcha")).toHaveLength(before.length);
    },
    BROWSER_TIMEOUT_MS,
  );
});
