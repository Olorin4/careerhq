import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppConfig } from "@careerhq/config";
import {
  canonicalFormSchema, plannedAnswerSchema,
  type AnswerSource, type ApplicationState, type BlockerKind,
  type CanonicalForm, type CanonicalFormField, type PlannedAnswer,
} from "@careerhq/contracts";
import { detectBlockers, parseForm, type RawFormPage } from "@careerhq/autoapply";
import { generateGrounded, interpretField, type GenerateInput } from "@careerhq/ai";
import {
  canTransition, isConsentOnlyField, isSensitiveField, MIN_FILL_CONFIDENCE, planAnswers,
  requiresUserBeforeSubmit, selectFactsForGeneration, SENSITIVE_CANONICAL_FIELDS, validateGeneration,
  type FactForSelection, type PlanInputs, type ProfileValues, type SavedAnswerLike,
} from "@careerhq/core";
import {
  CONFIRMATION_TTL_MS, evaluateSubmissionGates, generateConfirmationToken, hashConfirmationToken,
  payloadFingerprint, type GateCheckInput,
} from "@careerhq/core/gates";
import { reserveEvidenceScreenshot } from "@careerhq/core/storage";
import {
  applicationEvents as applicationEventsTable, beginSubmission, completeSubmission,
  createSiteAttempt, cvVariants as cvVariantsTable, failSubmission, findRequisitionAttempt,
  formSnapshots as formSnapshotsTable,
  getApplicationDetail, getAttempt, getLatestConfirmation, getLatestSnapshot, hasBlockingAttempt, isFactStale,
  listAnswers, listCvVariants, listEvidenceScreenshotPaths, listFacts, listReusableAnswers,
  markAttemptBlocked, markAttemptReady,
  markNeedsReconcile, recordPreview, saveFormSnapshot, updateSnapshotAnswers, workspaces as workspacesTable,
  type ApplicationAttempt, type CandidateFact, type CvVariant, type Db, type FormSnapshot,
} from "@careerhq/db";
import { redactError } from "@careerhq/email";
import { stripHtml } from "@careerhq/ingest";
import {
  effectiveWorkspaceKind, refuseCaptureTarget, type CaptureTargetPolicy,
} from "@careerhq/autoapply/policy";

/** What the driver hands back after the one submit click (worker `fillAndSubmit`, adapted). */
export interface SiteSubmitResult {
  /** null when the site shows no confirmation id — no evidence, so no claim of success. */
  confirmationId: string | null;
  finalUrl: string;
  /** Absolute path of the stored confirmation-page screenshot. */
  screenshotPath: string;
  pageText: string;
}

export interface SiteSubmitArgs {
  url: string;
  form: CanonicalForm;
  answers: PlannedAnswer[];
  /** fieldId → absolute path of the file to upload. */
  files: Record<string, string>;
  /**
   * Who this workspace may be driven at, carried down to the driver so every
   * navigation the submit performs — including any redirect the site answers
   * with — is judged by the same rules that let the attempt exist at all.
   */
  policy: CaptureTargetPolicy;
}

export interface SiteDeps {
  db: Db;
  config: AppConfig;
  /**
   * Reads the live page. Injected: the real implementation drives Playwright
   * from the worker, which this process cannot do — an unset `capture` means
   * auto-apply is simply unavailable here, never that a page was empty.
   */
  capture?: (url: string, policy: CaptureTargetPolicy) => Promise<RawFormPage>;
  /** Fills the form and clicks Submit exactly once. Injected for the same reason. */
  submit?: (args: SiteSubmitArgs) => Promise<SiteSubmitResult>;
  /**
   * Cheap "can a browser actually start here?" check — a launch/close round
   * trip, resolving on success and throwing on failure. Run as the LAST
   * pre-`beginSubmission` check so a process that cannot start Chromium refuses
   * with `driver_unavailable` while the token is still unburned, instead of
   * discovering it inside `submit` and parking the attempt NEEDS_RECONCILE
   * claiming "the click may have landed" when no browser ever started.
   *
   * Optional: an unset probe means "do not check", which is what every test
   * with a stubbed `submit` wants. The real one is `siteBrowserReservation`'s
   * `probeDriver` in `./site-driver.ts`, which also HOLDS the process's browser
   * slot from here until the action that called it releases it — so the busy
   * refusal below is the only one a confirm can get, and it lands with the
   * token still unburned. This module neither knows nor needs to know that: it
   * sees a function that resolves or throws.
   */
  probeDriver?: () => Promise<void>;
  /** Injected in tests; defaults to the real fast-tier field interpreter. */
  interpret?: typeof interpretField;
  /** Injected in tests; defaults to the real grounded generate task. */
  generate?: typeof generateGrounded;
}

/**
 * The artifact the user confirms and the fingerprint is taken over: every byte
 * that decides what gets typed into the form, and nothing that does not
 * (timestamps, ids of rows that only carry the same values).
 */
export interface SiteSubmissionPayload {
  applicationId: string;
  url: string;
  /** Hostname only — what the user retypes and what the sandbox allow-list names. */
  host: string;
  requisitionKey: string;
  parserVersion: string;
  /** sha256 of the canonical JSON of the parsed fields: a re-parse that moved is a new payload. */
  formHash: string;
  answers: Array<{ fieldId: string; value: string; source: AnswerSource }>;
  attachments: Array<{ fieldId: string; filename: string; sha256: string }>;
}

export type PrepareOutcome =
  | {
      status: "ready";
      attemptId: string;
      snapshotId: string;
      form: CanonicalForm;
      answers: PlannedAnswer[];
      /** Field ids the user must settle before this can be previewed. */
      blocking: string[];
    }
  | { status: "blocked"; kind: BlockerKind; detail: string }
  | { status: "duplicate"; existingApplicationId: string }
  | { status: "failed"; reason: string };

export type SitePreviewOutcome =
  | {
      status: "ok";
      attemptId: string;
      fingerprint: string;
      payload: SiteSubmissionPayload;
      expiresAt: string;
      /** Shown to the user once and never persisted — only its hash is stored. */
      token: string;
    }
  | { status: "blocked"; reason: string };

export type SiteConfirmOutcome =
  | {
      status: "submitted";
      confirmationId: string | null;
      finalUrl: string;
      /** Absolute path of the stored confirmation-page screenshot — the evidence, not yet a servable link (P6). */
      screenshotPath: string | null;
    }
  /** `code` is the `GateDecision` code when a gate denied, or one of the load/begin codes below. */
  | { status: "blocked"; code: string; reason: string }
  | { status: "failed"; reason: string }
  | { status: "needs_reconcile"; reason: string };

export interface PrepareArgs {
  workspaceId: string;
  applicationId: string;
  url: string;
  /** The user has seen the duplicate warning and wants to apply anyway. */
  overrideDuplicate?: boolean;
}

