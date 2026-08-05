import { randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { chromium, errors } from "playwright";
import { consentPage, greenhousePage, hiddenConsentPage, leverPage, type DemoJob } from "@careerhq/demo-ats";
import { rawPageFromHtml } from "@careerhq/autoapply/testing";
import { allowsCaptureTarget } from "@careerhq/autoapply/policy";
import { detectBlockers, fieldIdentityHash, parseForm, rawFieldId, type RawField, type RawFormPage } from "@careerhq/autoapply";
import type { CanonicalForm, PlannedAnswer } from "@careerhq/contracts";
import {
  BUTTON_STEPS_SCRIPT,
  deriveTotalSteps,
  EXTRACT_SCRIPT,
  extractButtonStepsFromDocument,
  extractFromDocument,
  type ExtractDocument,
  type ExtractedPage,
} from "./extract.js";
import {
  capturePage, DriverError, driverErrorKind, fillAndSubmit, openSession,
  type BrowserSession, type DriverDeps, type DriverErrorKind,
} from "./driver.js";

const JOB: DemoJob = { id: "eng-1", title: "Senior Robotics Engineer", company: "Northwind Robotics" };
const JOB_2: DemoJob = { id: "eng-2", title: "Autonomy Software Engineer", company: "Northwind Robotics" };

function asExtractDocument(html: string): ExtractDocument {
  return parseHTML(html).document as unknown as ExtractDocument;
}

/** Runs EXTRACT_SCRIPT the way `page.evaluate` does: as a standalone source string. */
function runScript<T>(script: string, document: ExtractDocument): T {
  return new Function("document", `return ${script};`)(document) as T;
}

// ---------------------------------------------------------------------------
// Browser-free parity: the in-page extractor must implement exactly the rules
// the linkedom-backed test helper implements (Task 4). Asserted twice — once
// against the imported function, once against the *serialized* script the
// browser actually runs, which also proves the script is self-contained.
// ---------------------------------------------------------------------------
describe("EXTRACT_SCRIPT parity with rawPageFromHtml", () => {
  const cases: Array<{ name: string; html: string; url: string }> = [
    { name: "greenhouse (multi-step)", html: greenhousePage(JOB), url: "http://demo-ats:3001/greenhouse/jobs/eng-1" },
    { name: "lever (single page)", html: leverPage(JOB_2), url: "http://demo-ats:3001/lever/jobs/eng-2" },
    // Pre-ticked checkboxes: `checked` is an attribute the extractor
    // deliberately does not carry, so both implementations must agree on
    // ignoring it rather than one of them quietly reading it.
    { name: "consent (pre-ticked boxes)", html: consentPage(JOB), url: "http://demo-ats:3001/consent/jobs/eng-1" },
    // A display:none wrapper: neither implementation reads layout, so both
    // must still report the field — it is the DRIVER that discovers it cannot
    // be acted on, at fill time, and says so with `kind: "fill"`.
    {
      name: "hidden consent (display:none)",
      html: hiddenConsentPage(JOB),
      url: "http://demo-ats:3001/hidden-consent/jobs/eng-1",
    },
  ];

  for (const { name, html, url } of cases) {
    it(`matches the helper field-for-field — ${name}`, () => {
      const expected = rawPageFromHtml(html, url);
      const extracted = extractFromDocument(asExtractDocument(html));
      const page: RawFormPage = { url, ...extracted, totalSteps: deriveTotalSteps(extracted.fields) };
      expect(page).toEqual(expected);
    });

    it(`serializes to a self-contained script with identical output — ${name}`, () => {
      const doc = asExtractDocument(html);
      const viaScript = runScript<ExtractedPage>(EXTRACT_SCRIPT, doc);
      expect(viaScript).toEqual(extractFromDocument(doc));
    });
  }

  it("assigns 0-based steps from the enclosing [data-step] section", () => {
    const extracted = extractFromDocument(asExtractDocument(greenhousePage(JOB)));
    expect(deriveTotalSteps(extracted.fields)).toBe(3);
    const stepOf = (name: string) => extracted.fields.find((f) => f.name === name)?.step;
    expect(stepOf("first_name")).toBe(0);
    expect(stepOf("work_authorization")).toBe(1);
    expect(stepOf("gender")).toBe(2);
  });

  it("pairs each button with its step so the driver never hardcodes button ids", () => {
    const doc = asExtractDocument(greenhousePage(JOB));
    const steps = extractButtonStepsFromDocument(doc);
    const { buttons } = extractFromDocument(doc);
    expect(buttons.map((b, i) => [b.id, steps[i]])).toEqual([
      ["btn_next_1", 0],
      ["btn_next_2", 1],
      ["btn_submit", 2],
    ]);
    expect(runScript<number[]>(BUTTON_STEPS_SCRIPT, doc)).toEqual(steps);
  });
});

// ---------------------------------------------------------------------------
// The cross-app contract. `apps/web`'s site orchestrator classifies a driver
// failure as pre-click (→ blocked, token returned) or ambiguous
// (→ NEEDS_RECONCILE) by reading
// `name` and `kind` off the thrown error STRUCTURALLY — it takes its driver by
// injection and must not pull `playwright` into its own module graph to run an
// `instanceof`. These two properties are therefore a published contract, not an
// implementation detail: renaming either silently downgrades every provably
// pre-click failure into a human reconciliation task — and, since the P6 final
// review, also into a spent confirmation, because pre-click is what buys the
// token back.
// ---------------------------------------------------------------------------
describe("DriverError's cross-app contract", () => {
  it('reports name "DriverError" and a string kind', () => {
    const err = new DriverError("could not open http://example.invalid", "navigation");
    expect(err.name).toBe("DriverError");
    expect(err.kind).toBe("navigation");
  });

  it("keeps the kinds apps/web treats as provably pre-click", () => {
    // Mirrors PRE_CLICK_DRIVER_ERROR_KINDS in apps/web/src/lib/site-submission.ts.
    const preClick: DriverErrorKind[] = ["navigation", "fill"];
    for (const kind of preClick) {
      expect(new DriverError("x", kind).kind).toBe(kind);
    }
    // "submit", "timeout" and "advance" must stay OUT of that set — the click
    // may have landed. "advance" is the between-steps click: it is dispatched
    // before its error surfaces, and a next-labelled button can turn out to be
    // the real submit on ATSs whose step heuristics misplace it.
    const ambiguous: DriverErrorKind[] = ["submit", "timeout", "advance"];
    for (const kind of ambiguous) {
      expect(preClick).not.toContain(kind);
    }
  });

  /**
   * The other half of that contract: which kind a TIMEOUT gets. "timeout" is
   * excluded from the pre-click set because a click that timed out may still
   * have landed — so any phase that collapses onto it is asserting real
   * post-click ambiguity. Filling a form control has no click in it and must
   * not make that claim.
   */
  describe("driverErrorKind", () => {
    const timeout = new errors.TimeoutError("Timeout 30000ms exceeded.");

    it("keeps a fill-phase TimeoutError as \"fill\" — ticking a box cannot submit the form", () => {
      expect(driverErrorKind("fill", timeout)).toBe("fill");
    });

    it.each(["navigation", "advance", "submit"] as const)(
      "still collapses a %s-phase TimeoutError onto \"timeout\"",
      (phase) => {
        expect(driverErrorKind(phase, timeout)).toBe("timeout");
      },
    );

    it("carries the phase through for anything that is not a TimeoutError", () => {
      const boom = new Error("element is not attached to the DOM");
      for (const phase of ["navigation", "fill", "advance", "submit"] as const) {
        expect(driverErrorKind(phase, boom)).toBe(phase);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// The driver's own protocol floor (P6 task-2 review, BLOCKING 2). apps/web
// gates the target before it ever gets here, but a caller that forgets must
// still not be able to make this process read local files — the review proved
// `capturePage(session, "file:///…")` returned the file's contents in
// `bodyText`. Browser-free: the refusal must land BEFORE a page is opened, so
// a stub session that would explode if used is the assertion.
// ---------------------------------------------------------------------------
/**
 * These suites are about everything EXCEPT the host policy, so they hand the
 * driver a predicate that allows everything — the policy's own table lives in
 * `packages/autoapply/src/target-policy.test.ts` and the driver's use of it is
 * pinned by "the navigation guard" suite below. A permissive predicate here
 * also keeps these cases honest: what they assert must hold on its own, not
 * because the policy happened to refuse first.
 */
const ALLOW_ANY = (): boolean => true;

describe("capturePage's protocol floor", () => {
  const explodingSession: BrowserSession = {
    newPage: () => Promise.reject(new Error("capturePage opened a page for a URL it should have refused")),
    close: () => Promise.resolve(),
  };

  it.each([
    "file:///etc/passwd",
    "file://localhost/etc/passwd",
    "javascript:fetch('http://169.254.169.254/')",
    "data:text/html,<script>alert(1)</script>",
    "blob:https://example.com/1234",
    "chrome://settings",
    "ftp://files.example.com/x",
  ])("refuses %s as a navigation-phase DriverError", async (url) => {
    const err = await capturePage(explodingSession, url, { timeoutMs: 1000, isNavigationAllowed: ALLOW_ANY }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect((err as DriverError).kind).toBe("navigation");
    expect((err as DriverError).message).toMatch(/refusing to open/);
  });

  it.each(["not a url", "/relative/path", "//example.com/protocol-relative"])(
    "refuses %s, which is not an absolute URL at all",
    async (url) => {
      const err = await capturePage(explodingSession, url, { timeoutMs: 1000, isNavigationAllowed: ALLOW_ANY }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DriverError);
      expect((err as DriverError).kind).toBe("navigation");
    },
  );

  it("lets an http(s) URL through to the session, proving the refusal is about the protocol", async () => {
    const err = await capturePage(explodingSession, "https://careers.northwind.example/apply", { timeoutMs: 1000, isNavigationAllowed: ALLOW_ANY })
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/should have refused/);
  });
});

// ---------------------------------------------------------------------------
// Integration: a real Chromium against a running demo-ats. Both are probed up
// front — a machine without the browser binary or without the demo server
// skips cleanly instead of failing.
// ---------------------------------------------------------------------------
const DEMO_ATS_URL = (process.env["DEMO_ATS_URL"] ?? "http://localhost:3001").replace(/\/+$/, "");

async function probeDemoAts(): Promise<boolean> {
  try {
    const res = await fetch(`${DEMO_ATS_URL}/`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
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
const live = describe.skipIf(!demoAtsUp || !browserAvailable);

/**
 * The demo-ats store is process-global and shared with apps/web's
 * site-e2e.test.ts, which runs as a separate turbo task against the same
 * server. Neither suite may wipe it or assert on its total size — that race is
 * what made the documented gate reproducible only at TURBO_CONCURRENCY=1.
 * Scope every assertion to the job id the suite submits to instead.
 */
async function submissionsFor(jobId: string): Promise<Array<{
  id: string; jobId: string; fields: Record<string, string>; files: Array<{ filename: string }>;
}>> {
  const all = (await (await fetch(`${DEMO_ATS_URL}/api/submissions`)).json()) as Array<{
    id: string; jobId: string; fields: Record<string, string>; files: Array<{ filename: string }>;
  }>;
  return all.filter((submission) => submission.jobId === jobId);
}

live("driver against demo-ats", () => {
  const deps = { timeoutMs: 30_000, isNavigationAllowed: ALLOW_ANY };
  let session: BrowserSession;
  let resumePath: string;

  beforeAll(async () => {
    session = await openSession();
    const dir = mkdtempSync(path.join(tmpdir(), "careerhq-driver-"));
    resumePath = path.join(dir, "resume.pdf");
    writeFileSync(resumePath, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF\n");
  });

  afterAll(async () => {
    await session?.close();
  });

  it("captures the greenhouse form and matches the pure helper over the same HTML", async () => {
    const url = `${DEMO_ATS_URL}/greenhouse/jobs/eng-1`;
    const page = await capturePage(session, url, deps);

    expect(page.fields.length).toBeGreaterThanOrEqual(10);
    expect(page.totalSteps).toBe(3);
    expect(page.title).toBe("Senior Robotics Engineer at Northwind Robotics");
    expect(page.rootMarkers).toContain("data-source=greenhouse");

    const html = await (await fetch(url)).text();
    const expected = rawPageFromHtml(html, url);
    const shape = (p: RawFormPage) =>
      p.fields.map((f) => ({ id: rawFieldId(f), selector: f.selector, label: f.labelText, step: f.step }));
    expect(shape(page)).toEqual(shape(expected));
  });

  it("surfaces a captcha page as a blocker", async () => {
    const page = await capturePage(session, `${DEMO_ATS_URL}/captcha/jobs/x`, deps);
    expect(detectBlockers(page).map((b) => b.kind)).toContain("captcha");
  });

  it("throws a typed DriverError when the page cannot be reached", async () => {
    const failure = await capturePage(session, "http://127.0.0.1:9/nope", deps).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DriverError);
    expect((failure as DriverError).kind).toBe("navigation");
  });

  it("walks all three steps, uploads the CV and submits exactly once", async () => {
    const before = await submissionsFor("eng-1");

    const url = `${DEMO_ATS_URL}/greenhouse/jobs/eng-1`;
    const raw = await capturePage(session, url, deps);
    const form = parseForm(raw);

    const idFor = (name: string): string => {
      const field = raw.fields.find((f) => f.name === name);
      if (!field) throw new Error(`no raw field named ${name}`);
      return rawFieldId(field);
    };
    const idForRadio = (name: string, value: string): string => {
      const field = raw.fields.find((f) => f.name === name && f.selector.includes(`value="${value}"`));
      if (!field) throw new Error(`no ${name} radio with value ${value}`);
      return rawFieldId(field);
    };

    const values: Array<[string, string]> = [
      // The resume answer carries a *document id*, exactly as the planner emits
      // it; the bytes reach the browser through `files`.
      [idFor("resume"), "cv-variant-1"],
      [idFor("first_name"), "Ada"],
      [idFor("last_name"), "Lovelace"],
      [idFor("email"), "ada@example.com"],
      [idFor("phone"), "+30 210 0000000"],
      [idFor("linkedin_url"), "https://www.linkedin.com/in/ada"],
      [idFor("work_authorization"), "yes"],
      [idFor("visa_sponsorship"), "no"],
      [idFor("why_northwind"), "Because Northwind builds the robots I want to work on."],
      [idFor("legal_attestation"), "true"],
      [idForRadio("gender", "decline"), "true"],
      [idForRadio("veteran_status", "decline"), "true"],
    ];
    const answers: PlannedAnswer[] = values.map(([fieldId, value]) => ({
      fieldId,
      value,
      source: "profile",
      sourceFactIds: [],
      confidence: 1,
      needsUser: false,
      differsFromApproved: false,
      note: "",
    }));

    const result = await fillAndSubmit(session, {
      url,
      form,
      answers,
      files: { [idFor("resume")]: resumePath },
      deps,
    });

    expect(result.confirmationId).toMatch(/^NR-[0-9a-f]{8}$/);
    expect(result.finalUrl).toContain("/greenhouse/apply/eng-1");
    expect(result.pageText).toContain("Application received");
    expect(result.screenshotPng.subarray(0, 4).toString("latin1")).toBe("\x89PNG");

    // Exactly one new row for this job, and it is the one this click created.
    const after = await submissionsFor("eng-1");
    expect(after.length).toBe(before.length + 1);
    const created = after.find((submission) => submission.id === result.confirmationId);
    expect(created).toBeDefined();
    expect(created?.fields["email"]).toBe("ada@example.com");
    expect(created?.fields["first_name"]).toBe("Ada");
    expect(created?.fields["work_authorization"]).toBe("yes");
    expect(created?.fields["legal_attestation"]).toBe("true");
    expect(created?.fields["gender"]).toBe("decline");
    expect(created?.files[0]?.filename).toBe("resume.pdf");
  }, 60_000);

  /**
   * The consent regression (final review F1). A checkbox the page ships
   * PRE-TICKED and a planned value of "" ("no consent given" — what the review
   * screen's consent row commits when the user unticks) must end up UNTICKED in
   * the form the browser actually posts. An unchecked checkbox is simply absent
   * from a form POST, so the stored submission is a direct read of what was
   * sent: no inference, no re-reading of the page we just drove.
   *
   * Before the fix the driver skipped every empty value, so the pre-ticked box
   * was never touched and submitted STILL TICKED while the receipt recorded
   * `value: "" source: "user"` — the receipt saying the opposite of the truth.
   */
  it("unticks a PRE-TICKED checkbox whose planned value is empty, and leaves one planned 'true' ticked", async () => {
    const jobId = "consent-1";
    const before = await submissionsFor(jobId);

    const url = `${DEMO_ATS_URL}/consent/jobs/${jobId}`;
    const raw = await capturePage(session, url, deps);
    const form = parseForm(raw);

    const idFor = (name: string): string => {
      const field = raw.fields.find((f) => f.name === name);
      if (!field) throw new Error(`no raw field named ${name}`);
      return rawFieldId(field);
    };

    const values: Array<[string, string]> = [
      [idFor("name"), "Ada Lovelace"],
      [idFor("email"), "ada@example.com"],
      [idFor("resume"), "cv-variant-1"],
      // Consent GIVEN on the required attestation…
      [idFor("legal_attestation"), "true"],
      // …DECLINED on the pre-ticked background-check box. "" is exactly what
      // the consent row commits on untick — never "false".
      [idFor("background_check_consent"), ""],
      // …and kept on the other pre-ticked box, so this proves the driver is
      // honouring the planned value rather than blanket-clearing checkboxes.
      [idFor("talent_pool_opt_in"), "true"],
    ];
    const answers: PlannedAnswer[] = values.map(([fieldId, value]) => ({
      fieldId,
      value,
      source: "user",
      sourceFactIds: [],
      confidence: 1,
      needsUser: false,
      differsFromApproved: false,
      note: "",
    }));

    const result = await fillAndSubmit(session, {
      url,
      form,
      answers,
      files: { [idFor("resume")]: resumePath },
      deps,
    });

    expect(result.confirmationId).toMatch(/^NR-[0-9a-f]{8}$/);

    const after = await submissionsFor(jobId);
    expect(after.length).toBe(before.length + 1);
    const created = after.find((submission) => submission.id === result.confirmationId);
    expect(created).toBeDefined();
    expect(created?.fields["name"]).toBe("Ada Lovelace");
    expect(created?.fields["legal_attestation"]).toBe("true");
    expect(created?.fields["talent_pool_opt_in"]).toBe("true");
    // The load-bearing assertion: the declined consent is NOT in the posted body.
    expect(created?.fields["background_check_consent"]).toBeUndefined();
  }, 60_000);

  /**
   * The counterpart failure, reproduced against real Chromium: the same
   * pre-ticked box inside a `display:none` wrapper. Playwright waits for
   * actionability and throws a `TimeoutError`, and the kind that failure
   * carries decides the attempt's fate in apps/web — "fill" is FAILED (nothing
   * was sent), anything outside PRE_CLICK_DRIVER_ERROR_KINDS is
   * NEEDS_RECONCILE (a human reconciles a submission by hand). Unticking a
   * checkbox cannot submit a form, so this must be "fill".
   *
   * A short timeout keeps the test honest AND fast: the failure is the point,
   * so there is nothing to wait 30s for.
   */
  it("reports an un-tickable consent box as a FILL failure, not an ambiguous timeout", async () => {
    const jobId = "hidden-consent-1";
    const url = `${DEMO_ATS_URL}/hidden-consent/jobs/${jobId}`;
    const shortDeps = { timeoutMs: 2_000, isNavigationAllowed: ALLOW_ANY };
    const raw = await capturePage(session, url, shortDeps);
    const form = parseForm(raw);

    const idFor = (name: string): string => {
      const field = raw.fields.find((f) => f.name === name);
      if (!field) throw new Error(`no raw field named ${name}`);
      return rawFieldId(field);
    };

    const answers: PlannedAnswer[] = [
      [idFor("name"), "Ada Lovelace"],
      [idFor("email"), "ada@example.com"],
      // Declined — and the box cannot be reached to clear it.
      [idFor("background_check_consent"), ""],
    ].map(([fieldId, value]) => ({
      fieldId: fieldId!,
      value: value!,
      source: "user" as const,
      sourceFactIds: [],
      confidence: 1,
      needsUser: false,
      differsFromApproved: false,
      note: "",
    }));

    const failure = await fillAndSubmit(session, { url, form, answers, files: {}, deps: shortDeps })
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DriverError);
    const kind = (failure as DriverError).kind;
    expect(kind).toBe("fill");
    // Stated the other way round, because this is the bit that regressed: the
    // orchestrator's pre-click set contains "fill" and excludes "timeout".
    expect(kind).not.toBe("timeout");
    // And nothing reached the site.
    expect(await submissionsFor(jobId)).toEqual([]);
  }, 60_000);

  /**
   * Live-page re-verification (carried F5).
   *
   * The driver fills from the form snapshot captured at REVIEW time, but it
   * types into the page as it is NOW. Nothing used to check that the control
   * under a given selector still asked the question the user actually read —
   * and `rawFieldId` is a hash of the selector alone, so a page that reworded a
   * label kept the very same field id and the planned answer landed in it
   * regardless.
   *
   * Simulated from the snapshot's side (store an identity the live page no
   * longer matches), which is the same comparison as the page having changed
   * under an unchanged snapshot.
   *
   * Two assertions carry this test. `kind: "fill"` is what apps/web reads as
   * provably pre-click, so the attempt keeps its confirmation and stays
   * previewable instead of being parked NEEDS_RECONCILE; and the empty
   * submissions list is the proof behind it — the refusal happened before any
   * click, so the site has nothing.
   */
  it("refuses to fill a field whose question changed since review, and submits nothing", async () => {
    const jobId = "consent-drift-1";
    const url = `${DEMO_ATS_URL}/consent/jobs/${jobId}`;
    const raw = await capturePage(session, url, deps);
    const form = parseForm(raw);

    const rawFor = (name: string): RawField => {
      const field = raw.fields.find((f) => f.name === name);
      if (!field) throw new Error(`no raw field named ${name}`);
      return field;
    };
    const idFor = (name: string): string => rawFieldId(rawFor(name));

    const consent = rawFor("legal_attestation");
    // The identity the review screen WOULD have recorded had the page asked
    // this instead — same control, different meaning.
    const reworded = fieldIdentityHash({
      selector: consent.selector,
      labelText: "I consent to my personal data being sold to third parties",
    });
    expect(reworded).not.toBe(fieldIdentityHash(consent));
    const tampered: CanonicalForm = {
      ...form,
      fields: form.fields.map((field) =>
        field.id === rawFieldId(consent) ? { ...field, identityHash: reworded } : field,
      ),
    };

    // A complete, otherwise-submittable plan: without the re-verification this
    // exact call submits (the suite above proves it on the same page).
    const answers: PlannedAnswer[] = ([
      [idFor("name"), "Ada Lovelace"],
      [idFor("email"), "ada@example.com"],
      [idFor("resume"), "cv-variant-1"],
      [idFor("legal_attestation"), "true"],
      [idFor("background_check_consent"), ""],
      [idFor("talent_pool_opt_in"), "true"],
    ] as Array<[string, string]>).map(([fieldId, value]) => ({
      fieldId,
      value,
      source: "user" as const,
      sourceFactIds: [],
      confidence: 1,
      needsUser: false,
      differsFromApproved: false,
      note: "",
    }));

    const failure = await fillAndSubmit(session, {
      url,
      form: tampered,
      answers,
      files: { [idFor("resume")]: resumePath },
      deps,
    }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DriverError);
    expect((failure as DriverError).kind).toBe("fill");
    // Names the field, so the user can see WHICH question changed.
    expect((failure as DriverError).message).toContain(consent.selector);
    expect((failure as DriverError).message).toContain(consent.labelText);
    // The whole point: a browser that never clicked cannot have submitted.
    expect(await submissionsFor(jobId)).toEqual([]);
  }, 60_000);

  /**
   * The other half of the contract: an untouched page is untouched. The forms
   * above are parsed from the same capture they are submitted against, so this
   * pins the case the mismatch check must NOT break — a legitimately unchanged
   * page still fills and submits — on a page whose fields are all consent-ish.
   */
  it("still fills and submits when the live page matches the reviewed snapshot", async () => {
    const jobId = "consent-nodrift-1";
    const url = `${DEMO_ATS_URL}/consent/jobs/${jobId}`;
    const raw = await capturePage(session, url, deps);
    const form = parseForm(raw);
    expect(form.fields.every((field) => typeof field.identityHash === "string")).toBe(true);

    const idFor = (name: string): string => {
      const field = raw.fields.find((f) => f.name === name);
      if (!field) throw new Error(`no raw field named ${name}`);
      return rawFieldId(field);
    };

    const answers: PlannedAnswer[] = ([
      [idFor("name"), "Ada Lovelace"],
      [idFor("email"), "ada@example.com"],
      [idFor("resume"), "cv-variant-1"],
      [idFor("legal_attestation"), "true"],
      [idFor("background_check_consent"), ""],
      [idFor("talent_pool_opt_in"), "true"],
    ] as Array<[string, string]>).map(([fieldId, value]) => ({
      fieldId,
      value,
      source: "user" as const,
      sourceFactIds: [],
      confidence: 1,
      needsUser: false,
      differsFromApproved: false,
      note: "",
    }));

    const result = await fillAndSubmit(session, {
      url,
      form,
      answers,
      files: { [idFor("resume")]: resumePath },
      deps,
    });

    expect(result.confirmationId).toMatch(/^NR-[0-9a-f]{8}$/);
    const created = (await submissionsFor(jobId)).find((s) => s.id === result.confirmationId);
    expect(created?.fields["legal_attestation"]).toBe("true");
  }, 60_000);
});


// ---------------------------------------------------------------------------
// A page that really CHANGES between review and submit (P6 t6 review, B1).
//
// The suite above simulates drift from the snapshot's side. That is enough to
// exercise the comparison, but it cannot reach the bug the reviewer found: the
// live page turning a control into a different KIND of control under the same
// id, selector and label. So this suite puts a mutating proxy in front of
// demo-ats — it serves the real page unchanged while `capturePage` reads it,
// serves a mutated page when `fillAndSubmit` reads it, and FORWARDS the POST to
// demo-ats, so `/api/submissions` is still the ground truth for "did anything
// reach the site". Every assertion here is on that store, never merely on an
// exception: a refusal that still submitted would be worse than no refusal.
// ---------------------------------------------------------------------------
live("driver against a page that mutates between review and submit", () => {
  // demo-ats's store is process-global and lives as long as the server, so a
  // re-run inside the same server would find its own previous rows and make
  // "nothing reached the site" unfalsifiable. Every job id here is unique to
  // this run.
  const RUN = randomUUID().slice(0, 8);
  const deps = { timeoutMs: 30_000, isNavigationAllowed: ALLOW_ANY };
  let session: BrowserSession;
  let proxy: Server;
  let proxyPort = 0;
  let resumePath: string;
  /** Armed AFTER the capture, so review and submit genuinely see different HTML. */
  let mutate: ((html: string) => string) | null = null;

  beforeAll(async () => {
    session = await openSession();
    const dir = mkdtempSync(path.join(tmpdir(), "careerhq-mutate-"));
    resumePath = path.join(dir, "resume.pdf");
    writeFileSync(resumePath, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF\n");

    proxy = createServer((req, res) => {
      void (async () => {
        const target = `${DEMO_ATS_URL}${req.url ?? "/"}`;
        if (req.method === "POST") {
          // Forwarded verbatim: the multipart body the browser built is what
          // demo-ats stores, so the recorded fields are the posted fields.
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const upstream = await fetch(target, {
            method: "POST",
            headers: { "content-type": req.headers["content-type"] ?? "" },
            body: Buffer.concat(chunks),
          });
          const forwarded = await upstream.text();
          res.writeHead(upstream.status, { "content-type": "text/html" });
          res.end(forwarded);
          return;
        }
        const upstream = await fetch(target);
        const html = await upstream.text();
        res.writeHead(upstream.status, { "content-type": "text/html" });
        res.end(mutate ? mutate(html) : html);
      })().catch((cause: unknown) => {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(String(cause));
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    proxyPort = (proxy.address() as AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    proxy?.close();
  });

  beforeEach(() => {
    mutate = null;
  });

  /** A mutation that silently matched nothing would turn every case below green. */
  function mustReplace(html: string, pattern: RegExp, replacement: string): string {
    if (!pattern.test(html)) throw new Error(`mutation did not match the served page: ${String(pattern)}`);
    return html.replace(pattern, replacement);
  }

  interface Outcome {
    /** The DriverError kind, or null when the driver went through with it. */
    refused: DriverErrorKind | null;
    confirmationId: string | null;
    /** What demo-ats actually stored for this job — the ground truth. */
    recorded: Array<Record<string, string>>;
    message: string;
  }

  /**
   * Review the real page, arm the mutation, then fill and submit against the
   * mutated one. The plan is the consent case verbatim: attestation given,
   * background check DECLINED (`""` — what the review screen commits on untick),
   * talent pool kept.
   */
  async function reviewThenSubmit(jobId: string, mutation: (html: string) => string): Promise<Outcome> {
    const url = `http://localhost:${proxyPort}/consent/jobs/${jobId}`;
    const raw = await capturePage(session, url, deps);
    const form = parseForm(raw);

    const idFor = (name: string): string => {
      const field = raw.fields.find((f) => f.name === name);
      if (!field) throw new Error(`no raw field named ${name}`);
      return rawFieldId(field);
    };

    const answers: PlannedAnswer[] = ([
      [idFor("name"), "Ada Lovelace"],
      [idFor("email"), "ada@example.com"],
      [idFor("resume"), "cv-variant-1"],
      [idFor("legal_attestation"), "true"],
      [idFor("background_check_consent"), ""],
      [idFor("talent_pool_opt_in"), "true"],
    ] as Array<[string, string]>).map(([fieldId, value]) => ({
      fieldId,
      value,
      source: "user" as const,
      sourceFactIds: [],
      confidence: 1,
      needsUser: false,
      differsFromApproved: false,
      note: "",
    }));

    mutate = mutation;
    const outcome = await fillAndSubmit(session, {
      url, form, answers, files: { [idFor("resume")]: resumePath }, deps,
    }).then(
      (result) => ({ refused: null, confirmationId: result.confirmationId, message: "" }),
      (cause: unknown) => ({
        refused: cause instanceof DriverError ? cause.kind : null,
        confirmationId: null,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    );

    return { ...outcome, recorded: (await submissionsFor(jobId)).map((s) => s.fields) };
  }

  /**
   * The reviewer's probe D, verbatim. One attribute changes — `type="checkbox"`
   * becomes `type="hidden"` — and the id, the name, the selector and the label
   * all stay identical, so the field id and the identity hash both still match.
   * The old check never saw the field at all: `plannedFills` dropped it (empty
   * value, not tickable ANY MORE) before the comparison ran, the hidden input
   * kept its `value="true"`, and demo-ats recorded a consent the user declined
   * while the receipt recorded `""`.
   */
  it("refuses when a declined consent box becomes a hidden input under the same selector", async () => {
    const jobId = `consent-kind-swap-${RUN}`;
    const outcome = await reviewThenSubmit(jobId, (html) =>
      mustReplace(
        html,
        /<input type="checkbox" id="background_check_consent"[^>]*>/,
        '<input type="hidden" id="background_check_consent" name="background_check_consent" value="true" />',
      ),
    );

    // Asserted as one object so a regression prints WHAT demo-ats stored.
    expect({ refused: outcome.refused, confirmationId: outcome.confirmationId, recorded: outcome.recorded })
      .toEqual({ refused: "fill", confirmationId: null, recorded: [] });
    expect(outcome.message).toContain("background_check_consent");
  }, 60_000);

  /** Probe E: the same control, gone. A decision the user made has nowhere to land. */
  it("refuses when the consent box the user decided about is removed entirely", async () => {
    const jobId = `consent-removed-${RUN}`;
    const outcome = await reviewThenSubmit(jobId, (html) =>
      mustReplace(html, /<input type="checkbox" id="background_check_consent"[^>]*>/, ""),
    );

    expect({ refused: outcome.refused, confirmationId: outcome.confirmationId, recorded: outcome.recorded })
      .toEqual({ refused: "fill", confirmationId: null, recorded: [] });
    // Names the question the user answered, since the control itself is gone.
    expect(outcome.message).toContain("carrying out a background check");
  }, 60_000);

  /**
   * Probe H, and the reason this refusal is a *fix* rather than a new failure
   * mode: a required field whose id moved was silently not typed, HTML5
   * validation blocked the submit, and `fillAndSubmit` returned
   * `confirmationId: null` — which apps/web parks as NEEDS_RECONCILE, sending a
   * human to reconcile a submission that provably never happened. `kind: "fill"`
   * is pre-click and honest, and the attempt is genuinely retryable — apps/web
   * gives the confirmation back rather than spending it on the refusal.
   */
  it("refuses when a required field's id moves, instead of typing nothing and parking a reconcile", async () => {
    const jobId = `consent-id-shift-${RUN}`;
    const outcome = await reviewThenSubmit(jobId, (html) =>
      mustReplace(html, /id="email"/, 'id="email_address"').replace(/for="email"/, 'for="email_address"'),
    );

    expect({ refused: outcome.refused, confirmationId: outcome.confirmationId, recorded: outcome.recorded })
      .toEqual({ refused: "fill", confirmationId: null, recorded: [] });
    expect(outcome.message).toContain('("Email")');
  }, 60_000);

  /**
   * The half that must not break: through the very same proxy, with the very
   * same plan, an UNMUTATED page still fills and submits — and the declined
   * consent is still absent from the posted body. Without this, "refuse
   * everything" would pass the three cases above.
   */
  it("still fills and submits when the proxy serves the page unchanged", async () => {
    const jobId = `consent-proxy-nodrift-${RUN}`;
    const outcome = await reviewThenSubmit(jobId, (html) => html);

    expect(outcome.refused).toBeNull();
    expect(outcome.confirmationId).toMatch(/^NR-[0-9a-f]{8}$/);
    expect(outcome.recorded).toEqual([{
      name: "Ada Lovelace",
      email: "ada@example.com",
      legal_attestation: "true",
      talent_pool_opt_in: "true",
    }]);
  }, 60_000);
});


// ---------------------------------------------------------------------------
// The navigation guard (P6 fix-wave review, BLOCKING).
//
// `refuseCaptureTarget` ran once, on the submitted URL; `page.goto` then
// followed redirects wherever they led. The reviewer stood up
// `http://evil.test:9099/go` -> 302 -> `http://127.0.0.1:9100/secret` and got
// the secret back in `bodyText`, from a SANDBOX workspace, through the
// allow-listed host. This suite is that probe, as a test.
//
// The load-bearing assertion in every refusal case is `internalHits`: not just
// "we did not return the secret" but "we never asked for it". A guard that
// checks `page.url()` after the fact would pass the first assertion and fail
// this one.
//
// No fake DNS is needed even for the cross-host cases, which is itself a
// property of the fix: the refusal happens on the `Location` HEADER, before
// the next hop is ever resolved or connected to.
// ---------------------------------------------------------------------------
const guarded = describe.skipIf(!browserAvailable);

guarded("the navigation guard follows the policy, not the Location header", () => {
  const SECRET = "DRIVER-TEST-SSRF-SECRET-4b81c2";
  /** `localhost` is the allow-listed host; `127.0.0.1` is the internal one it must not reach. */
  const SANDBOX_LOCALHOST = { workspaceKind: "sandbox", sandboxSiteAllowedHost: "localhost" } as const;

  let session: BrowserSession;
  let internal: Server;
  let redirector: Server;
  let internalPort = 0;
  let redirectorPort = 0;
  let internalHits = 0;

  const deps = (policy = SANDBOX_LOCALHOST): DriverDeps => ({
    timeoutMs: 15_000,
    isNavigationAllowed: (target) => allowsCaptureTarget(target, policy),
  });

  async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  const start = (path: string): string => `http://localhost:${redirectorPort}${path}`;
  const redirect = (res: ServerResponse, location: string): void => {
    res.writeHead(302, { location });
    res.end();
  };
  const html = (res: ServerResponse, body: string): void => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><body>${body}</body></html>`);
  };

  beforeAll(async () => {
    if (!browserAvailable) return;
    internal = createServer((_req, res) => {
      internalHits += 1;
      html(res, `${SECRET}<p>internal only</p>`);
    });
    internalPort = await listen(internal);

    redirector = createServer((req, res) => {
      const internalUrl = `http://127.0.0.1:${internalPort}/secret`;
      switch (req.url) {
        // One hop, straight at the loopback address.
        case "/to-internal": return redirect(res, internalUrl);
        // One hop to a public host this sandbox workspace may not reach.
        case "/to-other-host": return redirect(res, "http://careers.northwind.example/apply");
        // Three hops on the allowed host, then out.
        case "/hop1": return redirect(res, start("/hop2"));
        case "/hop2": return redirect(res, start("/hop3"));
        case "/hop3": return redirect(res, internalUrl);
        // A relative Location, resolved against the hop it came from.
        case "/relative": return redirect(res, "/form");
        // The two renderer-driven forms, which the route layer does see.
        case "/meta":
          return html(res, `<meta http-equiv="refresh" content="0;url=${internalUrl}">landing`);
        case "/js":
          return html(res, `landing<script>location.href=${JSON.stringify(internalUrl)}</script>`);
        case "/legit": return redirect(res, start("/form"));
        case "/form": return html(res, '<h1>Apply</h1><form><input id="email" name="email"></form>');
        default:
          res.writeHead(404);
          return res.end();
      }
    });
    redirectorPort = await listen(redirector);

    session = await openSession();
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    internal?.close();
    redirector?.close();
  });

  beforeEach(() => {
    internalHits = 0;
  });

  it.each([
    ["a 302 from the allow-listed host to a loopback address", "/to-internal"],
    ["a chain of three allowed hops that ends on a loopback address", "/hop1"],
  ])("refuses %s, and never requests it", async (_label, path) => {
    const failure = await capturePage(session, start(path), deps()).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DriverError);
    expect((failure as DriverError).kind).toBe("navigation");
    expect((failure as DriverError).message).toMatch(/not an allowed target/);
    expect((failure as DriverError).message).toContain("127.0.0.1");
    // The whole point. A post-hoc `page.url()` check would leave this at 1.
    expect(internalHits).toBe(0);
  }, 60_000);

  it("refuses a redirect to a public host this sandbox workspace may not reach", async () => {
    const failure = await capturePage(session, start("/to-other-host"), deps()).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DriverError);
    expect((failure as DriverError).kind).toBe("navigation");
    expect((failure as DriverError).message).toContain("careers.northwind.example");
  }, 60_000);

  it("refuses a meta-refresh to a loopback address", async () => {
    // Renderer-initiated, so the route handler DOES see it — unlike a server
    // 30x, which is why the chain walk above exists at all. `capturePage` has
    // usually returned by the time this fires, so the assertion is on the
    // server: the browser must not have fetched it.
    await capturePage(session, start("/meta"), deps()).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(internalHits).toBe(0);
  }, 60_000);

  it("refuses a JS-driven navigation to a loopback address", async () => {
    await capturePage(session, start("/js"), deps()).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(internalHits).toBe(0);
  }, 60_000);

  // The other half of the contract, and the reason the guard walks the chain
  // rather than banning redirects: real ATS pages redirect constantly, and a
  // "fix" that broke them would just move the outage.
  it.each([
    ["an ordinary same-host redirect", "/legit"],
    ["a same-host redirect with a relative Location", "/relative"],
  ])("still follows %s and reports where it landed", async (_label, path) => {
    const page = await capturePage(session, start(path), deps());

    expect(page.url).toBe(start("/form"));
    expect(page.fields.map((field) => field.name)).toContain("email");
    expect(page.bodyText).toContain("Apply");
  }, 60_000);

  it("refuses the submitted URL itself when it is off-policy, before opening a page", async () => {
    const exploding: BrowserSession = {
      newPage: () => Promise.reject(new Error("a page was opened for a URL the policy refused")),
      close: () => Promise.resolve(),
    };
    const failure = await capturePage(exploding, `http://127.0.0.1:${internalPort}/secret`, deps())
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DriverError);
    expect((failure as DriverError).message).toMatch(/not an allowed target/);
  });
});

if (!demoAtsUp || !browserAvailable) {
  console.warn(
    `[driver.test] live browser tests skipped — demo-ats up: ${demoAtsUp} (${DEMO_ATS_URL}), chromium available: ${browserAvailable}`,
  );
}
