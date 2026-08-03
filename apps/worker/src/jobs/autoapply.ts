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
  cvVariants as cvVariantsTable, getApplicationDetail, getAttempt, getLatestSnapshot, updateRecoveryState,
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
 * What `runSubmitJob` leaves on the snapshot's `recoveryState` after the one
 * submit click. Shaped to match `SiteSubmitResult` field-for-field (minus the
 * Buffer, which this job has already turned into a path) so the production
 * `SiteDeps.submit` this queue variant stands in for can read it back with no
 * translation.
 */
export interface SubmitResultRecovery {
  kind: "submit_result";
  confirmationId: string | null;
  finalUrl: string;
  screenshotPath: string;
  pageText: string;
}

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

  const session = await openSession();
  try {
    const page = await capturePage(session, data.url, { timeoutMs: config.autoapplyBrowserTimeoutMs });
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
 * Step 2 of the queue variant (spec §10): fill the form from the snapshot's
 * planned answers, click Submit exactly once, and record the evidence back
 * onto the snapshot. The gate that decides *whether* to submit has already
 * run in `apps/web` before this job was ever enqueued — this job submits,
 * nothing more, and (like `runCaptureJob`) never touches the attempt's own
 * status. The screenshot is written to disk under
 * `${fileStorageDir}/autoapply/${attemptId}.png` only once `fillAndSubmit`
 * has actually returned; a throw leaves neither the file nor the recovery
 * write behind, and the session is always closed.
 */
export async function runSubmitJob(db: Db, config: AppConfig, data: SubmitJobData): Promise<void> {
  const attempt = await loadWorkspaceAttempt(db, data.workspaceId, data.attemptId);
  const snapshot = await loadLatestSnapshot(db, attempt.id);

  const form = canonicalFormSchema.parse(snapshot.canonicalForm);
  const answers = plannedAnswersSchema.parse(snapshot.plannedAnswers);
  const files = await resolveFilePaths(db, data.workspaceId, form, answers);

  const session = await openSession();
  try {
    const result = await fillAndSubmit(session, {
      url: form.url,
      form,
      answers,
      files,
      deps: { timeoutMs: config.autoapplyBrowserTimeoutMs },
    });

    const dir = path.join(config.fileStorageDir, "autoapply");
    await mkdir(dir, { recursive: true });
    const screenshotPath = path.join(dir, `${data.attemptId}.png`);
    await writeFile(screenshotPath, result.screenshotPng);

    const recovery: SubmitResultRecovery = {
      kind: "submit_result",
      confirmationId: result.confirmationId,
      finalUrl: result.finalUrl,
      screenshotPath,
      pageText: result.pageText,
    };
    await updateRecoveryState(db, snapshot.id, snapshot.currentStep, recovery);
  } finally {
    await session.close();
  }
}
