// The Playwright driver — the ONE place in CareerHQ that drives a live browser.
//
// Everything upstream (parsers, adapters, answer planning) is browser-free and
// works off `RawFormPage`; everything downstream (the site orchestrator, Task
// 11) works off the results returned here. This module's whole job is to turn
// a URL into a `RawFormPage`, and a `CanonicalForm` + `PlannedAnswer[]` back
// into keystrokes, one submit click, and the evidence of what happened.
import type { CanonicalForm, FieldKind, PlannedAnswer } from "@careerhq/contracts";
import { fieldIdentityHash, fieldKindFor, rawFieldId, type RawField, type RawFormPage } from "@careerhq/autoapply";
import { chromium, errors, type Browser, type Page } from "playwright";
import { acquireBrowserSlot, type BrowserSlot } from "./browser-limit.js";
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
  /**
   * Whether Chromium may be pointed at a URL — asked once per navigation, not
   * once per capture. Required, not optional: a caller that has no opinion has
   * not thought about it, and the last caller who had no opinion was the SSRF.
   *
   * The real implementations pass `allowsCaptureTarget` from
   * `@careerhq/autoapply/policy` bound to the caller's workspace policy — the
   * SAME function whose refusal reason apps/web shows the user, so the gate
   * and the guard can never disagree about a URL.
   */
  isNavigationAllowed: (url: string) => boolean;
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

export interface OpenSessionOptions {
  /**
   * A slot the caller ALREADY holds. Given one, `openSession` acquires nothing
   * and `close()` releases nothing — the holder decides when the slot goes
   * back, which is the whole point: apps/web takes one slot for a whole confirm
   * so a busy refusal cannot arrive after the confirmation token is burned.
   * Without it, the session owns its slot for exactly its own lifetime.
   */
  slot?: BrowserSlot;
}

/**
 * How long `close()` waits for Chromium to actually go away before it gives the
 * slot back anyway. Every other driver call has a budget
 * (`AUTOAPPLY_BROWSER_TIMEOUT_MS`); `browser.close()` is unbounded in
 * Playwright, and on the demo box a wedged or OOM-throttled Chromium whose
 * close never settles would hold the process's only slot forever — from the
 * visitor's side, indistinguishable from auto-apply being broken until the
 * container restarts. Leaking the process is the lesser failure, and it is
 * bounded by the container; leaking the slot is not.
 *
 * Not configurable on purpose: it is a backstop for a hang, not a tuning knob,
 * and a value long enough to be wrong is a value nobody should be able to set.
 */
export const BROWSER_CLOSE_BUDGET_MS = 10_000;

