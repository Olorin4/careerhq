// The autoapply queue jobs — the worker-side half of P5's split (spec §10):
// the browser stays here, and everything it produces crosses to the
// gated web orchestrator through a `form_snapshots` row's `recovery_state`
// column rather than a return value, because a queue job has no caller
// waiting on a response. Neither job ever transitions the attempt itself
// (DRAFT/READY/BLOCKED/...) — the gate matrix in `apps/web`'s
// `site-submission.ts` is the one place that decides what an attempt's
// status means, and it owns every transition.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppConfig } from "@careerhq/config";
import { canonicalFormSchema, plannedAnswerSchema, type CanonicalForm, type PlannedAnswer } from "@careerhq/contracts";
import type { RawFormPage } from "@careerhq/autoapply";
import {
  allowsCaptureTarget, effectiveWorkspaceKind, refuseCaptureTarget, type CaptureTargetPolicy,
} from "@careerhq/autoapply/policy";
import { reserveEvidenceScreenshot } from "@careerhq/core/storage";
import {
  cvVariants as cvVariantsTable, getApplicationDetail, getAttempt, getLatestSnapshot,
  listEvidenceScreenshotPaths, updateRecoveryState,
  workspaces as workspacesTable,
  type ApplicationAttempt, type Db, type FormSnapshot,
} from "@careerhq/db";
import { capturePage, fillAndSubmit, openSession } from "../autoapply/driver.js";

export interface CaptureJobData {
  workspaceId: string;
  applicationId: string;
  attemptId: string;
  url: string;
}

export interface SubmitJobData {
  workspaceId: string;
  attemptId: string;
}

/**
 * What `runCaptureJob` leaves on the snapshot's `recoveryState`: the page as
 * the browser saw it, browser-free from here on — `parseForm` (and
 * `detectBlockers` before it) run against this in the web process with no
 * Playwright dependency at all.
 */
export interface RawPageRecovery {
  kind: "raw_page";
  page: RawFormPage;
}

/**
 * Written onto the snapshot's `recoveryState` in the instant BEFORE the one
 * submit click, and the single reason this job is safe for pg-boss to retry.
 *
 * A queue job is retried on any throw, and the click is the one thing in it
 * that cannot be undone: once the button is pressed the application is in,
 * whatever happens to this process afterwards. So the fact that a click MAY
 * have happened is made durable before it can happen, rather than after — a
 * retry that finds this marker knows a browser was standing on the submit
 * button with the outcome unrecorded, and refuses to press it a second time.
 *
 * It is deliberately not "submitted": at the moment it is written nothing has
 * been sent yet, and claiming otherwise would be as dishonest as the throw it
 * replaces. It means exactly "unknown, and not safe to repeat".
 */
export interface SubmitInFlightRecovery {
  kind: "submit_in_flight";
  startedAt: string;
}

/**
 * What `runSubmitJob` leaves on the snapshot's `recoveryState` after the one
 * submit click. Shaped to match `SiteSubmitResult` (minus the Buffer, which
 * this job has already turned into a path) so the production `SiteDeps.submit`
 * this queue variant stands in for can read it back with no translation.
 *
 * The two deliberate divergences from `SiteSubmitResult` are both about the
 * screenshot, and both exist because the evidence write happens AFTER the
 * click: `screenshotPath` is nullable and `evidenceError` says why when it is
 * null. A submission with no screenshot is a real submission with missing
 * evidence — a degraded outcome, not a failed one — and the receipt must be
 * able to say so instead of claiming a file that is not there. (A reader that
 * wants `SiteSubmitResult`'s non-null `screenshotPath` has to decide what a
 * null means; the honest answer is "record the submission, note the missing
 * evidence", never "re-submit".)
 */
export interface SubmitResultRecovery {
  kind: "submit_result";
  confirmationId: string | null;
  finalUrl: string;
  /** null when the click landed but the evidence write did not — see `evidenceError`. */
  screenshotPath: string | null;
  /** Why there is no screenshot, or null when there is one. */
  evidenceError: string | null;
  pageText: string;
}

