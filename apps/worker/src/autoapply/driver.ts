// The Playwright driver — the ONE place in CareerHQ that drives a live browser.
//
// Everything upstream (parsers, adapters, answer planning) is browser-free and
// works off `RawFormPage`; everything downstream (the site orchestrator, Task
// 11) works off the results returned here. This module's whole job is to turn
// a URL into a `RawFormPage`, and a `CanonicalForm` + `PlannedAnswer[]` back
// into keystrokes, one submit click, and the evidence of what happened.
import type { CanonicalForm, PlannedAnswer } from "@careerhq/contracts";
import { rawFieldId, type RawField, type RawFormPage } from "@careerhq/autoapply";
import { chromium, errors, type Browser, type Page } from "playwright";
import { BUTTON_STEPS_SCRIPT, deriveTotalSteps, EXTRACT_SCRIPT, type ExtractedPage } from "./extract.js";

export type DriverErrorKind = "navigation" | "timeout" | "fill" | "submit" | "advance";

/** Every failure crossing this module's boundary is one of these. */
export class DriverError extends Error {
  constructor(
    message: string,
    readonly kind: DriverErrorKind,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DriverError";
  }
}

export interface BrowserSession {
  /** A fresh page; the caller closes it. Exposed so Task 11 can fake a session. */
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

export interface DriverDeps {
  /** Budget for navigation, per-field actions and the post-submit wait. */
  timeoutMs: number;
}

export interface SubmitResult {
  /** From `[data-confirmation-id]` or "Confirmation ID: …" in the page text; null when the site shows neither. */
  confirmationId: string | null;
  finalUrl: string;
  screenshotPng: Buffer;
  pageText: string;
}

export interface FillAndSubmitArgs {
  url: string;
  form: CanonicalForm;
  answers: PlannedAnswer[];
  /** fieldId → absolute path of the file to upload (the CV/cover letter on disk). */
  files: Record<string, string>;
  deps: DriverDeps;
}

const CONFIRMATION_TEXT_RE = /Confirmation ID:\s*([A-Za-z0-9-]+)/;
const NEXT_BUTTON_ID_PREFIX = "btn_next";
const NEXT_BUTTON_TEXT_RE = /^(next|continue)\b/i;
const SUBMIT_BUTTON_ID = "btn_submit";
const SUBMIT_BUTTON_TEXT_RE = /submit|apply|send/i;
const TRUTHY_VALUES = new Set(["true", "yes", "on", "1", "checked"]);
const FALSY_VALUES = new Set(["", "false", "no", "off", "0", "unchecked"]);

/**
 * Which kind a failure in `phase` carries, given what threw.
 *
 * A Playwright timeout normally collapses onto `kind: "timeout"`: it says
 * something different about the site than "the click failed", and — the part
 * that matters — a click that timed out may still have LANDED, so apps/web has
 * to treat it as post-click ambiguity.
 *
 * `"fill"` is the exception, and deliberately so. Filling a field is an
 * interaction with a form CONTROL: typing, selecting, ticking, unticking. None
 * of that can submit the form, so there is no ambiguity to preserve, whether it
 * failed instantly or after the full timeout. Collapsing it lost that: an
 * `uncheck()` on a hidden or disabled checkbox throws a `TimeoutError`, which
 * became `"timeout"`, which apps/web excludes from
 * `PRE_CLICK_DRIVER_ERROR_KINDS` — so a field that could not be ticked parked
 * the attempt in NEEDS_RECONCILE for a human to reconcile a submission that
 * never happened. It is a plain FAILED: nothing was sent.
 *
 * Exported for the unit matrix in driver.test.ts — this rule is half of a
 * cross-app contract with site-submission.ts and must be pinned from both ends.
 */
export function driverErrorKind(phase: Exclude<DriverErrorKind, "timeout">, cause: unknown): DriverErrorKind {
  if (!(cause instanceof errors.TimeoutError)) return phase;
  return phase === "fill" ? "fill" : "timeout";
}

function driverError(phase: Exclude<DriverErrorKind, "timeout">, message: string, cause: unknown): DriverError {
  return new DriverError(`${message}: ${detailOf(cause)}`, driverErrorKind(phase, cause), { cause });
}

function detailOf(cause: unknown): string {
  return cause instanceof Error ? (cause.message.split("\n")[0] ?? cause.message) : String(cause);
}

export async function openSession(): Promise<BrowserSession> {
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (cause) {
    // NOT via driverError: a launch has no click to be ambiguous about, so
    // even a launch TIMEOUT must stay provably pre-click ("navigation"), not
    // collapse onto "timeout" and park the attempt for a browser that never
    // existed.
    throw new DriverError(`could not launch chromium: ${detailOf(cause)}`, "navigation", { cause });
  }
  return {
    newPage: () => browser.newPage(),
    close: () => browser.close(),
  };
}

/**
 * The last line of defence before Chromium is pointed at anything.
 *
 * Callers are supposed to have gated the target already (apps/web's
 * `refuseCaptureTarget` does protocol, internal-network ranges and the sandbox
 * allow-list). This check exists because a caller that FORGETS must still not
 * be able to read the server's filesystem: `file:///etc/passwd` returned its
 * contents in `bodyText` in the P6 task-2 review. Deliberately duplicated
 * rather than deduplicated — it is the redundancy that makes it a layer.
 *
 * Only the protocol is checked here: this module has no config and no notion
 * of workspaces, so host policy stays with the caller that has both.
 */
function assertNavigable(url: string): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new DriverError(`refusing to open ${url}: not an absolute URL`, "navigation");
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new DriverError(`refusing to open a ${protocol} URL: only http(s) targets can be driven`, "navigation");
  }
}