export interface SiteAttemptArgs {
  workspaceId: string;
  attemptId: string;
}

export interface ConfirmSiteArgs extends SiteAttemptArgs {
  presentedToken: string;
  retypedTarget: string;
}

/** Statuses a site attempt may still be previewed from (mirrors the email channel). */
const PREVIEWABLE = new Set(["DRAFT", "READY", "PENDING_CONFIRMATION"]);

/** The kinds a model may draft into: anything else is a control, not prose. */
const FREE_TEXT_KINDS = new Set<CanonicalFormField["kind"]>(["text", "textarea"]);

/** Marks an AI-drafted answer everywhere it is rendered (spec §7.2: provenance is visible). */
const AI_DRAFT_NOTE = "AI draft grounded in your fact bank — read it before submitting";

/** Matches `GenerateInput.job.descriptionSnippet`'s documented ceiling. */
const MAX_DESCRIPTION_SNIPPET = 800;

/** How much of the confirmation page is kept as evidence on the receipt. */
const MAX_PAGE_TEXT_EXCERPT = 500;

/**
 * What each blocker means for the user, in their words. `detectBlockers` reports
 * what matched; this says what to do about it. Every one of these is a PAUSE —
 * the page needs a human, not that the application is impossible. `login_required`
 * in particular fires on account-creation steps, which a human clears in seconds.
 */
const BLOCKER_GUIDANCE: Record<BlockerKind, string> = {
  captcha: "This page runs a CAPTCHA, which CareerHQ will not attempt — finish this one in your browser and mark it submitted here.",
  login_required: "This page wants you signed in (or asks you to create an account) before it will show the form — do that in your browser, then re-run auto-apply on the form page itself.",
  identity_verification: "This page asks for identity or government-ID verification — only you can complete that, in your browser.",
  assessment: "This application includes a coding assessment or timed test — start it in your browser when you have the time for it.",
  unsupported_file_control: "This page's upload control only accepts file types CareerHQ cannot attach — upload your CV in your browser.",
  legal_attestation: "This page asks for a typed signature or a signature date, which CareerHQ cannot fill — complete this one in your browser.",
  parse_failure: "CareerHQ could not read a fillable application form on this page — check the link points at the form itself, or apply in your browser.",
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `DriverError.kind`s (apps/worker/src/autoapply/driver.ts) that are provably
 * raised BEFORE the one submit click:
 *   - "navigation" — the page never opened, never extracted, or Chromium never
 *     launched at all (`openSession` reports every launch failure as this
 *     kind, timeouts included — a launch has no click to be ambiguous about).
 *   - "fill" — a field action failed, or the driver refused to start filling at
 *     all; no button has been touched. This holds even when the underlying
 *     cause was a Playwright timeout: filling is an interaction with a form
 *     CONTROL (typing, ticking, unticking), and none of that can submit a form,
 *     so `driverErrorKind` deliberately does NOT collapse the fill phase onto
 *     "timeout" the way it collapses the others.
 *
 *     The refusal case is the live-page re-verification (P6 task 6): the
 *     answers below were planned against the page as it was when the user
 *     reviewed it, and the driver re-extracts the page and checks that every
 *     control it is about to touch still asks the same question
 *     (`fieldIdentityHash`) before it types anything. A consent tick's whole
 *     meaning is the statement beside it, so a page edited between review and
 *     confirm must not receive an answer planned for a different question.
 *     Reported as "fill" because it is strictly stronger than one: nothing on
 *     the page was touched at all, so the attempt is FAILED and retryable —
 *     re-run auto-apply, review the question as it now reads, submit again —
 *     never parked NEEDS_RECONCILE for a submission that provably never
 *     happened.
 * Everything else stays ambiguous on purpose. "submit" is the click itself;
 * "advance" is the between-steps click, which was dispatched before its error
 * surfaced and may have been the real submit on an ATS whose next-labelled
 * button the step heuristics misplaced; "timeout" is what a CLICK-phase
 * timeout collapses to, and a click that timed out may still have landed —
 * which is exactly why it must not be widened into this set.
 */
const PRE_CLICK_DRIVER_ERROR_KINDS: ReadonlySet<string> = new Set(["navigation", "fill"]);

/**
 * Recognises a `DriverError` structurally — `name` plus a string `kind` — rather
 * than by `instanceof`. The class lives behind `@careerhq/worker/autoapply`,
 * whose module graph pulls in `playwright`; this orchestrator is deliberately
 * browser-free and takes its driver by injection, so importing the class here
 * to narrow an error would invert that. `driver.test.ts` pins the same two
 * properties from the driver's side so a rename cannot pass unnoticed, and the
 * fallback direction is the safe one: an unrecognised throw is treated as
 * post-click ambiguity, never as a clean pre-click failure.
 */
function isPreClickDriverFailure(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== "DriverError") return false;
  const kind: unknown = (err as Error & { kind?: unknown }).kind;
  return typeof kind === "string" && PRE_CLICK_DRIVER_ERROR_KINDS.has(kind);
}

/**
 * `BrowserBusyError` from apps/worker/src/autoapply/browser-limit.ts — the
 * global one-Chromium-at-a-time cap (spec P6 §3) refusing rather than queueing.
 *
 * Recognised by `name`, for the same reason and by the same convention as
 * `isPreClickDriverFailure`: this orchestrator takes its driver by injection
 * and never imports the browser module's graph.
 *
 * It is categorically different from every `DriverError`: no browser was
 * started, so there is not merely no click — there is no page, no navigation
 * and no process. Both places that classify it below lean on exactly that.
 */
function isBrowserBusyFailure(err: unknown): boolean {
  return err instanceof Error && err.name === "BrowserBusyError";
}

/**
 * What a visitor sees when the box's only browser is already in use and NOTHING
 * has been spent yet. Their fault: no. Their move: wait — and "try again in a
 * moment" is true here precisely because this refusal happens before
 * `beginSubmission`: the attempt is still PENDING_CONFIRMATION and the same
 * token still works.
 */
const BROWSER_BUSY_REASON = "the auto-apply browser is busy with another application — try again in a moment";

/**
 * The same refusal AFTER the token is burned — where "try again in a moment" is
 * a lie, and was one (P6 task-5 review, BLOCKING 1): the attempt is terminal
 * FAILED, its token reads `token_consumed`, and `previewSiteSubmission` refuses
 * a FAILED attempt, so there is no "again" to try. The real recovery is a fresh
 * auto-apply run from the job URL — a new capture, a new plan, a new token — so
 * that is what this says.
 *
 * The reservation in `./site-driver.ts` means the interactive path can no
 * longer get here (the slot is held across `beginSubmission`), but a caller
 * that wires `submit` without `probeDriver` still can, and a message that is
 * only true by wiring is not true.
 */