/**
 * The click may have landed and this process cannot say what came back: an
 * unrecognised throw out of `fillAndSubmit`, or a retry that found a
 * `submit_in_flight` marker left by a run that died mid-click. Terminal, and a
 * human's problem — the same judgement `confirmAndSubmitSite` makes when it
 * parks an attempt in NEEDS_RECONCILE rather than guessing.
 */
export interface SubmitUnknownRecovery {
  kind: "submit_unknown";
  reason: string;
  observedAt: string;
}

export type SubmitRecovery = SubmitInFlightRecovery | SubmitResultRecovery | SubmitUnknownRecovery;

/**
 * Every recovery shape that means "a submit click for this snapshot has begun".
 * `raw_page` (what `runCaptureJob` leaves) is deliberately not one of them: a
 * captured page is a page nobody has submitted.
 */
const SUBMIT_RECOVERY_KINDS: ReadonlySet<string> = new Set([
  "submit_in_flight", "submit_result", "submit_unknown",
]);

/** The submit-recovery kind already on a snapshot, or null if there is none. */
function submitRecoveryKind(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  const kind: unknown = (state as { kind?: unknown }).kind;
  return typeof kind === "string" && SUBMIT_RECOVERY_KINDS.has(kind) ? kind : null;
}

/**
 * `DriverError.kind`s that are provably raised BEFORE the one submit click —
 * the SAME two `apps/web`'s `PRE_CLICK_DRIVER_ERROR_KINDS` names, for the same
 * reason and with the same warning: nothing may be added here that the driver
 * can raise after the button is pressed, because this set is what decides
 * whether a failure may be retried at all.
 *
 * Recognised structurally (`name` + a string `kind`) rather than by
 * `instanceof`, because `driver.js` is mocked wholesale in this job's unit
 * tests and an `instanceof` against a mocked-away class silently answers false
 * — in the unsafe direction.
 */
const PRE_CLICK_DRIVER_ERROR_KINDS: ReadonlySet<string> = new Set(["navigation", "fill"]);

function isPreClickDriverFailure(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== "DriverError") return false;
  const kind: unknown = (err as Error & { kind?: unknown }).kind;
  return typeof kind === "string" && PRE_CLICK_DRIVER_ERROR_KINDS.has(kind);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What a retry that finds a `submit_in_flight` marker records instead of clicking. */
const UNRECORDED_CLICK_REASON =
  "a previous run of this job had already clicked Submit and its outcome was never recorded — "
  + "the application may be in; check the site before submitting again";

const plannedAnswersSchema = z.array(plannedAnswerSchema);

/**
 * Loads the attempt and checks it belongs to the caller's workspace — the
 * same scoping `site-submission.ts` applies in the request path, reapplied
 * here because a queue job's `data` is just as untrusted as a request body.
 */
async function loadWorkspaceAttempt(db: Db, workspaceId: string, attemptId: string): Promise<ApplicationAttempt> {
  const attempt = await getAttempt(db, attemptId);
  if (!attempt) throw new Error(`autoapply job: attempt not found: ${attemptId}`);

  const detail = await getApplicationDetail(db, attempt.applicationId);
  if (!detail || detail.application.workspaceId !== workspaceId) {
    throw new Error(`autoapply job: attempt ${attemptId} does not belong to workspace ${workspaceId}`);
  }
  return attempt;
}

/**
 * Who this workspace's browser may be pointed at — the SAME function apps/web
 * gates the interactive path with (`@careerhq/autoapply/policy`), which is the
 * whole reason that module no longer lives in apps/web.
 *
 * These jobs used to have no host gate whatsoever: `runCaptureJob` handed
 * `data.url` straight to `capturePage`, and only the driver's protocol floor
 * stood between a queue payload and `http://169.254.169.254/`. It was
 * unreachable only because `apps/worker/src/main.ts` never registers the
 * `autoapply.capture`/`autoapply.submit` consumers — so re-registering them
 * would have shipped an ungated second entry point (P6 fix-wave review, A2).
 * A queue payload is exactly as untrusted as a request body, and is gated the
 * same way here: refused before a browser is started, not after.
 */