async function gotoOrThrow(page: Page, url: string, deps: DriverDeps): Promise<void> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: deps.timeoutMs });
  } catch (cause) {
    throw driverError("navigation", `could not open ${url}`, cause);
  }
}

async function extract(page: Page, url: string): Promise<ExtractedPage> {
  try {
    return await page.evaluate<ExtractedPage>(EXTRACT_SCRIPT);
  } catch (cause) {
    throw driverError("navigation", `could not extract the form at ${url}`, cause);
  }
}

/**
 * Navigate and scrape. The returned `url` is where the browser actually landed
 * (a redirect to a login wall is itself a signal the blocker rules read).
 */
export async function capturePage(session: BrowserSession, url: string, deps: DriverDeps): Promise<RawFormPage> {
  // Before a page is opened, not merely before it is navigated: a refused
  // target must cost nothing and leave nothing behind.
  assertNavigable(url);
  const page = await session.newPage();
  page.setDefaultTimeout(deps.timeoutMs);
  try {
    await gotoOrThrow(page, url, deps);
    const extracted = await extract(page, url);
    return { url: page.url(), ...extracted, totalSteps: deriveTotalSteps(extracted.fields) };
  } finally {
    await page.close();
  }
}

/**
 * Whether a planned answer means "tick this box / pick this option".
 * "true"/"yes"/"on" tick, "false"/"no"/"off" clear, and anything else is read
 * as an option value — matched against the `[value="…"]` the selector pins
 * (that is how a radio group's members are told apart), or taken as a tick
 * when the control has no value in its selector.
 */
function wantsChecked(field: RawField, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (TRUTHY_VALUES.has(normalized)) return true;
  if (FALSY_VALUES.has(normalized)) return false;
  const optionValue = /\[value="([^"]*)"\]/.exec(field.selector)?.[1];
  return optionValue === undefined ? true : value === optionValue;
}

async function applyValue(page: Page, field: RawField, value: string, filePath: string | undefined, deps: DriverDeps): Promise<void> {
  const locator = page.locator(field.selector).first();
  const options = { timeout: deps.timeoutMs };

  if (field.tag === "input" && field.type === "file") {
    // The planner puts a document id in `value`; the actual bytes are on disk
    // and reach us through `files`. No path → nothing to upload.
    if (!filePath) return;
    await locator.setInputFiles(filePath, options);
    return;
  }
  if (field.tag === "select") {
    await locator.selectOption(value, options);
    return;
  }
  if (field.tag === "input" && (field.type === "checkbox" || field.type === "radio")) {
    // A radio is never unset — the group's other member is set instead — so
    // only a checkbox is ever cleared.
    if (wantsChecked(field, value)) await locator.check(options);
    else if (field.type === "checkbox") await locator.uncheck(options);
    return;
  }
  await locator.fill(value, options);
}

interface StepButtons {
  next: string | null;
  submit: string | null;
}

/**
 * Which button ends each step, read off the page rather than hardcoded: within
 * a step's own section, a `btn_next…` id (or "Next"/"Continue" text) advances
 * and a `btn_submit` id (or submit-ish text) finishes.
 */
function buttonsByStep(extracted: ExtractedPage, buttonSteps: number[], totalSteps: number): StepButtons[] {
  // A step section can hold a button and no fields (a review step), so the
  // buttons — not just the fields — decide how long this table is.
  const length = Math.max(totalSteps, ...buttonSteps.map((step) => step + 1));
  const perStep: StepButtons[] = Array.from({ length }, () => ({ next: null, submit: null }));
  extracted.buttons.forEach((button, index) => {
    const step = buttonSteps[index] ?? 0;
    const slot = perStep[step];
    if (!slot) return;
    if (!slot.next && (button.id.startsWith(NEXT_BUTTON_ID_PREFIX) || NEXT_BUTTON_TEXT_RE.test(button.text))) {
      slot.next = button.selector;
    } else if (!slot.submit && (button.id === SUBMIT_BUTTON_ID || SUBMIT_BUTTON_TEXT_RE.test(button.text))) {
      slot.submit = button.selector;
    }
  });
  return perStep;
}

async function readPageText(page: Page): Promise<string> {
  const text = await page.evaluate<string>("document.body ? document.body.innerText : ''");
  return text.replace(/[ \t]+/g, " ").trim();
}