const BROWSER_BUSY_ABANDONED_REASON =
  "the auto-apply browser was busy, so nothing was submitted — this attempt is closed and its "
  + "confirmation is spent; start auto-apply again from the job URL to try once more";

/**
 * A stable, human-readable attachment name derived from the variant label. It
 * is part of the fingerprinted payload, so it must be a pure function of stored
 * data — never a timestamp or a random id. (Same rule, same code shape, as the
 * email channel's attachment naming.)
 */
function attachmentFilename(label: string, filePath: string): string {
  const extension = path.extname(filePath) || ".pdf";
  const base = label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "");
  return `${base || "cv"}${extension}`;
}

/**
 * Fact-bank claims are written as "Label: value" (see the seed), so identity and
 * contact facts can be read back as deterministic form values. The label table
 * is deliberately narrow: anything it does not recognise stays a fact for the
 * generator to cite, never an auto-filled form value.
 */
const PROFILE_LABEL_HINTS: Array<{ pattern: RegExp; key: keyof ProfileValues }> = [
  { pattern: /^full (legal )?name$|^name$/, key: "full_name" },
  { pattern: /^(first|given|preferred) name$/, key: "first_name" },
  { pattern: /^(last|family) name$|^surname$/, key: "last_name" },
  { pattern: /^e-?mail( address)?$/, key: "email" },
  { pattern: /^(mobile |cell |telephone )?phone( number)?$/, key: "phone" },
  { pattern: /^(location|city|based in)$/, key: "location" },
  { pattern: /^linkedin( url| profile)?$/, key: "linkedin_url" },
  { pattern: /^github( url| profile)?$/, key: "github_url" },
  { pattern: /^(portfolio|website|personal site)( url)?$/, key: "portfolio_url" },
  { pattern: /^(current )?(company|employer)$/, key: "current_company" },
  { pattern: /^(current )?(title|role|job title)$/, key: "current_title" },
];

/**
 * Deterministic profile values from the fact bank. Sensitive and stale facts are
 * excluded outright: a sensitive fact is the user's to type, and a fact past its
 * review date is not something to put in front of an employer unreviewed. The
 * first matching fact wins, so the oldest verified claim is the stable answer.
 */
export function profileFromFacts(facts: CandidateFact[], now = new Date()): ProfileValues {
  const profile: ProfileValues = {};

  for (const fact of facts) {
    if (fact.sensitivity === "sensitive" || isFactStale(fact, now)) continue;
    const separator = fact.claim.indexOf(":");
    if (separator === -1) continue;
    const label = fact.claim.slice(0, separator).trim().toLowerCase();
    const value = fact.claim.slice(separator + 1).trim();
    if (!value) continue;

    const hint = PROFILE_LABEL_HINTS.find((entry) => entry.pattern.test(label));
    if (!hint || profile[hint.key] !== undefined) continue;
    profile[hint.key] = value;
  }

  // Forms ask for the split far more often than the whole, and "Alex Rivera"
  // already IS the answer to both — deriving it here beats leaving two required
  // fields for the user to retype from a fact they already verified.
  const fullName = profile.full_name;
  if (fullName && (!profile.first_name || !profile.last_name)) {
    const cut = fullName.lastIndexOf(" ");
    if (cut > 0) {
      profile.first_name ??= fullName.slice(0, cut).trim();
      profile.last_name ??= fullName.slice(cut + 1).trim();
    }
  }

  return profile;
}

/** The CV that will be attached: the application's own choice, else the workspace's ATS variant. */
async function resolveCvVariant(
  db: Db,
  workspaceId: string,
  chosenId: string | null,
): Promise<CvVariant | null> {
  if (chosenId) {
    const [chosen] = await db.select().from(cvVariantsTable).where(and(
      eq(cvVariantsTable.id, chosenId),
      eq(cvVariantsTable.workspaceId, workspaceId),
    ));
    if (chosen) return chosen;
  }
  const variants = await listCvVariants(db, workspaceId);
  return variants.find((variant) => variant.format === "ats") ?? variants[0] ?? null;
}

interface JobContext {
  title: string;
  companyName: string;
  descriptionSnippet: string;
  description: string | null;
}

/** Everything `planAnswers` needs, loaded once per prepare. */
async function loadPlanInputs(deps: SiteDeps, args: {
  workspaceId: string; applicationId: string; form: CanonicalForm; cvVariantId: string | null;
}): Promise<{ inputs: PlanInputs; facts: FactForSelection[] }> {
  const { db } = deps;
  const now = new Date();

  const facts = await listFacts(db, args.workspaceId);
  const reusable = await listReusableAnswers(db, args.workspaceId);
  const savedAnswers: SavedAnswerLike[] = reusable.map((answer) => ({
    questionNorm: answer.questionNorm,
    answer: answer.answer,
    sourceFactIds: answer.sourceFactIds,
    staleForReuse: answer.staleForReuse,
  }));

  const approved = await listAnswers(db, args.applicationId);
  const previouslyApproved: Record<string, string> = {};
  for (const answer of approved) {
    if (answer.approval !== "approved") continue;
    previouslyApproved[answer.questionNorm] ??= answer.answer;
  }

  const variant = await resolveCvVariant(db, args.workspaceId, args.cvVariantId);

  return {
    inputs: {
      form: args.form,
      profile: profileFromFacts(facts, now),
      savedAnswers,
      resumeDocumentId: variant?.id ?? null,
      previouslyApproved,
    },
    facts: facts.map((fact) => ({
      id: fact.id,
      category: fact.category,
      claim: fact.claim,
      detail: fact.detail,
      sensitivity: fact.sensitivity,
      stale: isFactStale(fact, now),
    })),
  };
}

/**
 * The AI pass over what the deterministic planner could not settle.
 *
 * Two hard rules, both enforced here rather than trusted from upstream:
 *   1. Only the planner's `unresolved` list is eligible, and only its free-text
 *      members. Sensitive and consent-only fields never appear in `unresolved`
 *      by construction — `isSensitiveField` and `isConsentOnlyField` are both
 *      re-checked anyway — and hidden inputs, checkboxes and selects are
 *      controls, not prose, so no model is asked about them.
 *   2. An interpretation may only ever ADD a block: a model that maps a field
 *      onto a sensitive category makes that field the user's, and never a
 *      candidate for drafting.
 */