async function capturePolicy(db: Db, config: AppConfig, workspaceId: string): Promise<CaptureTargetPolicy> {
  const [workspace] = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId));
  if (!workspace) throw new Error(`autoapply job: workspace not found: ${workspaceId}`);
  return {
    workspaceKind: effectiveWorkspaceKind(config, workspace.kind),
    sandboxSiteAllowedHost: config.sandboxSiteAllowedHost,
  };
}

/** The attempt's newest snapshot, or a refusal — every recovery write targets a snapshot that already exists. */
async function loadLatestSnapshot(db: Db, attemptId: string): Promise<FormSnapshot> {
  const snapshot = await getLatestSnapshot(db, attemptId);
  if (!snapshot) throw new Error(`autoapply job: attempt ${attemptId} has no form snapshot`);
  return snapshot;
}

/**
 * Step 1 of the queue variant (spec §10): open a session, read the live page
 * exactly once, and hand the raw result to the web orchestrator through the
 * snapshot — never parsed here, so this job stays a pure browser step. A
 * throw from the driver leaves the snapshot exactly as it was: the write only
 * happens after `capturePage` has already returned successfully, and the
 * session is always closed via `finally`, throw or not.
 */
export async function runCaptureJob(db: Db, config: AppConfig, data: CaptureJobData): Promise<void> {
  const attempt = await loadWorkspaceAttempt(db, data.workspaceId, data.attemptId);
  if (attempt.applicationId !== data.applicationId) {
    throw new Error(
      `autoapply capture: attempt ${data.attemptId} belongs to application ${attempt.applicationId}, not ${data.applicationId}`,
    );
  }
  const snapshot = await loadLatestSnapshot(db, attempt.id);

  // A capture write would overwrite whatever is on the snapshot, and one of the
  // things that can be on it is `runSubmitJob`'s pre-click marker — the only
  // record that a submit click may already have happened. Erasing it would
  // hand a later submit retry a clean slate and re-open the double submit, so
  // a capture onto a snapshot that has begun submitting is refused outright.
  // It is not a legitimate sequence in the first place: the flow captures,
  // plans onto a fresh snapshot, and only then submits.
  const submitted = submitRecoveryKind(snapshot.recoveryState);
  if (submitted) {
    throw new Error(
      `autoapply capture: attempt ${attempt.id} has already begun submitting (${submitted}); refusing to overwrite it`,
    );
  }

  const policy = await capturePolicy(db, config, data.workspaceId);
  const refusal = refuseCaptureTarget(data.url, policy);
  if (refusal) throw new Error(`autoapply capture: refusing to open ${data.url}: ${refusal}`);

  const session = await openSession();
  try {
    const page = await capturePage(session, data.url, {
      timeoutMs: config.autoapplyBrowserTimeoutMs,
      isNavigationAllowed: (target) => allowsCaptureTarget(target, policy),
    });
    const recovery: RawPageRecovery = { kind: "raw_page", page };
    await updateRecoveryState(db, snapshot.id, snapshot.currentStep, recovery);
  } finally {
    await session.close();
  }
}

/**
 * Resolves every file-kind field's planned answer (a CV-variant/document id)
 * to the absolute path `fillAndSubmit` uploads from. Mirrors the same lookup
 * `site-submission.ts`'s `loadSiteSubmission` performs for the interactive
 * path — scoped to the workspace, and refusing outright (rather than quietly
 * skipping the attachment) when a chosen document no longer exists, since a
 * job with no caller to show a "cv unavailable" outcome to must not submit an
 * application missing the resume the plan promised.
 */