async function readConfirmationId(page: Page, pageText: string): Promise<string | null> {
  const attribute = await page
    .locator("[data-confirmation-id]")
    .first()
    .getAttribute("data-confirmation-id", { timeout: 1_000 })
    .catch(() => null);
  if (attribute) return attribute;
  return CONFIRMATION_TEXT_RE.exec(pageText)?.[1] ?? null;
}

/**
 * Fill every planned answer, walk the steps, click Submit exactly once, and
 * bring back the evidence (confirmation id, final URL, screenshot, text).
 *
 * Nothing here decides *whether* to submit — the caller has already run the
 * review gate (`requiresUserBeforeSubmit`). This function submits.
 */
export async function fillAndSubmit(session: BrowserSession, args: FillAndSubmitArgs): Promise<SubmitResult> {
  const { url, form, answers, files, deps } = args;
  assertNavigable(url);
  const page = await session.newPage();
  page.setDefaultTimeout(deps.timeoutMs);

  try {
    await gotoOrThrow(page, url, deps);
    const extracted = await extract(page, url);
    // The live page is the authority on what is there now, but a form whose
    // later steps only appear after a click can look shorter than the parse
    // that produced `form` — never walk fewer steps than that parse saw.
    const totalSteps = Math.max(deriveTotalSteps(extracted.fields), form.totalSteps);
    const answersByFieldId = new Map(answers.map((answer) => [answer.fieldId, answer]));

    let buttonSteps: number[];
    try {
      buttonSteps = await page.evaluate<number[]>(BUTTON_STEPS_SCRIPT);
    } catch (cause) {
      throw driverError("navigation", `could not read the step buttons at ${url}`, cause);
    }
    const stepButtons = buttonsByStep(extracted, buttonSteps, totalSteps);

    for (let step = 0; step < totalSteps; step += 1) {
      // Top-to-bottom in document order, so a field that reveals another (a
      // "other, please specify") is filled before what it reveals.
      for (const field of extracted.fields) {
        if (field.step !== step) continue;
        const fieldId = rawFieldId(field);
        const value = answersByFieldId.get(fieldId)?.value ?? "";
        // An upload needs no answer text: the planner's `value` is a document
        // id, and the bytes come from `files`.
        const filePath = files[fieldId];
        // An empty value means two different things depending on the control.
        //
        // For a text/select/file control it means "nothing was planned" — leave
        // whatever the page has alone. For a TICKABLE control (checkbox/radio)
        // it means the opposite: no consent was given. The review screen's
        // consent row commits "" — never "false" — when the user unticks a
        // legal attestation, so skipping here would leave a box the page
        // shipped PRE-TICKED still ticked at submit time, and the receipt
        // (`value: ""`) would say the opposite of what was actually sent.
        // `applyValue` turns "" into an `uncheck()` for a checkbox and a no-op
        // for a radio (a radio is cleared by ticking a sibling, never alone).
        const isTickable = field.tag === "input" && (field.type === "checkbox" || field.type === "radio");
        if (value === "" && filePath === undefined && !isTickable) continue;
        try {
          await applyValue(page, field, value, filePath, deps);
        } catch (cause) {
          throw driverError("fill", `could not fill ${field.selector}`, cause);
        }
      }

      const isLastStep = step === totalSteps - 1;
      if (isLastStep) break;

      const next = stepButtons[step]?.next;
      if (!next) continue; // steps already rendered together need no click.
      try {
        await page.locator(next).first().click({ timeout: deps.timeoutMs });
        const firstNextField = extracted.fields.find((field) => field.step === step + 1);
        if (firstNextField) {
          await page.locator(firstNextField.selector).first().waitFor({ state: "attached", timeout: deps.timeoutMs });
        }
      } catch (cause) {
        // "advance", not "fill": the click was dispatched before this error
        // surfaced, and on a real ATS a next-labelled button can turn out to
        // be the actual submit — apps/web must treat this as ambiguous, never
        // as a provably pre-click failure it invites the user to retry.
        throw driverError("advance", `could not advance past step ${step}`, cause);
      }
    }

    const submitSelector =
      stepButtons[totalSteps - 1]?.submit ?? stepButtons.map((s) => s.submit).filter((s): s is string => s !== null).at(-1);
    if (!submitSelector) {
      throw new DriverError(`no submit button found on ${url}`, "submit");
    }

    try {
      // One click, and only one. A form that posts navigates; one that does not
      // (an XHR submit) simply times out this wait and we read the same page.
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: deps.timeoutMs }).catch(() => null),
        page.locator(submitSelector).first().click({ timeout: deps.timeoutMs }),
      ]);
    } catch (cause) {
      throw driverError("submit", `could not submit ${url}`, cause);
    }

    const pageText = await readPageText(page);
    return {
      confirmationId: await readConfirmationId(page, pageText),
      finalUrl: page.url(),
      screenshotPng: await page.screenshot({ fullPage: true, timeout: deps.timeoutMs }),
      pageText,
    };
  } finally {
    await page.close();
  }
}