async function refineWithAi(deps: SiteDeps, ctx: {
  form: CanonicalForm;
  inputs: PlanInputs;
  unresolved: string[];
  answers: PlannedAnswer[];
  facts: FactForSelection[];
  job: JobContext;
  apiKey: string;
}): Promise<{ form: CanonicalForm; answers: PlannedAnswer[] }> {
  const { config } = deps;
  const interpret = deps.interpret ?? interpretField;
  const generate = deps.generate ?? generateGrounded;

  // Both refusals are checked independently, because neither ruleset contains
  // the other: "Please describe any convictions" is consent-only by label but
  // matches no SENSITIVE_TERM (`\bconvicted\b` does not match "convictions"),
  // and plenty of sensitive questions are not consent-only. A model may never
  // be the source of a consent answer, whatever the planner decided upstream.
  const draftable = (field: CanonicalFormField | undefined): field is CanonicalFormField =>
    field !== undefined
    && FREE_TEXT_KINDS.has(field.kind)
    && !isSensitiveField(field)
    && !isConsentOnlyField(field);

  const fieldsById = new Map(ctx.form.fields.map((field) => [field.id, field]));

  // (1) Interpretation: only fields the parser could not map at all.
  const mapped = new Map<string, CanonicalFormField>();
  for (const fieldId of ctx.unresolved) {
    const field = fieldsById.get(fieldId);
    if (!draftable(field) || field.canonicalField !== "unknown") continue;

    const result = await interpret({
      label: field.label,
      nearbyText: field.helpText,
      kind: field.kind,
      options: field.options,
      jobTitle: ctx.job.title,
      companyName: ctx.job.companyName,
    }, { models: config.aiFastModels, apiKey: ctx.apiKey });
    if (!result.ok || !result.value) continue;

    const { canonicalField, confidence } = result.value;
    if (canonicalField === "unknown") continue;
    if (SENSITIVE_CANONICAL_FIELDS.has(canonicalField)) {
      // Rule 2: the block is the only thing this ruling may buy.
      mapped.set(field.id, { ...field, canonicalField, mappingConfidence: confidence, sensitive: true });
      continue;
    }
    if (confidence < MIN_FILL_CONFIDENCE) continue;
    mapped.set(field.id, { ...field, canonicalField, mappingConfidence: confidence });
  }

  const form: CanonicalForm = mapped.size === 0
    ? ctx.form
    : { ...ctx.form, fields: ctx.form.fields.map((field) => mapped.get(field.id) ?? field) };
  // Re-plan rather than patch: a newly mapped field may now be answerable from
  // the profile or a saved answer, and that path is the planner's, not this one's.
  const replanned = mapped.size === 0
    ? { answers: ctx.answers, unresolved: ctx.unresolved }
    : planAnswers({ ...ctx.inputs, form });

  // (2) Drafting: screening questions only — the one place a grounded model has
  // something useful to say. Everything else stays the user's.
  const answers = [...replanned.answers];
  const refreshedById = new Map(form.fields.map((field) => [field.id, field]));
  for (const fieldId of replanned.unresolved) {
    const field = refreshedById.get(fieldId);
    if (!draftable(field) || field.canonicalField !== "screening_question") continue;

    const selected = selectFactsForGeneration(ctx.facts, {
      question: field.label,
      jobTitle: ctx.job.title,
      jobDescription: ctx.job.description,
    });
    // No facts means nothing to ground an answer in; the generator would refuse
    // anyway, and the field stays the user's.
    if (selected.length === 0) continue;

    const input: GenerateInput = {
      kind: "question",
      question: field.label,
      job: {
        title: ctx.job.title,
        companyName: ctx.job.companyName,
        descriptionSnippet: ctx.job.descriptionSnippet,
      },
      facts: selected.map((fact) => ({ id: fact.id, claim: fact.claim, detail: fact.detail })),
    };
    const result = await generate(input, { models: config.aiWritingModels, apiKey: ctx.apiKey });
    if (!result.ok || !result.value) continue;
    // P3's grounding validation, unchanged: an answer citing facts it was not
    // given, citing none at all, admitting unsupported claims, asking for
    // clarification or arriving under-confident is not usable. A rejected draft
    // leaves the field exactly as the planner left it — needing the user.
    if (!validateGeneration(result.value, selected.map((fact) => fact.id)).ok) continue;

    const index = answers.findIndex((answer) => answer.fieldId === fieldId);
    if (index === -1) continue;
    answers[index] = {
      ...answers[index]!,
      value: result.value.answer,
      source: "ai",
      sourceFactIds: result.value.factIds,
      confidence: result.value.confidence,
      needsUser: false,
      note: AI_DRAFT_NOTE,
    };
  }

  return { form, answers };
}

/**
 * Step 1 of the auto-apply flow (spec §10): read the page, refuse to touch it if
 * it needs a human, parse it, check we are not applying twice, and plan every
 * answer. Nothing is typed into anything here — the whole point is to produce a
 * reviewable plan.
 */