async function resolveFilePaths(
  db: Db,
  workspaceId: string,
  form: CanonicalForm,
  answers: PlannedAnswer[],
): Promise<Record<string, string>> {
  const answerByFieldId = new Map(answers.map((answer) => [answer.fieldId, answer]));
  const files: Record<string, string> = {};

  for (const field of form.fields) {
    if (field.kind !== "file") continue;
    const documentId = answerByFieldId.get(field.id)?.value.trim();
    if (!documentId) continue;

    const [variant] = await db.select().from(cvVariantsTable).where(and(
      eq(cvVariantsTable.id, documentId),
      eq(cvVariantsTable.workspaceId, workspaceId),
    ));
    if (!variant) {
      throw new Error(`autoapply submit: the document chosen for "${field.label}" (${documentId}) no longer exists`);
    }
    files[field.id] = variant.filePath;
  }

  return files;
}

/**
 * Restores the recovery state a pre-click marker replaced. Only ever called
 * where nothing was clicked, so the marker is a lie that must be taken back:
 * leaving it would park a genuinely retryable failure forever.
 *
 * A failure to restore is logged, never thrown — the caller is already
 * rethrowing the real error, and the consequence of a stuck marker is that the
 * retry records `submit_unknown` instead of clicking. That is over-cautious in
 * exactly the direction this whole job is built to err in.
 */
async function restoreRecoveryState(db: Db, snapshot: FormSnapshot): Promise<void> {
  try {
    await updateRecoveryState(db, snapshot.id, snapshot.currentStep, snapshot.recoveryState);
  } catch (err) {
    console.error(
      `[autoapply] snapshot ${snapshot.id}: nothing was submitted but the in-flight marker could not be `
      + `cleared, so a retry will park this attempt instead of retrying it: ${errorMessage(err)}`,
    );
  }
}

/**
 * Writes the confirmation screenshot, and answers with the truth either way.
 * This runs AFTER the click, so it must not throw: the submission is a fact in
 * the world regardless of what happens to a file on this disk, and a throw here
 * is a pg-boss retry, and a pg-boss retry is a second application. A failed
 * write is a receipt that says it has no screenshot, which is honest, terminal,
 * and — unlike a retry — harmless.
 */
async function storeEvidence(
  config: AppConfig,
  attemptId: string,
  screenshotPng: Buffer,
): Promise<{ path: string | null; error: string | null }> {
  const dir = path.join(config.fileStorageDir, "autoapply");
  const screenshotPath = path.join(dir, `${attemptId}.png`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(screenshotPath, screenshotPng);
    return { path: screenshotPath, error: null };
  } catch (err) {
    console.error(
      `[autoapply] attempt ${attemptId}: the submission landed but its confirmation screenshot `
      + `could not be written: ${errorMessage(err)}`,
    );
    return { path: null, error: `the confirmation screenshot could not be saved: ${errorMessage(err)}` };
  }
}