/** Resolves when the browser is closed, or when the budget runs out — whichever is first. */
async function closeWithinBudget(browser: Browser): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, BROWSER_CLOSE_BUDGET_MS);
    // Never keep the process (or a vitest worker) alive for this timer.
    timer.unref?.();
  });
  try {
    // A close that REJECTS still rejects here — the caller hears about it; only
    // a close that never settles is abandoned.
    await Promise.race([browser.close(), budget]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The one place a Chromium process is started, and therefore the one place the
 * global concurrency limit is enforced (./browser-limit.ts). The slot is taken
 * BEFORE the launch — the point is to not start the browser — and given back by
 * the returned handle's `close()`, so a session's whole lifetime holds it.
 *
 * Unless the caller brings its own (`opts.slot`), in which case this function
 * neither takes nor gives back a slot: the caller's reservation is wider than
 * any one session. `close()` still closes the browser either way.
 *
 * A refusal leaves this function as `BrowserBusyError`, deliberately NOT
 * wrapped in a `DriverError`: "there was no room to start a browser" is a
 * different thing from "the browser failed to start", and apps/web turns the
 * two into different outcomes for the user. Both are provably pre-click.
 */
export async function openSession(opts: OpenSessionOptions = {}): Promise<BrowserSession> {
  const caller = opts.slot;
  // No-op when the caller holds the slot: releasing someone else's reservation
  // is exactly the bug this parameter exists to prevent.
  const releaseSlot = caller ?? acquireBrowserSlot();
  const releaseOwnSlot = caller ? (): void => undefined : releaseSlot;
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (cause) {
    // The slot goes back before the throw: a browser that never started must
    // not hold the process's only one for the rest of its life.
    releaseOwnSlot();
    // NOT via driverError: a launch has no click to be ambiguous about, so
    // even a launch TIMEOUT must stay provably pre-click ("navigation"), not
    // collapse onto "timeout" and park the attempt for a browser that never
    // existed.
    throw new DriverError(`could not launch chromium: ${detailOf(cause)}`, "navigation", { cause });
  }
  return {
    newPage: () => browser.newPage(),
    // `finally`, so a close that throws still frees the slot — otherwise one
    // wedged Chromium would refuse every later visitor for the process's life.
    close: async () => {
      try {
        await closeWithinBudget(browser);
      } finally {
        releaseOwnSlot();
      }
    },
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
 * Only the protocol is checked here: this module still has no config and no
 * notion of workspaces. Host policy arrives as `deps.isNavigationAllowed`, a
 * predicate the caller closes over its own workspace with, and is applied
 * immediately after this — before a page is opened — so a caller that gates
 * nothing cannot reach a host either.
 */
function assertNavigable(url: string, deps: DriverDeps): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new DriverError(`refusing to open ${url}: not an absolute URL`, "navigation");
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new DriverError(`refusing to open a ${protocol} URL: only http(s) targets can be driven`, "navigation");
  }
  if (!deps.isNavigationAllowed(url)) {
    throw new DriverError(`refusing to open ${url}: it is not an allowed target for this workspace`, "navigation");
  }
}

/**
 * How many redirect hops one navigation may take before we call it a loop.
 * Chromium's own limit is 20; matching it means a chain this guard walks
 * behaves like a chain the browser would have walked on its own.
 */
const MAX_REDIRECT_HOPS = 20;

interface NavigationGuard {
  /** The off-policy URL the guard refused, if it refused one. */
  refused: string | null;
  /** The next, already-policy-checked hop `gotoGuarded` should navigate to. */
  redirectTo: string | null;
}

/**
 * Policy at the navigation layer: every hop is checked BEFORE it is requested.
 *
 * The bug this closes (P6 fix-wave review, BLOCKING): `refuseCaptureTarget`
 * ran once, on the URL the user submitted, and `page.goto` then followed
 * redirects wherever they led. A page on an allow-listed host answering `302
 * Location: http://127.0.0.1:9100/secret` was captured and its body returned —
 * proven, and proven from a sandbox workspace through the allow-listed host,
 * so it defeated the host allow-list too.
 *
 * ==> A NOTE ON WHY THIS IS NOT JUST `route.abort()` <==
 *
 * The obvious shape — a `page.route` handler that aborts navigation requests
 * failing the policy — is necessary but NOT sufficient, and measuring that was
 * the whole job. In Playwright 1.62.1 a route handler is invoked for the
 * initial navigation and for renderer-initiated ones (meta refresh, `location
 * =`, link clicks, sub-frames), but Chromium's network stack follows server
 * 30x redirects internally and never re-pauses them, so the handler NEVER SEES
 * THE HOP THAT MATTERS. Fulfilling the redirect response instead of continuing
 * it does not help either — the browser follows a fulfilled 302 without
 * re-entering the handler. Both were measured against the installed version,
 * not assumed.
 *
 * So for main-frame GET navigations the guard takes the redirect chain away
 * from the browser: it fetches with `maxRedirects: 0`, reads `Location`,
 * judges the next hop, and — if allowed — hands it back to `gotoGuarded` to
 * navigate to explicitly, which re-enters this handler and re-judges. Off
 * policy, nothing is fetched: the refusal happens on the Location HEADER, so
 * the internal host is never contacted at all (measured: zero connections to
 * the probe's internal server). Exactly one request per hop is made, the same
 * ones the browser would have made, and `page.url()` stays truthful because
 * the browser really does navigate to each hop.
 *
 * Non-GET navigations are policy-checked but NOT chain-walked: replaying a
 * multipart POST through `route.fetch` to inspect its redirect is a good way
 * to submit an application twice. A POST that redirects off-policy is caught
 * by the post-navigation backstop in `capturePage`/`fillAndSubmit` instead —
 * later than we would like, which is why it is stated here rather than left
 * silent.
 */
async function installNavigationGuard(page: Page, deps: DriverDeps): Promise<NavigationGuard> {
  const guard: NavigationGuard = { refused: null, redirectTo: null };

  await page.route("**/*", async (route) => {
    const request = route.request();
    // Subresources (css, images, xhr) are not navigations and cannot return
    // their body to us; leaving them alone keeps pages rendering normally.
    if (!request.isNavigationRequest()) {
      await route.continue();
      return;
    }

    const url = request.url();
    if (!deps.isNavigationAllowed(url)) {
      guard.refused = url;
      await route.abort("blockedbyclient");
      return;
    }

    if (request.method() !== "GET" || request.frame() !== page.mainFrame()) {
      await route.continue();
      return;
    }

    let response;
    try {
      response = await route.fetch({ maxRedirects: 0 });
    } catch {
      // Unreachable host, TLS failure, aborted route: let the browser produce
      // its own error for `goto` to report, rather than inventing one here.
      await route.abort();
      return;
    }

    const status = response.status();
    const location = response.headers()["location"];
    if (status < 300 || status > 399 || location === undefined) {
      await route.fulfill({ response });
      return;
    }

    let next: string;
    try {
      next = new URL(location, url).toString();
    } catch {
      guard.refused = location;
      await route.abort("blockedbyclient");
      return;
    }
    if (!deps.isNavigationAllowed(next)) {
      guard.refused = next;
      await route.abort("blockedbyclient");
      return;
    }

    guard.redirectTo = next;
    // A blank 200 rather than an abort: aborting starts a `chrome-error://`
    // navigation that races the goto we are about to make for `next`, and the
    // legitimate same-host redirect loses that race.
    await route.fulfill({ status: 200, contentType: "text/html", body: "" });
  });

  return guard;
}

/**
 * `page.goto`, following the redirect chain one policy-checked hop at a time.
 * The loop is the browser's redirect follower, re-implemented where the policy
 * can see it.
 */
async function gotoOrThrow(page: Page, url: string, deps: DriverDeps): Promise<void> {
  const guard = await installNavigationGuard(page, deps);
  let target = url;

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    guard.refused = null;
    guard.redirectTo = null;

    let cause: unknown = null;
    try {
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: deps.timeoutMs });
    } catch (err) {
      cause = err;
    }

    // Checked before `cause`: the abort IS why `goto` rejected, and the
    // refusal is a far more useful thing to tell the caller than
    // `net::ERR_BLOCKED_BY_CLIENT`.
    if (guard.refused !== null) {
      throw new DriverError(
        `refusing to open ${guard.refused}: it is not an allowed target for this workspace`,
        "navigation",
      );
    }
    if (guard.redirectTo !== null) {
      target = guard.redirectTo;
      continue;
    }
    if (cause !== null) throw driverError("navigation", `could not open ${url}`, cause);
    return;
  }

  throw new DriverError(`could not open ${url}: more than ${MAX_REDIRECT_HOPS} redirects`, "navigation");
}