export async function prepareSiteApplication(
  deps: SiteDeps,
  args: PrepareArgs,
): Promise<PrepareOutcome> {
  const { db } = deps;

  // Workspace scoping runs through the application, the only row that carries a
  // workspace id: an application id from another workspace must never resolve.
  const detail = await getApplicationDetail(db, args.applicationId);
  if (!detail || detail.application.workspaceId !== args.workspaceId) {
    return { status: "failed", reason: "this application no longer exists" };
  }

  const capture = deps.capture;
  if (!capture) {
    return { status: "failed", reason: "the auto-apply browser is not available in this process" };
  }

  // Reading a page is not a mutation, but it IS a navigation the server
  // performs on a caller's behalf, so the target is gated here and not only at
  // confirm time (P6 task-2 review, BLOCKING 2): protocol, internal-network
  // ranges, and — when the effective workspace kind is sandbox — the one
  // configured host. `effectiveWorkspaceKind` is the same derivation
  // `confirmAndSubmitSite` uses below, so the two layers cannot disagree about
  // which workspace this is. The confirm-time gate is unchanged and still the
  // authority at submit time; this is an additional, earlier layer.
  const [workspace] = await db.select().from(workspacesTable)
    .where(eq(workspacesTable.id, args.workspaceId));
  if (!workspace) {
    return { status: "failed", reason: "this workspace no longer exists" };
  }
  const policy: CaptureTargetPolicy = {
    workspaceKind: effectiveWorkspaceKind(deps.config, workspace.kind),
    sandboxSiteAllowedHost: deps.config.sandboxSiteAllowedHost,
  };
  const refusal = refuseCaptureTarget(args.url, policy);
  if (refusal) return { status: "failed", reason: refusal };

  let page: RawFormPage;
  try {
    // The policy goes WITH the URL, not just ahead of it. `page.goto` follows
    // redirects, so checking only `args.url` left a 302 from an allow-listed
    // host to `127.0.0.1` captured and returned (P6 fix-wave review,
    // BLOCKING). The driver now re-asks this same policy at every hop.
    page = await capture(args.url, policy);
  } catch (err) {
    return { status: "failed", reason: `the application page could not be read: ${errorMessage(err)}` };
  }

  const pause = async (kind: BlockerKind, matched: string): Promise<PrepareOutcome> => {
    const guidance = BLOCKER_GUIDANCE[kind];
    const detailText = matched ? `${guidance} (detected: ${matched})` : guidance;
    // The attempt exists so the pause is visible in the application's history
    // and so a human can see what stopped it — it is BLOCKED, never FAILED:
    // nothing was submitted and the page may well be fine for a human.
    const attempt = await createSiteAttempt(db, { applicationId: args.applicationId, url: args.url });
    await markAttemptBlocked(db, attempt.id, `${kind}: ${detailText}`);
    return { status: "blocked", kind, detail: detailText };
  };

  const blockers = detectBlockers(page);
  const blocker = blockers[0];
  if (blocker) return pause(blocker.kind, blocker.detail);

  let form: CanonicalForm;
  try {
    form = parseForm(page);
  } catch (err) {
    return pause("parse_failure", errorMessage(err));
  }
  if (form.fields.length === 0) return pause("parse_failure", `no fields found at ${args.url}`);

  // Duplicate detection happens BEFORE anything is created: a refused prepare
  // must leave no attempt behind for the user to wonder about.
  const existing = await findRequisitionAttempt(db, args.workspaceId, form.requisitionKey);
  if (existing && !args.overrideDuplicate) {
    return { status: "duplicate", existingApplicationId: existing.applicationId };
  }

  const attempt = await createSiteAttempt(db, { applicationId: args.applicationId, url: args.url });
  if (existing) {
    // An override is a deliberate human decision to apply to the same
    // requisition twice; it belongs in the audit trail, not just in a log line.
    await db.insert(applicationEventsTable).values({
      applicationId: args.applicationId,
      fromState: detail.application.state,
      toState: detail.application.state,
      trigger: "user",
      payload: {
        duplicateOverride: true,
        requisitionKey: form.requisitionKey,
        previousApplicationId: existing.applicationId,
      },
    });
  }

  const { inputs, facts } = await loadPlanInputs(deps, {
    workspaceId: args.workspaceId,
    applicationId: args.applicationId,
    form,
    cvVariantId: detail.application.cvVariantId,
  });
  const plan = planAnswers(inputs);

  const description = detail.job?.descriptionMd ?? null;
  const job: JobContext = {
    title: detail.job?.title || form.title || "this role",
    companyName: form.companyName || "the company",
    descriptionSnippet: stripHtml(description ?? "").slice(0, MAX_DESCRIPTION_SNIPPET),
    description,
  };

  // No key means no AI at all — the deterministic floor. The plan above is
  // already complete and reviewable without it, which is also why an AI pass
  // that blows up (a network fault, a provider outage) degrades to that plan
  // instead of failing the whole prepare.
  const apiKey = deps.config.openrouterApiKey;
  let refined = { form, answers: plan.answers };
  if (apiKey !== null) {
    try {
      refined = await refineWithAi(deps, {
        form, inputs, unresolved: plan.unresolved, answers: plan.answers, facts, job, apiKey,
      });
    } catch (err) {
      console.error(`[site-submission] AI refinement failed, keeping the deterministic plan: ${errorMessage(err)}`);
    }
  }

  const snapshot = await saveFormSnapshot(db, {
    attemptId: attempt.id, form: refined.form, answers: refined.answers,
  });

  const blocking = requiresUserBeforeSubmit(refined.answers, refined.form);
  if (blocking.length === 0) await markAttemptReady(db, attempt.id);

  return {
    status: "ready",
    attemptId: attempt.id,
    snapshotId: snapshot.id,
    form: refined.form,
    answers: refined.answers,
    blocking,
  };
}

const plannedAnswersSchema = z.array(plannedAnswerSchema);

/** Loads a snapshot with its attempt and application, scoped to the workspace. */
async function loadSnapshotContext(db: Db, workspaceId: string, snapshotId: string): Promise<{
  snapshot: FormSnapshot; attempt: ApplicationAttempt; applicationState: ApplicationState;
} | null> {
  const [snapshot] = await db.select().from(formSnapshotsTable)
    .where(eq(formSnapshotsTable.id, snapshotId));
  if (!snapshot) return null;

  const attempt = await getAttempt(db, snapshot.attemptId);
  if (!attempt) return null;
  const detail = await getApplicationDetail(db, attempt.applicationId);
  if (!detail || detail.application.workspaceId !== workspaceId) return null;

  return { snapshot, attempt, applicationState: detail.application.state };
}

/**
 * The user's own answer, from the review screen. It is theirs now: source
 * "user", full confidence, and no longer waiting on anybody — including when
 * they deliberately leave an optional field empty, which is how a field the
 * planner could not settle stops blocking the submission.
 */