/**
 * Step 2 of the queue variant (spec §10): fill the form from the snapshot's
 * planned answers, click Submit AT MOST once across every retry pg-boss will
 * ever make, and record the evidence back onto the snapshot. The gate that
 * decides *whether* to submit has already run in `apps/web` before this job
 * was ever enqueued — this job submits, nothing more, and (like
 * `runCaptureJob`) never touches the attempt's own status.
 *
 * ## Why this job is shaped the way it is
 *
 * pg-boss retries a job that throws. The submit click cannot be retried: after
 * it, the application is in, and nothing this process does afterwards — a
 * failed screenshot write, a lost database connection, the process being
 * killed — makes that less true. This job used to let a post-click `writeFile`
 * failure throw, so pg-boss would have re-run it and submitted the same
 * application again; driven against `demo-ats` with the guards removed, one
 * user intent produced THREE applications. That is the exact failure mode the
 * three-layer gated protocol exists to prevent, and it is why neither
 * auto-apply consumer was ever registered in `apps/worker/src/main.ts` (see
 * "Carried beyond P6 → Security" in `docs/roadmap.md`).
 *
 * Three rules close it, and every line below is one of them:
 *
 *   1. **Everything that can fail harmlessly happens before the browser
 *      opens** — workspace scoping, the snapshot, the form, the documents, the
 *      host policy, the disk reservation. All still throw, and all are still
 *      retried, because none of them can have submitted anything.
 *   2. **The fact that a click may have happened is durable before it can
 *      happen** — the `submit_in_flight` marker, written in the instant before
 *      `fillAndSubmit`. A retry that finds it does not click; it records
 *      `submit_unknown` and stops. This is what makes the job idempotent even
 *      when the process dies mid-click, which no post-click write could.
 *   3. **Nothing after the click ever throws.** The evidence write is caught
 *      and degrades to a receipt that admits it has no screenshot; an
 *      unrecognised driver throw becomes `submit_unknown`. Both are terminal.
 *      The one post-click throw left is a failed recovery *write*, and it is
 *      safe precisely because rule 2 already ran: the retry it triggers cannot
 *      click.
 *
 * The `attempts_one_submitted_per_application` partial unique index is a
 * backstop for a different thing and cannot substitute for any of this: it
 * stops a second attempt ROW reaching SUBMITTED for one application, which is
 * bookkeeping. It sits behind `completeSubmission` in `apps/web`, long after
 * the browser has pressed anything, and it is per-application — a retry of
 * THIS job re-submits the SAME attempt, so the index would not even be
 * consulted, and if it were it would fire after the second application had
 * already been posted to the ATS. It protects the database's story; only the
 * marker protects the world.
 *
 * The screenshot is written under `${fileStorageDir}/autoapply/${attemptId}.png`.
 * In demo mode that directory shares a bounded, reclaimed store with the web
 * app's `site-screenshots/`, and the room for it is reserved before the browser
 * opens — see the reservation below.
 */