/**
 * The post-navigation backstop the route guard is not allowed to make
 * redundant. If a policy bug at the route layer ever lets the browser land
 * somewhere off-policy — a non-GET redirect, a hop shape nobody anticipated —
 * the content still does not leave this function. Cheap, and it runs before
 * `extract`, so nothing off-policy is ever read, parsed or typed into.
 */
function assertLandedOnPolicy(page: Page, deps: DriverDeps): void {
  const landed = page.url();
  if (!deps.isNavigationAllowed(landed)) {
    throw new DriverError(
      `refusing to read ${landed}: it is not an allowed target for this workspace`,
      "navigation",
    );
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
  assertNavigable(url, deps);
  const page = await session.newPage();
  page.setDefaultTimeout(deps.timeoutMs);
  try {
    await gotoOrThrow(page, url, deps);
    assertLandedOnPolicy(page, deps);
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

/** One control this call will touch, and what it will put there. */
interface PlannedFill {
  field: RawField;
  fieldId: string;
  value: string;
  /** Absolute path for a file input; undefined for everything else. */
  filePath: string | undefined;
}

/**
 * Exactly the controls `fillAndSubmit` will act on, in document order.
 *
 * Split out of the fill loop so the re-verification below and the typing below
 * that decide on the SAME set: a check that judged fields the driver never
 * touches would refuse legitimate pages, and one that missed a field the driver
 * does touch would be no check at all.
 */
function plannedFills(
  fields: RawField[],
  answersByFieldId: Map<string, PlannedAnswer>,
  files: Record<string, string>,
): PlannedFill[] {
  const fills: PlannedFill[] = [];
  for (const field of fields) {
    const fieldId = rawFieldId(field);
    const value = answersByFieldId.get(fieldId)?.value ?? "";
    // An upload needs no answer text: the planner's `value` is a document id,
    // and the bytes come from `files`.
    const filePath = files[fieldId];
    // An empty value means two different things depending on the control.
    //
    // For a text/select/file control it means "nothing was planned" — leave
    // whatever the page has alone. For a TICKABLE control (checkbox/radio) it
    // means the opposite: no consent was given. The review screen's consent row
    // commits "" — never "false" — when the user unticks a legal attestation,
    // so skipping here would leave a box the page shipped PRE-TICKED still
    // ticked at submit time, and the receipt (`value: ""`) would say the
    // opposite of what was actually sent. `applyValue` turns "" into an
    // `uncheck()` for a checkbox and a no-op for a radio (a radio is cleared by
    // ticking a sibling, never alone).
    const isTickable = field.tag === "input" && (field.type === "checkbox" || field.type === "radio");
    if (value === "" && filePath === undefined && !isTickable) continue;
    fills.push({ field, fieldId, value, filePath });
  }
  return fills;
}

/** Keeps a refusal readable when a page's "label" is really a wall of text. */
function shortLabel(labelText: string): string {
  const collapsed = labelText.replace(/\s+/g, " ").trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 159)}…` : collapsed;
}

/**
 * The answers were planned against the page as it was at REVIEW time; this is
 * the page as it is NOW. Before a single keystroke, every control this call
 * would touch must still be asking the question the user actually reviewed.
 *
 * Why the identity and not the field id: `rawFieldId` hashes the selector
 * alone, so a page that keeps its markup and rewords its labels produces the
 * very same ids — every planned answer would still "match" a field whose
 * meaning had changed underneath it, and the driver would type it in.
 *
 * It matters most for a CONSENT TICK, whose entire meaning is the statement
 * sitting beside it. A recorded consent that no longer describes what would be
 * submitted is worse than no consent at all: the receipt would say the user
 * agreed to something they were never shown.
 *
 * `kind: "fill"` is load-bearing, not cosmetic. It is in apps/web's
 * PRE_CLICK_DRIVER_ERROR_KINDS, so the attempt comes out FAILED and retryable
 * (re-run auto-apply, review the changed question, submit again) instead of
 * parked in NEEDS_RECONCILE — and it is honest, because this throws before any
 * control is touched and long before the submit button is: a browser that never
 * clicked cannot have submitted.
 *
 * A field the snapshot has no identity for (captured before this existed, or a
 * form built by hand) is passed over: absent is "nothing recorded to compare
 * against", never "mismatch".
 */
function assertQuestionsUnchanged(fills: PlannedFill[], form: CanonicalForm): void {
  const reviewed = new Map(form.fields.map((field) => [field.id, field.identityHash]));
  for (const fill of fills) {
    const expected = reviewed.get(fill.fieldId);
    if (expected === undefined) continue;
    if (fieldIdentityHash(fill.field) === expected) continue;
    throw new DriverError(
      `refusing to fill ${fill.field.selector} ("${shortLabel(fill.field.labelText)}"): `
      + "the question under it changed since this form was reviewed",
      "fill",
    );
  }
}

/** The two kinds whose empty planned value is a DECISION rather than an absence. */
const TICKABLE_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>(["checkbox", "radio"]);

/**
 * The same check, asked from the REVIEWED side — and the half that was missing.
 *
 * `assertQuestionsUnchanged` above can only judge fields that survived
 * `plannedFills`, and `plannedFills` reads the LIVE page: it drops any control
 * whose planned value is empty unless the control is tickable *right now*. So a
 * page could neutralise the whole check on one control by changing one
 * attribute. The reviewer proved it: a pre-ticked consent box the user UNTICKED
 * (planned value `""`) served back as
 * `<input type="hidden" … value="true">` under the same id, name, selector and
 * label. Identical field id, identical identity hash, dropped before the
 * comparison, and demo-ats recorded `background_check_consent: "true"` while the
 * receipt recorded `""`. A receipt that says "declined" while the employer is
 * told "consented" is the worst thing this application can produce, because
 * nobody finds out.
 *
 * So this iterates the fields the USER REVIEWED, not the fields the page is
 * offering now, and for every one the user made a decision about it requires:
 *
 *   1. the control is still there (same `id`, i.e. same selector);
 *   2. it still asks the same question (`identityHash`);
 *   3. it is still the same KIND of control (`kind`).
 *
 * (3) is what catches the checkbox→hidden swap, and it is compared against a
 * value every snapshot already stores — no re-hashing, so snapshots written
 * before this existed are judged by exactly the same rule.
 *
 * (1) also covers the two neighbours: a consent field REMOVED between review and
 * submit used to submit the rest of the form regardless, and a required text
 * field whose id MOVED used to be silently not typed, fail HTML5 validation and
 * come back `confirmationId: null` — which apps/web parks NEEDS_RECONCILE,
 * sending a human to reconcile a submission that provably never happened. Both
 * are now `kind: "fill"` — which apps/web reads as provably pre-click and
 * therefore costing the visitor nothing: the confirmation is handed back
 * unspent and the attempt stays previewable, so "retryable" is literal.
 *
 * What is deliberately NOT required:
 *
 * - A field with no recorded `identityHash` (snapshot from before this existed,
 *   or a form built by hand) — absent is "nothing to compare against".
 * - A field the user made no decision about: no planned answer at all, or an
 *   empty answer on a control whose reviewed kind is not tickable, which is the
 *   planner's way of saying "leave whatever the page has alone". The driver
 *   types nothing there, so there is nothing to misattribute.
 * - A field on a step the current extraction has not rendered. A multi-step form
 *   whose later controls only exist after a "Next" click is legitimate and
 *   common; refusing it would break every such ATS. Step 0 is always treated as
 *   rendered — it is the step the browser landed on, so "no fields at all" is a
 *   changed page, not an unrendered step.
 */
function assertReviewedFieldsIntact(
  form: CanonicalForm,
  liveFields: RawField[],
  answersByFieldId: Map<string, PlannedAnswer>,
  files: Record<string, string>,
): void {
  const liveById = new Map(liveFields.map((field) => [rawFieldId(field), field]));
  const renderedSteps = new Set<number>([0, ...liveFields.map((field) => field.step)]);

  for (const reviewed of form.fields) {
    if (reviewed.identityHash === undefined) continue;
    const answer = answersByFieldId.get(reviewed.id);
    if (answer === undefined) continue;
    const decided = answer.value !== "" || files[reviewed.id] !== undefined || TICKABLE_KINDS.has(reviewed.kind);
    if (!decided) continue;

    const live = liveById.get(reviewed.id);
    if (live === undefined) {
      if (!renderedSteps.has(reviewed.step)) continue;
      throw new DriverError(
        `refusing to fill the form at ${form.url}: the control the user answered `
        + `("${shortLabel(reviewed.label)}") is no longer on the page`,
        "fill",
      );
    }
    if (fieldIdentityHash(live) !== reviewed.identityHash) {
      throw new DriverError(
        `refusing to fill ${live.selector} ("${shortLabel(live.labelText)}"): `
        + "the question under it changed since this form was reviewed",
        "fill",
      );
    }
    const liveKind = fieldKindFor(live);
    if (liveKind !== reviewed.kind) {
      throw new DriverError(
        `refusing to fill ${live.selector} ("${shortLabel(live.labelText)}"): `
        + `it was a ${reviewed.kind} when this form was reviewed and is a ${liveKind} now`,
        "fill",
      );
    }
  }
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
  assertNavigable(url, deps);
  const page = await session.newPage();
  page.setDefaultTimeout(deps.timeoutMs);

  try {
    await gotoOrThrow(page, url, deps);
    assertLandedOnPolicy(page, deps);
    const extracted = await extract(page, url);
    // The live page is the authority on what is there now, but a form whose
    // later steps only appear after a click can look shorter than the parse
    // that produced `form` — never walk fewer steps than that parse saw.
    const totalSteps = Math.max(deriveTotalSteps(extracted.fields), form.totalSteps);
    const answersByFieldId = new Map(answers.map((answer) => [answer.fieldId, answer]));
    const fills = plannedFills(extracted.fields, answersByFieldId, files);
    // Before anything is typed, ticked or uploaded — and therefore before there
    // is anything to undo. Both directions, because neither subsumes the other:
    // the reviewed side covers every field the user decided about, including the
    // ones `plannedFills` drops; the live side additionally covers a control the
    // driver will act on with no planned answer at all (a tickable is cleared).
    assertReviewedFieldsIntact(form, extracted.fields, answersByFieldId, files);
    assertQuestionsUnchanged(fills, form);

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
      for (const fill of fills) {
        if (fill.field.step !== step) continue;
        try {
          await applyValue(page, fill.field, fill.value, fill.filePath, deps);
        } catch (cause) {
          throw driverError("fill", `could not fill ${fill.field.selector}`, cause);
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

    // The submit click is a non-GET navigation, so the route guard checked its
    // target but did not walk its redirect chain (see `installNavigationGuard`)
    // — this is where that gap is closed. Deliberately AFTER the click and
    // therefore ambiguous: the form really was sent, so apps/web parks the
    // attempt for a human rather than claiming it failed. Reading the
    // confirmation page of an off-policy host is the one thing that must not
    // happen quietly.
    assertLandedOnPolicy(page, deps);

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