export async function updatePlannedAnswer(deps: SiteDeps, args: {
  workspaceId: string; snapshotId: string; fieldId: string; value: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const context = await loadSnapshotContext(deps.db, args.workspaceId, args.snapshotId);
  if (!context) return { ok: false, reason: "this form snapshot no longer exists" };
  if (!PREVIEWABLE.has(context.attempt.status)) {
    return { ok: false, reason: `this attempt can no longer be edited (status ${context.attempt.status})` };
  }

  const form = canonicalFormSchema.safeParse(context.snapshot.canonicalForm);
  const answers = plannedAnswersSchema.safeParse(context.snapshot.plannedAnswers);
  if (!form.success || !answers.success) {
    return { ok: false, reason: "this form snapshot is unreadable — re-run auto-apply on the job page" };
  }

  const field = form.data.fields.find((candidate) => candidate.id === args.fieldId);
  if (!field) return { ok: false, reason: "that field is not part of this form" };
  // A file field's value is a document id resolved from the workspace's CV
  // variants; a typed path here would be either meaningless or an attempt to
  // read a file the workspace does not own.
  if (field.kind === "file") {
    return { ok: false, reason: "file fields are set by choosing a CV variant, not by typing a value" };
  }

  const updated: PlannedAnswer = {
    fieldId: args.fieldId,
    value: args.value,
    source: "user",
    sourceFactIds: [],
    confidence: 1,
    needsUser: false,
    differsFromApproved: false,
    note: "",
  };
  const next = answers.data.some((answer) => answer.fieldId === args.fieldId)
    ? answers.data.map((answer) => (answer.fieldId === args.fieldId ? updated : answer))
    : [...answers.data, updated];

  // The attempt's pinned fingerprint is deliberately left alone: `confirmAndSubmitSite`
  // recomputes the fingerprint from this snapshot, so an edit after a preview
  // comes out as `fingerprint_mismatch` and the user simply previews again.
  const saved = await updateSnapshotAnswers(deps.db, args.snapshotId, next);
  if (!saved) return { ok: false, reason: "this form snapshot no longer exists" };
  return { ok: true };
}

/**
 * Everything both halves of the gated flow need, loaded and re-validated from
 * stored state: the attempt, the snapshot's form and answers, the files that
 * will actually be uploaded, and the payload/fingerprint computed from them.
 * Shared by preview and confirm so the fingerprint the user confirms and the
 * one checked at submit time can never be computed differently.
 */
interface LoadedSiteSubmission {
  attempt: ApplicationAttempt;
  applicationId: string;
  applicationState: ApplicationState;
  snapshot: FormSnapshot;
  form: CanonicalForm;
  answers: PlannedAnswer[];
  /** fieldId → absolute path handed to the driver. */
  files: Record<string, string>;
  payload: SiteSubmissionPayload;
  fingerprint: string;
}

type LoadResult =
  | { ok: true; value: LoadedSiteSubmission }
  | { ok: false; code: string; reason: string };

function fail(code: string, reason: string): { ok: false; code: string; reason: string } {
  return { ok: false, code, reason };
}

async function loadSiteSubmission(deps: SiteDeps, args: SiteAttemptArgs): Promise<LoadResult> {
  const { db } = deps;

  const attempt = await getAttempt(db, args.attemptId);
  if (!attempt) return fail("attempt_not_found", "this submission attempt no longer exists");

  const detail = await getApplicationDetail(db, attempt.applicationId);
  if (!detail || detail.application.workspaceId !== args.workspaceId) {
    return fail("attempt_not_found", "this submission attempt no longer exists");
  }
  if (attempt.channel !== "company_site") {
    return fail("draft_unavailable", `this attempt is not a company-site attempt (channel ${attempt.channel})`);
  }

  const snapshot = await getLatestSnapshot(db, attempt.id);
  if (!snapshot) {
    return fail("form_unavailable", "this attempt has not captured an application form yet");
  }
  const form = canonicalFormSchema.safeParse(snapshot.canonicalForm);
  const answers = plannedAnswersSchema.safeParse(snapshot.plannedAnswers);
  if (!form.success || !answers.success) {
    return fail("form_unavailable", "this form snapshot is unreadable — re-run auto-apply on the job page");
  }

  const answerByFieldId = new Map(answers.data.map((answer) => [answer.fieldId, answer]));
  const attachments: SiteSubmissionPayload["attachments"] = [];
  const files: Record<string, string> = {};
  for (const field of form.data.fields) {
    if (field.kind !== "file") continue;
    const documentId = answerByFieldId.get(field.id)?.value.trim();
    if (!documentId) continue;

    const [variant] = await db.select().from(cvVariantsTable).where(and(
      eq(cvVariantsTable.id, documentId),
      eq(cvVariantsTable.workspaceId, args.workspaceId),
    ));
    if (!variant) {
      return fail("cv_unavailable", `the document chosen for "${field.label}" no longer exists`);
    }

    let content: Buffer;
    try {
      content = await readFile(variant.filePath);
    } catch {
      return fail("cv_unavailable", `the file for "${variant.label}" is missing from storage`);
    }
    // The recorded digest is what the user reviewed the variant as. A file that
    // changed underneath it is not the CV they approved.
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (sha256 !== variant.sha256) {
      return fail("cv_unavailable", `the file for "${variant.label}" no longer matches its recorded checksum`);
    }

    attachments.push({
      fieldId: field.id,
      filename: attachmentFilename(variant.label, variant.filePath),
      sha256,
    });
    files[field.id] = variant.filePath;
  }

  const payload: SiteSubmissionPayload = {
    applicationId: attempt.applicationId,
    url: form.data.url,
    // Hostname, not host: the port is not a safety boundary, and "demo-ats" is
    // what the user is asked to retype and what the sandbox allow-list names.
    host: new URL(form.data.url).hostname,
    requisitionKey: form.data.requisitionKey,
    parserVersion: form.data.parserVersion,
    formHash: payloadFingerprint(form.data.fields),
    answers: answers.data.map((answer) => ({
      fieldId: answer.fieldId, value: answer.value, source: answer.source,
    })),
    attachments,
  };

  return {
    ok: true,
    value: {
      attempt,
      applicationId: attempt.applicationId,
      applicationState: detail.application.state,
      snapshot,
      form: form.data,
      answers: answers.data,
      files,
      payload,
      fingerprint: payloadFingerprint(payload),
    },
  };
}

/** Labels for the fields still waiting on the user, for a reason a human can act on. */
function blockingLabels(blocking: string[], form: CanonicalForm): string[] {
  const labelByFieldId = new Map(form.fields.map((field) => [field.id, field.label]));
  return blocking.map((fieldId) => labelByFieldId.get(fieldId) || fieldId);
}

/**
 * Step 2 of the gated flow (spec §11): render exactly what would be typed, pin
 * its fingerprint to the attempt, and mint a single-use confirmation token. The
 * plaintext token is returned once, for the confirm dialog; only its hash
 * reaches the database.
 *
 * The review gate is absolute: while `requiresUserBeforeSubmit` reports
 * anything — a required field left empty, an answer flagged for the user,
 * optional fields included — there is no preview to confirm.
 */
export async function previewSiteSubmission(
  deps: SiteDeps,
  args: SiteAttemptArgs,
): Promise<SitePreviewOutcome> {
  const loaded = await loadSiteSubmission(deps, args);
  if (!loaded.ok) return { status: "blocked", reason: loaded.reason };
  const { attempt, form, answers, payload, fingerprint } = loaded.value;

  if (!PREVIEWABLE.has(attempt.status)) {
    return { status: "blocked", reason: `this attempt can no longer be previewed (status ${attempt.status})` };
  }

  const blocking = requiresUserBeforeSubmit(answers, form);
  if (blocking.length > 0) {
    return {
      status: "blocked",
      reason: `these fields still need you: ${blockingLabels(blocking, form).join(", ")}`,
    };
  }

  const token = generateConfirmationToken();
  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS);
  const recorded = await recordPreview(deps.db, {
    attemptId: attempt.id,
    payloadFingerprint: fingerprint,
    target: payload.host,
    tokenHash: hashConfirmationToken(token),
    expiresAt,
  });
  if (!recorded.ok) return { status: "blocked", reason: recorded.reason };

  return {
    status: "ok",
    attemptId: attempt.id,
    fingerprint,
    payload,
    expiresAt: expiresAt.toISOString(),
    token,
  };
}

