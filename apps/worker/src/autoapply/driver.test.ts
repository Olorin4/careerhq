import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { chromium } from "playwright";
import { consentPage, greenhousePage, leverPage, type DemoJob } from "@careerhq/demo-ats";
import { rawPageFromHtml } from "@careerhq/autoapply/testing";
import { detectBlockers, parseForm, rawFieldId, type RawFormPage } from "@careerhq/autoapply";
import type { PlannedAnswer } from "@careerhq/contracts";
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
  capturePage, DriverError, fillAndSubmit, openSession,
  type BrowserSession, type DriverErrorKind,
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
// failure as pre-click (→ FAILED) or ambiguous (→ NEEDS_RECONCILE) by reading
// `name` and `kind` off the thrown error STRUCTURALLY — it takes its driver by
// injection and must not pull `playwright` into its own module graph to run an
// `instanceof`. These two properties are therefore a published contract, not an
// implementation detail: renaming either silently downgrades every provably
// pre-click failure into a human reconciliation task.
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

live("driver against demo-ats", () => {
  const deps = { timeoutMs: 30_000 };
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

  /**
   * The demo-ats store is process-global and shared with apps/web's
   * site-e2e.test.ts, which runs as a separate turbo task against the same
   * server. Neither suite may wipe it or assert on its total size — that race is
   * what made the documented gate reproducible only at TURBO_CONCURRENCY=1.
   * Scope every assertion to the job id this suite submits to instead.
   */
  async function submissionsFor(jobId: string): Promise<Array<{
    id: string; jobId: string; fields: Record<string, string>; files: Array<{ filename: string }>;
  }>> {
    const all = (await (await fetch(`${DEMO_ATS_URL}/api/submissions`)).json()) as Array<{
      id: string; jobId: string; fields: Record<string, string>; files: Array<{ filename: string }>;
    }>;
    return all.filter((submission) => submission.jobId === jobId);
  }

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
});

if (!demoAtsUp || !browserAvailable) {
  console.warn(
    `[driver.test] live browser tests skipped — demo-ats up: ${demoAtsUp} (${DEMO_ATS_URL}), chromium available: ${browserAvailable}`,
  );
}