export async function runSubmitJob(db: Db, config: AppConfig, data: SubmitJobData): Promise<void> {
  const attempt = await loadWorkspaceAttempt(db, data.workspaceId, data.attemptId);
  const snapshot = await loadLatestSnapshot(db, attempt.id);

  // The idempotency gate, and the first thing after loading for a reason: it
  // runs before the disk reservation (whose collector has side effects) and
  // long before a browser could open. Everything it can find means a click has
  // already begun for this snapshot.
  const already = submitRecoveryKind(snapshot.recoveryState);
  if (already === "submit_result" || already === "submit_unknown") {
    // Already terminal. The job "succeeded" the first time in the only sense
    // that matters — the click is spent — so this run is a no-op rather than a
    // failure: reporting a failure to pg-boss would only earn another retry.
    console.log(`[autoapply] attempt ${data.attemptId}: already ${already}; not submitting again`);
    return;
  }
  if (already === "submit_in_flight") {
    // A run of this job was standing on the submit button when it died. The
    // application may be in and there is no way to tell from here, so the one
    // safe move is to say so and stop. Deliberately NOT thrown: a throw is a
    // retry, and there is nothing left that a retry could safely do.
    console.error(`[autoapply] attempt ${data.attemptId}: ${UNRECORDED_CLICK_REASON}`);
    const unknown: SubmitUnknownRecovery = {
      kind: "submit_unknown", reason: UNRECORDED_CLICK_REASON, observedAt: new Date().toISOString(),
    };
    await updateRecoveryState(db, snapshot.id, snapshot.currentStep, unknown);
    return;
  }

  const form = canonicalFormSchema.parse(snapshot.canonicalForm);
  const answers = plannedAnswersSchema.parse(snapshot.plannedAnswers);
  const files = await resolveFilePaths(db, data.workspaceId, form, answers);

  // `form.url` is where the capture LANDED, so it is gated here too rather
  // than assumed safe because a capture once produced it.
  const policy = await capturePolicy(db, config, data.workspaceId);
  const refusal = refuseCaptureTarget(form.url, policy);
  if (refusal) throw new Error(`autoapply submit: refusing to open ${form.url}: ${refusal}`);

  // Room on disk for the screenshot this job is about to produce, checked in
  // exactly the position the host gate above occupies and for the same reason:
  // before a browser is started, so a refusal costs nothing and leaves the
  // attempt and its snapshot exactly as they were. It cannot be checked at the
  // `writeFile` below, which happens after the submit click — by then the
  // application is in and the evidence is the only thing worth keeping.
  //
  // `apps/web`'s interactive path reserves against the SAME store (this
  // directory plus `site-screenshots/`) through the same function, so the two
  // processes cannot each spend the whole budget, and the collector inside it
  // works from the database's live set with a grace window, so neither
  // process's in-flight write is ever the other's victim.
  //
  // A throw is the failure shape of every PRE-click refusal in this job, and
  // pg-boss records it as a failed job and retries it — which is correct here
  // and only here, because no browser has opened: nothing is written, no
  // recovery state claims evidence that does not exist, and nothing has been
  // submitted that a retry could submit twice. Demo-only: a self-hosted
  // worker's screenshots are records of real applications and are neither
  // quota'd nor reclaimed.
  const storeRefusal = await reserveEvidenceScreenshot({
    fileStorageDir: config.fileStorageDir,
    referencedPaths: config.demoMode ? await listEvidenceScreenshotPaths(db) : [],
    demoMode: config.demoMode,
  });
  if (storeRefusal) throw new Error(`autoapply submit: ${storeRefusal}`);

  // Opening the session is still a pre-click step: a launch failure, and the
  // browser-limit refusal in particular, means no page and no button, so it
  // throws and is retried like every refusal above it. The marker is written
  // after it for exactly that reason — a browser that never started must not
  // leave a "may have clicked" record behind.
  const session = await openSession();
  try {
    const marker: SubmitInFlightRecovery = { kind: "submit_in_flight", startedAt: new Date().toISOString() };
    await updateRecoveryState(db, snapshot.id, snapshot.currentStep, marker);

    let result;
    try {
      result = await fillAndSubmit(session, {
        url: form.url,
        form,
        answers,
        files,
        deps: {
          timeoutMs: config.autoapplyBrowserTimeoutMs,
          isNavigationAllowed: (target) => allowsCaptureTarget(target, policy),
        },
      });
    } catch (err) {
      if (isPreClickDriverFailure(err)) {
        // Provably before the click: the page never opened, or the driver
        // refused while filling. Nothing was sent, so the marker is withdrawn
        // and the job fails the way it always did — retryable, and a retry may
        // legitimately click.
        await restoreRecoveryState(db, snapshot);
        throw err;
      }
      // Unclassified, and the click is inside the call that threw. Assume the
      // worst, record it, and STOP: rethrowing would hand pg-boss a job whose
      // retry might submit the application a second time. (The marker would
      // catch that retry, but the honest reason belongs on the row now, while
      // this process still knows what happened.)
      const reason = `the submit click failed in an unrecognised way and may have landed: ${errorMessage(err)}`;
      console.error(`[autoapply] attempt ${data.attemptId}: ${reason}`);
      const unknown: SubmitUnknownRecovery = {
        kind: "submit_unknown", reason, observedAt: new Date().toISOString(),
      };
      await updateRecoveryState(db, snapshot.id, snapshot.currentStep, unknown);
      return;
    }

    // ---- Past this line the application is in. Nothing may throw. ----
    const evidence = await storeEvidence(config, data.attemptId, result.screenshotPng);

    const recovery: SubmitResultRecovery = {
      kind: "submit_result",
      confirmationId: result.confirmationId,
      finalUrl: result.finalUrl,
      screenshotPath: evidence.path,
      evidenceError: evidence.error,
      pageText: result.pageText,
    };
    // The one write left that can throw. It is safe to let it: the marker is
    // already on the row, so the retry it triggers records `submit_unknown`
    // rather than clicking, and the alternative — swallowing it — would leave
    // a real submission with no record of itself at all.
    await updateRecoveryState(db, snapshot.id, snapshot.currentStep, recovery);
  } finally {
    await session.close();
  }
}