/**
 * Step 3 of the gated flow (spec §11), and the only code path in the
 * company-site channel that mutates the outside world.
 *
 * Order is load-bearing and mirrors the email channel exactly. Everything that
 * can fail harmlessly — loading, the gate matrix, the application-readiness
 * check, the review re-check, having a driver at all — happens before
 * `beginSubmission`, so a blocked confirm leaves the attempt
 * PENDING_CONFIRMATION with its token unburned and the user simply fixes the
 * problem and confirms again.
 *
 * After the click, nothing is ever reported as a plain failure: a click may
 * have landed. An exception, or a confirmation page with no confirmation id,
 * parks the attempt in NEEDS_RECONCILE for a human — recording a false
 * "submitted" or a false "failed" are both worse than asking.
 */
export async function confirmAndSubmitSite(
  deps: SiteDeps,
  args: ConfirmSiteArgs,
): Promise<SiteConfirmOutcome> {
  const { db, config } = deps;

  const loaded = await loadSiteSubmission(deps, {
    workspaceId: args.workspaceId, attemptId: args.attemptId,
  });
  if (!loaded.ok) return { status: "blocked", code: loaded.code, reason: loaded.reason };
  const {
    attempt, applicationId, applicationState, form, answers, files, payload, fingerprint,
  } = loaded.value;

  const [workspace] = await db.select().from(workspacesTable)
    .where(eq(workspacesTable.id, args.workspaceId));
  if (!workspace) {
    return { status: "blocked", code: "workspace_not_found", reason: "this workspace no longer exists" };
  }

  // The same policy object prepare used, rebuilt from the same derivation.
  const policy: CaptureTargetPolicy = {
    workspaceKind: effectiveWorkspaceKind(config, workspace.kind),
    sandboxSiteAllowedHost: config.sandboxSiteAllowedHost,
  };

  // The latest confirmation whatever its state — a consumed or expired row must
  // reach the matrix as itself, not as "no token at all".
  const confirmation = await getLatestConfirmation(db, attempt.id);
  const blocking = await hasBlockingAttempt(db, applicationId);

  const gateInput: GateCheckInput = {
    envGateOpen: config.submissionsLiveCompanySite,
    // Belt-and-braces (spec P6 §3): SANDBOX_FORCE_SAFE forces every workspace
    // through the sandbox path independently of workspace.kind — a second,
    // independent layer so a regression in workspace resolution (which
    // workspace this really is) doesn't also disable the sandbox host
    // allow-list. Deliberately not derived from/coupled to DEMO_MODE; it is
    // its own hard-safety switch. Shared with the prepare-time layer through
    // `effectiveWorkspaceKind` so the two can never derive it differently.
    workspaceKind: policy.workspaceKind,
    // Only consulted for sandbox workspaces; a sandbox may reach exactly one host.
    sandboxTargetAllowed: payload.host === config.sandboxSiteAllowedHost,
    tokenRecord: confirmation
      ? {
          tokenHash: confirmation.tokenHash,
          payloadFingerprint: confirmation.payloadFingerprint,
          expiresAt: confirmation.expiresAt,
          consumedAt: confirmation.consumedAt,
        }
      : null,
    presentedToken: args.presentedToken,
    now: new Date(),
    currentFingerprint: fingerprint,
    retypedTarget: args.retypedTarget,
    expectedTarget: payload.host,
    hasConfirmedAttempt: blocking.confirmed,
    attemptInFlight: blocking.inFlight,
  };

  const decision = evaluateSubmissionGates(gateInput);
  if (!decision.allowed) {
    return { status: "blocked", code: decision.code, reason: decision.reason };
  }
  // `allowed` implies a token record; this narrows it for the redemption below.
  if (!confirmation) {
    return { status: "blocked", code: "token_missing", reason: "no active confirmation token exists" };
  }

  // The application must still be exactly one guarded step from SUBMITTED.
  // Checked after the gate matrix (so an already-submitted application still
  // reports duplicate_submission) but before anything that burns the token or
  // touches the network, so the fix and the retry both just work — the P4
  // final-review lesson, unchanged.
  const readiness = canTransition(applicationState, "SUBMITTED", "attempt", { hasConfirmedAttempt: true });
  if (!readiness.ok) {
    return { status: "blocked", code: "application_not_ready", reason: readiness.reason };
  }

  // Belt and braces with the preview's own refusal: the fingerprint covers
  // values and sources, so a re-plan that only re-raised `needsUser` would slip
  // past it. Review-first is absolute.
  const stillBlocking = requiresUserBeforeSubmit(answers, form);
  if (stillBlocking.length > 0) {
    return {
      status: "blocked",
      code: "review_required",
      reason: `these fields still need you: ${blockingLabels(stillBlocking, form).join(", ")}`,
    };
  }

  // `payload.url` is `form.url`, which is where the CAPTURE landed — so before
  // the redirect fix it could itself be a redirect target, and this is the
  // check that makes "form.url is never off-policy" true at submit time rather
  // than merely likely. It is the full policy, not just `sandboxTargetAllowed`
  // above: a personal workspace has no host check in the gate matrix at all,
  // so without this one `confirmAndSubmitSite` would type the user's CV and
  // answers into an internal host and upload the files there.
  //
  // Placed here for the reason everything else in this run-up is placed here:
  // it is BEFORE `beginSubmission`, so a refusal leaves the attempt
  // PENDING_CONFIRMATION with its token unburned and the user simply retries.
  const targetRefusal = refuseCaptureTarget(payload.url, policy);
  if (targetRefusal) {
    return { status: "blocked", code: "target_refused", reason: targetRefusal };
  }

  // The last thing that can fail harmlessly: no driver, no submission — and the
  // attempt is still PENDING_CONFIRMATION when we say so.
  const submit = deps.submit;
  if (!submit) {
    return {
      status: "blocked",
      code: "driver_unavailable",
      reason: "the auto-apply browser is not available in this process",
    };
  }
  // Room on disk for the one thing this submission is guaranteed to produce:
  // the confirmation screenshot `submit` writes under `FILE_STORAGE_DIR`
  // (`site-driver.ts`'s `runSiteSubmit`, and the worker's queue variant into
  // its own directory — one store, two writers).
  //
  // It is HERE, and not at the write, because the write happens AFTER the
  // submit click: by then the application is in, and refusing would either
  // lose a real submission or leave an attempt whose receipt names evidence
  // that was never stored. Before the token, before the browser, before
  // anything is typed — the attempt stays PENDING_CONFIRMATION with its token
  // intact, and the same `blocked` shape every other harmless failure uses
  // carries the reason.
  //
  // Demo-only, and inert otherwise: a self-hosted install's screenshots are
  // the records of real applications it made, and nothing quotas or reclaims
  // those. The database read that feeds the collector is only paid for when
  // the collector will actually run.
  const evidenceRefusal = await reserveEvidenceScreenshot({
    fileStorageDir: config.fileStorageDir,
    referencedPaths: config.demoMode ? await listEvidenceScreenshotPaths(db) : [],
    demoMode: config.demoMode,
  });
  if (evidenceRefusal) {
    return { status: "blocked", code: "evidence_store_full", reason: evidenceRefusal };
  }

  // A wired-up `submit` is not the same as a browser that can start. The probe
  // is a real launch/close round trip, and it runs HERE — before the token is
  // burned and before anything is typed — so an image or host without Chromium
  // refuses honestly and stays retryable, instead of throwing inside `submit`
  // and parking the attempt for a human to reconcile a click that never
  // happened.
  //
  // The probe also answers "is there ROOM for a browser?", because the slot is
  // taken before the launch (spec P6 §3's global cap): a busy process refuses
  // HERE, with the token still unburned, so a second demo visitor waits a
  // moment instead of losing their confirmation to someone else's submission.
  if (deps.probeDriver) {
    try {
      await deps.probeDriver();
    } catch (err) {
      // Busy is not broken, and saying "could not be started" for a browser
      // that is working perfectly well would send the visitor looking for a
      // problem that does not exist.
      if (isBrowserBusyFailure(err)) {
        return { status: "blocked", code: "driver_unavailable", reason: BROWSER_BUSY_REASON };
      }
      return {
        status: "blocked",
        code: "driver_unavailable",
        reason: `the auto-apply browser could not be started: ${redactError(err, [])}`,
      };
    }
  }

  // The write that happens BEFORE the mutation: token burned, attempt
  // SUBMITTING, pending receipt recording exactly what is about to be typed. If
  // the process dies past this line the attempt is left SUBMITTING with the
  // evidence a human needs.
  const begun = await beginSubmission(db, {
    attemptId: attempt.id,
    confirmationId: confirmation.id,
    pendingReceipt: {
      channel: "company_site", payload, fingerprint, startedAt: new Date().toISOString(),
    },
  });
  if (!begun.ok) return { status: "blocked", code: "begin_refused", reason: begun.reason };

  let result: SiteSubmitResult;
  try {
    result = await submit({ url: payload.url, form, answers, files, policy });
  } catch (err) {
    // The driver clicks Submit inside this call, so which side of that click
    // the throw came from decides the attempt's fate (spec §11): a failure
    // BEFORE the mutation is a plain FAILED with a redacted reason; only
    // uncertainty AFTER it is worth a human's time. `DriverError.kind` already
    // knows — navigating, extracting or filling all happen before the submit
    // button is touched.
    // A busy refusal out of `submit` itself. The real confirm path cannot get
    // here any more — `siteBrowserReservation`'s probe HOLDS the slot across
    // `beginSubmission`, so the loser of a race is refused above with its token
    // intact — but a `submit` wired without a `probeDriver` still can, and a
    // browser that was never started cannot have clicked anything: a plain
    // FAILED, not a human sent to reconcile a submission that never began.
    //
    // The reason must not say "try again in a moment": the token is spent and
    // the attempt is terminal, so the only honest instruction is to start over.
    if (isBrowserBusyFailure(err)) {
      await failSubmissionSafely(deps, attempt.id, BROWSER_BUSY_ABANDONED_REASON);
      return { status: "failed", reason: BROWSER_BUSY_ABANDONED_REASON };
    }
    if (isPreClickDriverFailure(err)) {
      const reason = `the form could not be filled in, so nothing was submitted: ${redactError(err, [])}`;
      await failSubmissionSafely(deps, attempt.id, reason);
      return { status: "failed", reason };
    }
    // Anything else is unclassified and the attempt has already begun — assume
    // the worst (the application may be in) and park it for a human rather than
    // guessing.
    // Redacted like its FAILED sibling: a raw Playwright error escaping the
    // post-click evidence phase carries call logs, and strict-mode violations
    // embed element snapshots that can include values typed into the form.
    const reason = `the submission failed in an unexpected way: ${redactError(err, [])}`;
    await markNeedsReconcileSafely(deps, attempt.id, reason);
    return { status: "needs_reconcile", reason };
  }

  const pageTextExcerpt = result.pageText.slice(0, MAX_PAGE_TEXT_EXCERPT);
  if (result.confirmationId === null) {
    // The click happened and the page came back without a confirmation id.
    // That is not evidence of success (a re-rendered form with a validation
    // error looks the same from here) and it is not evidence of failure either.
    const reason = "the submit click landed but the page showed no confirmation id — "
      + `check ${result.finalUrl} and the saved screenshot, then resolve this attempt`;
    await markNeedsReconcileSafely(deps, attempt.id, reason);
    return { status: "needs_reconcile", reason };
  }

  const completed = await completeSubmission(db, {
    attemptId: attempt.id,
    confirmedReceipt: {
      channel: "company_site",
      confirmationId: result.confirmationId,
      finalUrl: result.finalUrl,
      screenshotPath: result.screenshotPath,
      pageTextExcerpt,
      acceptedAt: new Date().toISOString(),
      fingerprint,
      host: payload.host,
      url: payload.url,
      attachments: payload.attachments,
    },
  });
  if (!completed.ok) {
    // The application IS in. A refused receipt (the one-submitted-per-application
    // index, a rejected application transition) must never be reported as a
    // failure — that would lose a real submission. Park it with the evidence.
    const reason = `submitted as ${result.confirmationId} but the receipt was refused: ${completed.reason}`;
    await markNeedsReconcileSafely(deps, attempt.id, reason);
    return { status: "needs_reconcile", reason };
  }

  return {
    status: "submitted",
    confirmationId: result.confirmationId,
    finalUrl: result.finalUrl,
    screenshotPath: result.screenshotPath,
  };
}

/**
 * `markNeedsReconcile` throws on an illegal edge, which is the right behaviour
 * for the repo but the wrong one here: we are already in the post-click path,
 * and losing the reason to an exception would leave the attempt SUBMITTING with
 * no explanation at all. The reason is logged if the write itself fails.
 */
async function markNeedsReconcileSafely(deps: SiteDeps, attemptId: string, reason: string): Promise<void> {
  try {
    await markNeedsReconcile(deps.db, attemptId, reason);
  } catch (err) {
    console.error(
      `[site-submission] attempt ${attemptId} needs reconciling (${reason}) but could not be marked: `
      + errorMessage(err),
    );
  }
}

/** Same guard, same reasoning, for the pre-click FAILED outcome. */
async function failSubmissionSafely(deps: SiteDeps, attemptId: string, reason: string): Promise<void> {
  try {
    await failSubmission(deps.db, attemptId, reason);
  } catch (err) {
    console.error(
      `[site-submission] attempt ${attemptId} failed before the click (${reason}) but could not be marked: `
      + errorMessage(err),
    );
  }
}
