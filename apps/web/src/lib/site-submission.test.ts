import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * This suite is browser-free by design — every `SiteDeps.submit` below is a
 * stub, and the driver failures it classifies are reproduced structurally
 * (`FakeDriverError`, `FakeBrowserBusyError`). The ONE exception is the
 * concurrency race at the bottom of the file, which drives the real
 * `withSiteBrowserReservation` because the property under test IS the browser
 * slot's lifetime. Mocking `playwright` — not the slot counter, which stays
 * real — keeps that honest without starting Chromium.
 */
vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(async () => ({
      newPage: () => Promise.reject(new Error("no page in this test")),
      close: async () => undefined,
    })),
  },
  errors: { TimeoutError: class extends Error {} },
}));
import { loadConfig, type AppConfig } from "@careerhq/config";
import type { GenerationResult, InterpretFieldResult, PlannedAnswer } from "@careerhq/contracts";
import { rawFieldId, type RawField, type RawFormPage } from "@careerhq/autoapply";
import type { FallbackResult, GenerateInput, InterpretFieldInput } from "@careerhq/ai";
import {
  applicationEvents, applications, createApplication, createCvVariant, createDb, createFact,
  getActiveConfirmation, getAttempt, getLatestSnapshot, listAttemptsForApplication,
  listEvidenceScreenshotPaths, transitionApplication, updateSnapshotAnswers, workspaces, type Db,
} from "@careerhq/db";
import {
  confirmAndSubmitSite, prepareSiteApplication, previewSiteSubmission, updatePlannedAnswer,
  type PrepareOutcome, type SiteDeps, type SiteSubmitResult,
} from "./site-submission";
import { DEMO_MAX_EVIDENCE_STORE_FILES, ORPHAN_GRACE_MS } from "@careerhq/core/storage";
import { withSiteBrowserReservation } from "./site-driver.js";
import { configureHostBrowserLockClass, resetHostBrowserSlots } from "@careerhq/db";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

/** `payload.host`: the hostname the user retypes, and what the sandbox allow-list names. */
const APPLY_HOST = "demo-ats";

const slugOf = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
/** One requisition per test: `findRequisitionAttempt` is workspace-wide, so URLs must not collide. */
const urlFor = (name: string): string => `http://${APPLY_HOST}:3001/greenhouse/jobs/${slugOf(name)}`;
const requisitionKeyFor = (name: string): string => `${APPLY_HOST}:3001/greenhouse/jobs/${slugOf(name)}`;

const CV_BYTES = Buffer.from("%PDF-1.4 fake cv bytes for the site orchestrator test\n");
const CV_SHA256 = createHash("sha256").update(CV_BYTES).digest("hex");

let db: Db;
let workspaceId: string;
let otherWorkspaceId: string;
/** A sandbox-kind workspace, used to exercise the sandbox host allow-list. */
let sandboxWorkspaceId: string;
let cvVariantId: string;
let cvPath: string;

function config(over: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: url ?? "postgres://u:p@localhost:5432/careerhq",
    SUBMISSIONS_LIVE_COMPANY_SITE: "true",
    SANDBOX_SITE_ALLOWED_HOST: APPLY_HOST,
    ...over,
  });
}

function rawField(over: Partial<RawField> & { name: string }): RawField {
  return {
    selector: `#${over.name}`,
    tag: "input",
    type: "text",
    id: over.name,
    labelText: "",
    nearbyText: "",
    placeholder: "",
    required: false,
    maxLength: null,
    accept: null,
    options: [],
    step: 0,
    ...over,
  };
}

const FIELDS: RawField[] = [
  rawField({ name: "first_name", labelText: "First name", required: true }),
  rawField({ name: "last_name", labelText: "Last name", required: true }),
  rawField({ name: "email", type: "email", labelText: "Email", required: true }),
  rawField({ name: "phone", type: "tel", labelText: "Phone" }),
  rawField({ name: "resume", type: "file", accept: ".pdf,.docx", labelText: "Resume", required: true }),
  rawField({
    name: "work_authorization", tag: "select", type: "",
    labelText: "Are you authorized to work in the United States?", required: true,
    options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
  }),
  rawField({
    name: "why_northwind", tag: "textarea", type: "",
    labelText: "Why do you want to work at Northwind?", required: true,
  }),
  // Unmapped free text: the only field the interpreter has anything to say about.
  rawField({ name: "other_notes", labelText: "Anything else we should know?" }),
  rawField({ name: "utm_source", type: "hidden" }),
];

const fieldId = (name: string): string => rawFieldId(FIELDS.find((f) => f.name === name)!);

function greenhousePage(pageUrl: string, over: Partial<RawFormPage> = {}): RawFormPage {
  return {
    url: pageUrl,
    title: "Senior Backend Engineer at Northwind",
    bodyText: "Apply for Senior Backend Engineer at Northwind. We review every application.",
    rootMarkers: ["data-source=greenhouse", "id=application_form"],
    fields: FIELDS,
    buttons: [{ selector: "#btn_submit", id: "btn_submit", text: "Submit application" }],
    totalSteps: 1,
    ...over,
  };
}

/** A page carrying a reCAPTCHA widget — `detectBlockers`' captcha rule. */
function captchaPage(pageUrl: string): RawFormPage {
  return greenhousePage(pageUrl, {
    rootMarkers: ["data-source=greenhouse", "class=g-recaptcha"],
    bodyText: "Please verify you are human before applying.",
    fields: [rawField({ name: "email", type: "email", labelText: "Email", required: true })],
  });
}

interface SubmitCall {
  url: string;
  answers: PlannedAnswer[];
  files: Record<string, string>;
}

type SubmitBehaviour =
  | { kind: "ok"; confirmationId?: string | null }
  | { kind: "throws"; error?: Error };

/**
 * A `DriverError` exactly as `apps/worker/src/autoapply/driver.ts` constructs
 * one — `name === "DriverError"` plus a string `kind`. That pair is the whole
 * contract `site-submission.ts` classifies on, so reproducing it here keeps this
 * suite browser-free (no `playwright` import) while still exercising the real
 * shape. `driver.test.ts` pins the same contract from the driver's side.
 */
class FakeDriverError extends Error {
  constructor(message: string, readonly kind: string) {
    super(message);
    this.name = "DriverError";
  }
}

/**
 * A `BrowserBusyError` exactly as `apps/worker/src/autoapply/browser-limit.ts`
 * constructs one. Same reasoning as `FakeDriverError` above: `name` is the
 * whole contract, and reproducing it keeps this suite browser-free.
 */
class FakeBrowserBusyError extends Error {
  constructor() {
    super("the auto-apply browser is busy with another application — try again in a moment");
    this.name = "BrowserBusyError";
  }
}

function stubSubmit(calls: SubmitCall[], behaviour: SubmitBehaviour = { kind: "ok" }) {
  return async (args: {
    url: string; answers: PlannedAnswer[]; files: Record<string, string>;
  }): Promise<SiteSubmitResult> => {
    calls.push({ url: args.url, answers: args.answers, files: args.files });
    if (behaviour.kind === "throws") {
      throw behaviour.error ?? new Error("chromium crashed after the submit click");
    }
    const confirmationId = behaviour.confirmationId === undefined ? "NR-1a2b3c4d" : behaviour.confirmationId;
    return {
      confirmationId,
      finalUrl: `${args.url}/thanks`,
      screenshotPath: "/app/var/files/shots/attempt.png",
      pageText: `Thanks for applying! ${confirmationId ? `Confirmation ID: ${confirmationId}` : ""}`,
    };
  };
}

/**
 * The AI tiers are always injected — a test that left one out would reach the
 * real OpenRouter client the moment a key is configured.
 */
const noInterpretation = async (): Promise<FallbackResult<InterpretFieldResult>> => ({
  ok: false, value: null, model: "stub-fast", latencyMs: 1, status: null, error: "not_useful", attempts: [],
});

function aiDeps(over: Partial<SiteDeps>): Partial<SiteDeps> {
  return {
    config: config({ OPENROUTER_API_KEY: "sk-test" }),
    interpret: noInterpretation as SiteDeps["interpret"],
    ...over,
  };
}

function deps(over: Partial<SiteDeps> = {}): SiteDeps {
  return {
    db,
    config: config(),
    capture: async (pageUrl: string) => greenhousePage(pageUrl),
    submit: stubSubmit([]),
    ...over,
  };
}

/** An application walked to READY_FOR_REVIEW through the real guarded transitions. */
async function readyApplication(companyName: string, ws = workspaceId): Promise<string> {
  const app = await createApplication(db, {
    workspaceId: ws, companyName, jobTitle: "Senior Backend Engineer", jobUrl: urlFor(companyName),
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

interface Prepared {
  applicationId: string;
  attemptId: string;
  snapshotId: string;
  blocking: string[];
  url: string;
}

async function prepare(
  companyName: string,
  over: Partial<SiteDeps> = {},
  ws = workspaceId,
  pageUrl = urlFor(companyName),
): Promise<Prepared> {
  const applicationId = await readyApplication(companyName, ws);
  const outcome = await prepareSiteApplication(deps(over), { workspaceId: ws, applicationId, url: pageUrl });
  expect(outcome.status).toBe("ready");
  if (outcome.status !== "ready") throw new Error(`prepare failed: ${JSON.stringify(outcome)}`);
  return {
    applicationId, attemptId: outcome.attemptId, snapshotId: outcome.snapshotId,
    blocking: outcome.blocking, url: pageUrl,
  };
}

/**
 * Settles every field the planner left for the user, the way Task 12's review
 * screen will. `utm_source` is deliberately absent: it is a hidden input, the
 * review grid never renders it, and `requiresUserBeforeSubmit` must not count it.
 */
async function settleBlocking(
  prepared: Prepared,
  over: Partial<SiteDeps> = {},
  ws = workspaceId,
): Promise<void> {
  for (const [name, value] of [
    ["work_authorization", "yes"],
    ["why_northwind", "Because Northwind runs the event-driven systems I have built for five years."],
    ["other_notes", ""],
  ] as const) {
    const result = await updatePlannedAnswer(deps(over), {
      workspaceId: ws, snapshotId: prepared.snapshotId, fieldId: fieldId(name), value,
    });
    expect(result).toEqual({ ok: true });
  }
}

/** Prepare → settle → preview, handing back the plaintext token. */
async function previewed(
  companyName: string,
  over: Partial<SiteDeps> = {},
  ws = workspaceId,
  pageUrl = urlFor(companyName),
): Promise<Prepared & { token: string }> {
  const prepared = await prepare(companyName, over, ws, pageUrl);
  await settleBlocking(prepared, over, ws);
  const outcome = await previewSiteSubmission(deps(over), { workspaceId: ws, attemptId: prepared.attemptId });
  expect(outcome.status).toBe("ok");
  if (outcome.status !== "ok") throw new Error(`preview failed: ${JSON.stringify(outcome)}`);
  return { ...prepared, token: outcome.token };
}


/**
 * This file's own advisory-lock namespace for the host-wide browser cap
 * (packages/db/src/host-lock.ts). The cap is host-wide by design, so without
 * this every browser-driving suite in the monorepo would contend for one slot
 * against a single shared `TEST_DATABASE_URL` — turbo runs the packages' test
 * tasks concurrently — and a refusal here could come from another process's
 * suite rather than from the property under test. Per-file namespaces restore
 * the independence the per-process counter used to give these tests for free.
 */
const hostLockClass = 920_000_000 + Math.floor(Math.random() * 10_000_000);

beforeAll(async () => {
  if (!url) return;
  db = createDb(url);
  await configureHostBrowserLockClass(hostLockClass);

  const dir = mkdtempSync(path.join(tmpdir(), "careerhq-site-cv-"));
  cvPath = path.join(dir, "alex-cv.pdf");
  writeFileSync(cvPath, CV_BYTES);

  /** Everything a workspace needs to plan the fixture form end to end. */
  async function seed(ws: string): Promise<string> {
    const variantId = (await createCvVariant(db, {
      workspaceId: ws, label: "ATS CV", format: "ats", filePath: cvPath, sha256: CV_SHA256,
    })).id;

    const reviewBy = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000);
    const facts = [
      { category: "identity" as const, claim: "Full legal name: Alex Rivera" },
      { category: "contact" as const, claim: "Email: alex.rivera@example.com" },
      { category: "contact" as const, claim: "Phone: +1-555-0142" },
      { category: "contact" as const, claim: "Location: Athens, Greece" },
      { category: "experience" as const, claim: "5 years as a backend engineer building event-driven systems" },
    ];
    for (const fact of facts) await createFact(db, { workspaceId: ws, ...fact, reviewBy });
    // A sensitive fact exists but must never reach an auto-filled answer.
    await createFact(db, {
      workspaceId: ws, category: "authorization", claim: "US work authorization: citizen",
      sensitivity: "sensitive", reviewBy,
    });
    return variantId;
  }

  const [ws] = await db.insert(workspaces).values({ name: `t-site-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;
  const [other] = await db.insert(workspaces)
    .values({ name: `t-site-other-${Date.now()}`, kind: "personal" }).returning();
  otherWorkspaceId = other!.id;
  const [sandbox] = await db.insert(workspaces)
    .values({ name: `t-site-sandbox-${Date.now()}`, kind: "sandbox" }).returning();
  sandboxWorkspaceId = sandbox!.id;

  cvVariantId = await seed(workspaceId);
  await seed(sandboxWorkspaceId);
});

afterAll(async () => {
  if (!url) return;
  await resetHostBrowserSlots();
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(workspaces).where(eq(workspaces.id, otherWorkspaceId));
  await db.delete(workspaces).where(eq(workspaces.id, sandboxWorkspaceId));
  await db.$client.end();
});

d("prepareSiteApplication", () => {
  it("plans deterministic answers from the fact bank and leaves the sensitive field for the user", async () => {
    const prepared = await prepare("Plan Co");

    const snapshot = await getLatestSnapshot(db, prepared.attemptId);
    expect(snapshot?.id).toBe(prepared.snapshotId);
    const byId = new Map((snapshot!.plannedAnswers as PlannedAnswer[]).map((a) => [a.fieldId, a]));

    expect(byId.get(fieldId("email"))).toMatchObject({
      value: "alex.rivera@example.com", source: "profile", needsUser: false,
    });
    expect(byId.get(fieldId("first_name"))).toMatchObject({ value: "Alex", source: "profile" });
    expect(byId.get(fieldId("last_name"))).toMatchObject({ value: "Rivera", source: "profile" });
    expect(byId.get(fieldId("resume"))).toMatchObject({ value: cvVariantId, source: "document" });

    const workAuth = byId.get(fieldId("work_authorization"))!;
    expect(workAuth.needsUser).toBe(true);
    expect(workAuth.source).not.toBe("ai");
    expect(workAuth.value).toBe("");

    // Every field the user must settle is reported, optional ones included …
    expect(prepared.blocking).toEqual(expect.arrayContaining([
      fieldId("work_authorization"), fieldId("why_northwind"), fieldId("other_notes"),
    ]));
    // … but never the hidden tracking input: the review grid does not render it,
    // so counting it would make this form permanently un-previewable. Its planned
    // answer still exists and still says the planner could not settle it.
    expect(prepared.blocking).not.toContain(fieldId("utm_source"));
    expect(
      (snapshot!.plannedAnswers as PlannedAnswer[]).find((a) => a.fieldId === fieldId("utm_source")),
    ).toMatchObject({ needsUser: true });
    expect((await getAttempt(db, prepared.attemptId))?.status).toBe("DRAFT");
  });

  it("pauses on a blocker: captcha → blocked outcome and an attempt parked in BLOCKED", async () => {
    const applicationId = await readyApplication("Captcha Co");
    const outcome = await prepareSiteApplication(
      deps({ capture: async (pageUrl: string) => captchaPage(pageUrl) }),
      { workspaceId, applicationId, url: urlFor("Captcha Co") },
    );

    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") return;
    expect(outcome.kind).toBe("captcha");
    // User-legible: it says what to do, not just which rule matched.
    expect(outcome.detail).toMatch(/browser/i);

    const attempts = await listAttemptsForApplication(db, applicationId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("BLOCKED");
    expect(attempts[0]?.failureReason).toMatch(/captcha/i);
    // A paused attempt captured nothing to submit.
    expect(await getLatestSnapshot(db, attempts[0]!.id)).toBeNull();
  });

  it("reports a duplicate requisition, and honours an explicit override with an audit event", async () => {
    const first = await previewed("Duplicate Co");
    const submitted = await confirmAndSubmitSite(deps(), {
      workspaceId, attemptId: first.attemptId, presentedToken: first.token, retypedTarget: APPLY_HOST,
    });
    expect(submitted.status).toBe("submitted");

    const applicationId = await readyApplication("Duplicate Second Co");
    const duplicate = await prepareSiteApplication(deps(), { workspaceId, applicationId, url: first.url });
    expect(duplicate).toEqual({ status: "duplicate", existingApplicationId: first.applicationId });
    // Nothing was created for the refused prepare.
    expect(await listAttemptsForApplication(db, applicationId)).toHaveLength(0);

    const overridden = await prepareSiteApplication(deps(), {
      workspaceId, applicationId, url: first.url, overrideDuplicate: true,
    });
    expect(overridden.status).toBe("ready");

    const events = await db.select().from(applicationEvents)
      .where(eq(applicationEvents.applicationId, applicationId));
    const override = events.find((e) => (e.payload as { duplicateOverride?: boolean } | null)?.duplicateOverride);
    expect(override?.trigger).toBe("user");
    expect((override?.payload as { requisitionKey?: string } | null)?.requisitionKey)
      .toBe(requisitionKeyFor("Duplicate Co"));
  });

  it("never asks a model about a sensitive field, and never drafts a hidden field", async () => {
    const interpreted: string[] = [];
    const generated: string[] = [];

    const interpret = async (input: InterpretFieldInput): Promise<FallbackResult<InterpretFieldResult>> => {
      interpreted.push(input.label);
      // A model that would happily claim a sensitive mapping. The orchestrator
      // must treat that as "the user answers this", never as a licence to fill.
      return {
        ok: true, value: { canonicalField: "work_authorization", confidence: 0.95 },
        model: "stub-fast", latencyMs: 1, status: 200, error: null, attempts: [],
      };
    };
    const generate = async (input: GenerateInput): Promise<FallbackResult<GenerationResult>> => {
      generated.push(input.question ?? "");
      return {
        ok: true,
        value: {
          answer: "I have built event-driven systems for five years.",
          factIds: input.facts.map((f) => f.id), confidence: 0.9, unsupportedClaims: [],
        },
        model: "stub-writer", latencyMs: 1, status: 200, error: null, attempts: [],
      };
    };

    const prepared = await prepare("Sensitive Co", aiDeps({
      interpret: interpret as SiteDeps["interpret"],
      generate: generate as SiteDeps["generate"],
    }));

    const asked = [...interpreted, ...generated].join(" | ");
    expect(asked).not.toMatch(/authorized to work/i);
    expect(asked).not.toMatch(/utm_source/i);
    // Only the unmapped free-text field is worth interpreting; only the
    // screening question is worth drafting.
    expect(interpreted).toEqual(["Anything else we should know?"]);
    expect(generated).toEqual(["Why do you want to work at Northwind?"]);

    const byId = new Map(
      ((await getLatestSnapshot(db, prepared.attemptId))!.plannedAnswers as PlannedAnswer[])
        .map((a) => [a.fieldId, a]),
    );
    expect(byId.get(fieldId("work_authorization"))).toMatchObject({ source: "user", needsUser: true, value: "" });
    expect(byId.get(fieldId("utm_source"))).toMatchObject({ needsUser: true });
    expect(byId.get(fieldId("utm_source"))?.source).not.toBe("ai");
    // The field the interpreter mapped onto a sensitive category is now the
    // user's too — an AI mapping can add a block, never remove one.
    expect(byId.get(fieldId("other_notes"))).toMatchObject({ needsUser: true });
    expect(byId.get(fieldId("other_notes"))?.source).not.toBe("ai");
  });

  /**
   * A consent-only-by-LABEL question that the sensitivity ruleset does not
   * know: "Please describe any convictions" matches CONSENT_ONLY_LABEL_RE's
   * `convict` but not SENSITIVE_TERMS' `\bconvicted\b`. Nothing about it may
   * reach a model — not the interpreter, not the writer — and it must never
   * come back with `source: "ai"`. Both the planner's rule 1a and this
   * module's own `draftable` guard have to hold for that, and they are checked
   * independently on purpose.
   */
  it("never asks a model about a consent-only-by-label field, and never drafts one", async () => {
    const interpreted: string[] = [];
    const generated: string[] = [];

    const consentFields: RawField[] = [
      rawField({ name: "email", type: "email", labelText: "Email", required: true }),
      rawField({ name: "resume", type: "file", accept: ".pdf,.docx", labelText: "Resume", required: true }),
      rawField({
        name: "convictions", tag: "textarea", type: "",
        labelText: "Please describe any convictions", required: true,
      }),
      // A genuine screening question, so this test cannot pass vacuously: the
      // AI pass must actually have run and drafted something.
      rawField({
        name: "why_northwind", tag: "textarea", type: "",
        labelText: "Why do you want to work at Northwind?", required: true,
      }),
    ];

    const interpret = async (input: InterpretFieldInput): Promise<FallbackResult<InterpretFieldResult>> => {
      interpreted.push(input.label);
      return {
        ok: true, value: { canonicalField: "screening_question", confidence: 0.95 },
        model: "stub-fast", latencyMs: 1, status: 200, error: null, attempts: [],
      };
    };
    const generate = async (input: GenerateInput): Promise<FallbackResult<GenerationResult>> => {
      generated.push(input.question ?? "");
      return {
        ok: true,
        value: {
          answer: "Nothing to declare.",
          factIds: input.facts.map((f) => f.id), confidence: 0.95, unsupportedClaims: [],
        },
        model: "stub-writer", latencyMs: 1, status: 200, error: null, attempts: [],
      };
    };

    const prepared = await prepare("Consent Label Co", aiDeps({
      capture: async (pageUrl: string) => greenhousePage(pageUrl, { fields: consentFields }),
      interpret: interpret as SiteDeps["interpret"],
      generate: generate as SiteDeps["generate"],
    }));

    // The AI pass really ran — the ordinary screening question was drafted …
    expect(generated).toEqual(["Why do you want to work at Northwind?"]);
    // … and nothing about the consent question was ever put to a model.
    expect([...interpreted, ...generated].join(" | ")).not.toMatch(/conviction/i);

    const idOf = (name: string): string => rawFieldId(consentFields.find((f) => f.name === name)!);
    const byId = new Map(
      ((await getLatestSnapshot(db, prepared.attemptId))!.plannedAnswers as PlannedAnswer[])
        .map((a) => [a.fieldId, a]),
    );
    expect(byId.get(idOf("convictions"))).toMatchObject({ source: "user", needsUser: true, value: "" });
    expect(byId.get(idOf("convictions"))?.source).not.toBe("ai");
    expect(prepared.blocking).toContain(idOf("convictions"));
    // The control field did get an AI draft, so "no model was asked" above is
    // a statement about this field, not about the pass as a whole.
    expect(byId.get(idOf("why_northwind"))?.source).toBe("ai");
  });

  it("marks an AI draft as such and clears it for review", async () => {
    const generate = async (input: GenerateInput): Promise<FallbackResult<GenerationResult>> => ({
      ok: true,
      value: {
        answer: "Northwind's event-driven platform is what I have spent five years building.",
        factIds: input.facts.map((f) => f.id), confidence: 0.85, unsupportedClaims: [],
      },
      model: "stub-writer", latencyMs: 1, status: 200, error: null, attempts: [],
    });
    const prepared = await prepare("AI Draft Co", aiDeps({
      generate: generate as SiteDeps["generate"],
    }));

    const answers = (await getLatestSnapshot(db, prepared.attemptId))!.plannedAnswers as PlannedAnswer[];
    const draft = answers.find((a) => a.fieldId === fieldId("why_northwind"))!;
    expect(draft.source).toBe("ai");
    expect(draft.needsUser).toBe(false);
    expect(draft.note).toMatch(/ai/i);
    expect(draft.sourceFactIds.length).toBeGreaterThan(0);
  });

  it("leaves an ungrounded AI answer for the user instead of filling it", async () => {
    const generate = async (): Promise<FallbackResult<GenerationResult>> => ({
      ok: true,
      // Cites nothing and admits an unsupported claim: P3 validation rejects it.
      value: {
        answer: "I led the Northwind acquisition.", factIds: [], confidence: 0.95,
        unsupportedClaims: ["led the Northwind acquisition"],
      },
      model: "stub-writer", latencyMs: 1, status: 200, error: null, attempts: [],
    });
    const prepared = await prepare("Ungrounded Co", aiDeps({
      generate: generate as SiteDeps["generate"],
    }));

    const answers = (await getLatestSnapshot(db, prepared.attemptId))!.plannedAnswers as PlannedAnswer[];
    const draft = answers.find((a) => a.fieldId === fieldId("why_northwind"))!;
    expect(draft.source).not.toBe("ai");
    expect(draft.needsUser).toBe(true);
    expect(draft.value).toBe("");
  });

  it("falls back to the deterministic plan when the AI pass blows up", async () => {
    const generate = async (): Promise<FallbackResult<GenerationResult>> => {
      throw new Error("openrouter is down");
    };
    const prepared = await prepare("AI Outage Co", aiDeps({
      generate: generate as SiteDeps["generate"],
    }));

    const answers = (await getLatestSnapshot(db, prepared.attemptId))!.plannedAnswers as PlannedAnswer[];
    expect(answers.find((a) => a.fieldId === fieldId("email"))?.value).toBe("alex.rivera@example.com");
    expect(answers.find((a) => a.fieldId === fieldId("why_northwind"))).toMatchObject({ needsUser: true });
  });

  it("refuses an application from another workspace", async () => {
    const applicationId = await readyApplication("Scoped Co");
    const outcome = await prepareSiteApplication(deps(), {
      workspaceId: otherWorkspaceId, applicationId, url: urlFor("Scoped Co"),
    });
    expect(outcome.status).toBe("failed");
  });

  // -------------------------------------------------------------------------
  // Capture-target gating (P6 task-2 review, BLOCKING 2).
  //
  // `prepareSiteApplication` drives a REAL headless Chromium at a
  // caller-supplied URL, and the whole prepare step is reachable by an
  // anonymous visitor on the hosted demo. Before this gate the sandbox
  // allow-list was consulted only at *confirm* time, so the reviewer proved
  // that `file:///etc/passwd` came back in `bodyText` and that
  // `http://169.254.169.254/latest/meta-data/` was navigated with DEMO_MODE
  // and SANDBOX_FORCE_SAFE both ON.
  //
  // Every assertion below is on `captured` — "the browser was never pointed
  // at this" — not merely on the outcome status: a refusal that still
  // navigated first would be no fix at all.
  // -------------------------------------------------------------------------

  interface RefusalProbe { outcome: PrepareOutcome; captured: string[] }

  async function probePrepare(
    companyName: string,
    pageUrl: string,
    over: Partial<SiteDeps> = {},
    ws = workspaceId,
  ): Promise<RefusalProbe> {
    const captured: string[] = [];
    const applicationId = await readyApplication(companyName, ws);
    const outcome = await prepareSiteApplication(
      deps({
        capture: async (target: string) => {
          captured.push(target);
          return greenhousePage(target);
        },
        ...over,
      }),
      { workspaceId: ws, applicationId, url: pageUrl },
    );
    return { outcome, captured };
  }

  it.each([
    ["Local File Co", "file:///etc/passwd"],
    ["Local File Authority Co", "file://localhost/etc/passwd"],
    ["Javascript Co", "javascript:fetch('http://169.254.169.254/latest/meta-data/')"],
    ["Data Url Co", "data:text/html,<script>alert(1)</script>"],
  ])("never opens a non-http(s) URL (%s): %s", async (companyName, target) => {
    const { outcome, captured } = await probePrepare(companyName, target);
    expect(captured).toEqual([]);
    expect(outcome).toMatchObject({ status: "failed" });
    if (outcome.status !== "failed") return;
    expect(outcome.reason).toMatch(/http\(s\)/);
  });

  it("never opens the cloud metadata endpoint, with demo mode and force-safe both on", async () => {
    const { outcome, captured } = await probePrepare(
      "Metadata Co",
      "http://169.254.169.254/latest/meta-data/",
      { config: config({ DEMO_MODE: "true", SANDBOX_FORCE_SAFE: "true" }) },
      sandboxWorkspaceId,
    );
    expect(captured).toEqual([]);
    expect(outcome).toMatchObject({ status: "failed" });
  });

  it("never opens an internal address even in a personal workspace with every demo switch off", async () => {
    // Not a demo-only rule: a self-hosted install must not be usable as an
    // SSRF proxy for its own network either.
    const { outcome, captured } = await probePrepare(
      "Private Range Co", "http://10.0.0.5:8080/greenhouse/jobs/private",
    );
    expect(captured).toEqual([]);
    expect(outcome).toMatchObject({ status: "failed" });
    if (outcome.status !== "failed") return;
    expect(outcome.reason).toMatch(/internal network/);
  });

  it("refuses a public host that is not the sandbox host when SANDBOX_FORCE_SAFE forces the sandbox path", async () => {
    // The workspace row is PERSONAL — only the forced kind can block this, so
    // this pins that prepare uses the same derivation confirm does.
    const { outcome, captured } = await probePrepare(
      "Forced Prepare Co",
      "https://careers.northwind.example/greenhouse/jobs/forced",
      { config: config({ SANDBOX_FORCE_SAFE: "true" }) },
    );
    expect(captured).toEqual([]);
    expect(outcome).toMatchObject({ status: "failed" });
    if (outcome.status !== "failed") return;
    expect(outcome.reason).toContain(APPLY_HOST);
  });

  it("still opens the configured sandbox host — the demo flow itself must keep working", async () => {
    const pageUrl = urlFor("Sandbox Allowed Co");
    const { outcome, captured } = await probePrepare(
      "Sandbox Allowed Co", pageUrl,
      { config: config({ DEMO_MODE: "true", SANDBOX_FORCE_SAFE: "true" }) },
      sandboxWorkspaceId,
    );
    expect(captured).toEqual([pageUrl]);
    expect(outcome.status).toBe("ready");
  });

  it("still opens an ordinary public host for a personal workspace with force-safe off", async () => {
    const pageUrl = "https://careers.northwind.example/greenhouse/jobs/personal-ok";
    const { outcome, captured } = await probePrepare("Personal Public Co", pageUrl);
    expect(captured).toEqual([pageUrl]);
    expect(outcome.status).toBe("ready");
  });
});

d("updatePlannedAnswer", () => {
  it("records the user's own value and clears the needs-you flag", async () => {
    const prepared = await prepare("Edit Co");
    const result = await updatePlannedAnswer(deps(), {
      workspaceId, snapshotId: prepared.snapshotId, fieldId: fieldId("work_authorization"), value: "yes",
    });
    expect(result).toEqual({ ok: true });

    const answers = (await getLatestSnapshot(db, prepared.attemptId))!.plannedAnswers as PlannedAnswer[];
    expect(answers.find((a) => a.fieldId === fieldId("work_authorization"))).toMatchObject({
      value: "yes", source: "user", confidence: 1, needsUser: false,
    });
  });

  it("refuses to edit a file field — the CV is chosen elsewhere, not typed here", async () => {
    const prepared = await prepare("File Edit Co");
    const result = await updatePlannedAnswer(deps(), {
      workspaceId, snapshotId: prepared.snapshotId, fieldId: fieldId("resume"), value: "/etc/passwd",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/file/i);
  });

  it("refuses an unknown field and a snapshot from another workspace", async () => {
    const prepared = await prepare("Unknown Field Co");
    expect((await updatePlannedAnswer(deps(), {
      workspaceId, snapshotId: prepared.snapshotId, fieldId: "not-a-field", value: "x",
    })).ok).toBe(false);
    expect((await updatePlannedAnswer(deps(), {
      workspaceId: otherWorkspaceId, snapshotId: prepared.snapshotId, fieldId: fieldId("phone"), value: "x",
    })).ok).toBe(false);
  });
});

d("previewSiteSubmission", () => {
  it("refuses while a field still needs the user, naming the labels", async () => {
    const prepared = await prepare("Unsettled Co");
    const outcome = await previewSiteSubmission(deps(), { workspaceId, attemptId: prepared.attemptId });
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") return;
    expect(outcome.reason).toMatch(/authorized to work/i);
    expect((await getAttempt(db, prepared.attemptId))?.status).toBe("DRAFT");
  });

  it("pins the fingerprint, stores only the token hash, and describes exactly what will be typed", async () => {
    const prepared = await prepare("Preview Co");
    await settleBlocking(prepared);
    const outcome = await previewSiteSubmission(deps(), { workspaceId, attemptId: prepared.attemptId });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.payload.host).toBe(APPLY_HOST);
    expect(outcome.payload.url).toBe(prepared.url);
    expect(outcome.payload.requisitionKey).toBe(requisitionKeyFor("Preview Co"));
    expect(outcome.payload.applicationId).toBe(prepared.applicationId);
    expect(outcome.payload.attachments).toEqual([
      { fieldId: fieldId("resume"), filename: "ATS-CV.pdf", sha256: CV_SHA256 },
    ]);
    expect(outcome.payload.answers.find((a) => a.fieldId === fieldId("email"))?.value)
      .toBe("alex.rivera@example.com");
    expect(outcome.token).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(outcome.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const attempt = await getAttempt(db, prepared.attemptId);
    expect(attempt?.status).toBe("PENDING_CONFIRMATION");
    expect(attempt?.payloadFingerprint).toBe(outcome.fingerprint);
    const confirmation = await getActiveConfirmation(db, prepared.attemptId);
    expect(confirmation?.tokenHash).not.toBe(outcome.token);
    expect(confirmation?.payloadFingerprint).toBe(outcome.fingerprint);
  });
});

d("prepareSiteApplication — the capture target policy", () => {
  /**
   * The policy has to travel WITH the URL, not merely ahead of it: `page.goto`
   * follows redirects, so a gate that ran once on `args.url` left a 302 from an
   * allow-listed host to `127.0.0.1` captured and returned in `bodyText` (P6
   * fix-wave review, BLOCKING). This pins the seam — the driver's per-hop use
   * of what arrives here is pinned in apps/worker's driver.test.ts.
   */
  it("hands capture the same policy object it gated the URL with", async () => {
    let seen: { workspaceKind: string; sandboxSiteAllowedHost: string } | null = null;
    await prepare("Policy Passed Co", {
      config: config({ SANDBOX_FORCE_SAFE: "true" }),
      capture: async (pageUrl: string, policy) => {
        seen = policy;
        return greenhousePage(pageUrl);
      },
    });

    expect(seen).toEqual({ workspaceKind: "sandbox", sandboxSiteAllowedHost: APPLY_HOST });
  });

  it("refuses an internal target before a browser is ever asked for", async () => {
    let captureCalls = 0;
    const applicationId = await readyApplication("Never Captured Co");
    const outcome = await prepareSiteApplication(
      deps({ capture: async (pageUrl: string) => { captureCalls += 1; return greenhousePage(pageUrl); } }),
      { workspaceId, applicationId, url: "http://169.254.169.254/latest/meta-data/" },
    );

    expect(outcome).toEqual({
      status: "failed", reason: "that address is on an internal network and cannot be opened",
    });
    expect(captureCalls).toBe(0);
    expect(await listAttemptsForApplication(db, applicationId)).toHaveLength(0);
  });
});

d("confirmAndSubmitSite", () => {
  it("submits once, records both receipts, and moves the application to SUBMITTED", async () => {
    const calls: SubmitCall[] = [];
    const prepared = await previewed("Happy Co");

    const outcome = await confirmAndSubmitSite(deps({ submit: stubSubmit(calls) }), {
      workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST,
    });

    expect(outcome).toEqual({
      status: "submitted", confirmationId: "NR-1a2b3c4d", finalUrl: `${prepared.url}/thanks`,
      screenshotPath: "/app/var/files/shots/attempt.png",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(prepared.url);
    expect(calls[0]?.files).toEqual({ [fieldId("resume")]: cvPath });

    const attempt = await getAttempt(db, prepared.attemptId);
    expect(attempt?.status).toBe("SUBMITTED");
    expect((attempt?.pendingReceipt as { channel: string }).channel).toBe("company_site");
    const receipt = attempt?.confirmedReceipt as {
      confirmationId: string; finalUrl: string; screenshotPath: string; pageTextExcerpt: string;
    };
    expect(receipt.confirmationId).toBe("NR-1a2b3c4d");
    expect(receipt.screenshotPath).toBe("/app/var/files/shots/attempt.png");
    expect(receipt.pageTextExcerpt.length).toBeLessThanOrEqual(500);

    const [application] = await db.select().from(applications).where(eq(applications.id, prepared.applicationId));
    expect(application?.state).toBe("SUBMITTED");

    // The token is spent: a replay of the same confirm cannot submit twice.
    const replay = await confirmAndSubmitSite(deps({ submit: stubSubmit(calls) }), {
      workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST,
    });
    expect(replay.status).toBe("blocked");
    expect(calls).toHaveLength(1);
  });

  it("blocks a confirm whose answers changed after the preview → fingerprint_mismatch", async () => {
    const calls: SubmitCall[] = [];
    const prepared = await previewed("Tampered Co");

    const snapshot = await getLatestSnapshot(db, prepared.attemptId);
    const answers = (snapshot!.plannedAnswers as PlannedAnswer[]).map((a) =>
      a.fieldId === fieldId("email") ? { ...a, value: "someone.else@example.com" } : a);
    await updateSnapshotAnswers(db, prepared.snapshotId, answers);

    const outcome = await confirmAndSubmitSite(deps({ submit: stubSubmit(calls) }), {
      workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST,
    });
    expect(outcome).toMatchObject({ status: "blocked", code: "fingerprint_mismatch" });
    expect(calls).toHaveLength(0);
  });

  it("blocks a confirm whose retyped host does not match → target_mismatch", async () => {
    const calls: SubmitCall[] = [];
    const prepared = await previewed("Mistyped Co");
    const outcome = await confirmAndSubmitSite(deps({ submit: stubSubmit(calls) }), {
      workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token,
      retypedTarget: "careers.northwind.example",
    });
    expect(outcome).toMatchObject({ status: "blocked", code: "target_mismatch" });
    expect(calls).toHaveLength(0);
    expect((await getAttempt(db, prepared.attemptId))?.status).toBe("PENDING_CONFIRMATION");
  });

  it("blocks while the env gate is off, leaving the preview intact → gate_closed", async () => {
    const calls: SubmitCall[] = [];
    const prepared = await previewed("Gated Co");

    const outcome = await confirmAndSubmitSite(
      deps({ config: config({ SUBMISSIONS_LIVE_COMPANY_SITE: "false" }), submit: stubSubmit(calls) }),
      { workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST },
    );
    expect(outcome).toMatchObject({ status: "blocked", code: "gate_closed" });
    expect(calls).toHaveLength(0);

    const attempt = await getAttempt(db, prepared.attemptId);
    expect(attempt?.status).toBe("PENDING_CONFIRMATION");
    expect(attempt?.pendingReceipt).toBeNull();
    expect((await getActiveConfirmation(db, prepared.attemptId))?.consumedAt ?? null).toBeNull();

    // Nothing was burned: the same token still works once the gate opens.
    const retried = await confirmAndSubmitSite(deps({ submit: stubSubmit(calls) }), {
      workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST,
    });
    expect(retried.status).toBe("submitted");
  });

  it("blocks when the application drifted out of READY_FOR_REVIEW → application_not_ready, nothing clicked", async () => {
    const calls: SubmitCall[] = [];
    const prepared = await previewed("Drifted Co");
    await db.update(applications).set({ state: "PREPARING" }).where(eq(applications.id, prepared.applicationId));

    const outcome = await confirmAndSubmitSite(deps({ submit: stubSubmit(calls) }), {
      workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST,
    });
    expect(outcome).toMatchObject({ status: "blocked", code: "application_not_ready" });
    expect(calls).toHaveLength(0);
    expect((await getAttempt(db, prepared.attemptId))?.status).toBe("PENDING_CONFIRMATION");
  });

  it("blocks a sandbox workspace applying to a host outside the allow-list → sandbox_blocked", async () => {
    const calls: SubmitCall[] = [];
    // A sandbox workspace can no longer even PREPARE against a host outside
    // the allow-list (that gap was P6 task-2's BLOCKING 2), so the confirm-time
    // gate is exercised the way it can still be reached in production: the
    // attempt was prepared while APPLY_HOST was allowed, and the allow-list
    // narrowed underneath it before the human confirmed. The gate must catch
    // that on its own, without help from the prepare-time layer.
    const prepared = await previewed(
      "Sandbox Co", { submit: stubSubmit(calls) }, sandboxWorkspaceId,
    );

    const outcome = await confirmAndSubmitSite(deps({
      config: config({ SANDBOX_SITE_ALLOWED_HOST: "some-other-ats" }), submit: stubSubmit(calls),
    }), {
      workspaceId: sandboxWorkspaceId, attemptId: prepared.attemptId,
      presentedToken: prepared.token, retypedTarget: APPLY_HOST,
    });
    expect(outcome).toMatchObject({ status: "blocked", code: "sandbox_blocked" });

    // Nothing was typed and nothing was burned: the driver was never reached,
    // the attempt is still confirmable, and the token is still unconsumed.
    expect(calls).toHaveLength(0);
    const attempt = await getAttempt(db, prepared.attemptId);
    expect(attempt?.status).toBe("PENDING_CONFIRMATION");
    expect(attempt?.pendingReceipt).toBeNull();
    expect((await getActiveConfirmation(db, prepared.attemptId))?.consumedAt ?? null).toBeNull();
  });

  // Belt-and-braces (spec P6 §3): SANDBOX_FORCE_SAFE is an independent hard
  // switch, not a DEMO_MODE alias — it must sandbox-block a PERSONAL
  // workspace's live-looking submit, proving the gate input's workspaceKind
  // is actually forced rather than merely read from the (personal) workspace row.
  it("forces the sandbox path for a PERSONAL workspace when SANDBOX_FORCE_SAFE is set → sandbox_blocked, nothing clicked, token unburned", async () => {
    const calls: SubmitCall[] = [];
    const outsideUrl = "http://careers.northwind.example/greenhouse/jobs/force-safe-co";
    const outsideHost = "careers.northwind.example";

    const prepared = await previewed(
      "Force Safe Co", { submit: stubSubmit(calls) }, workspaceId, outsideUrl,
    );

    const outcome = await confirmAndSubmitSite(deps({
      config: config({ SANDBOX_FORCE_SAFE: "true" }), submit: stubSubmit(calls),
    }), {
      workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: outsideHost,
    });
    expect(outcome).toMatchObject({ status: "blocked", code: "sandbox_blocked" });

    // Nothing was typed and nothing was burned: the driver was never reached,
    // the attempt is still confirmable, and the token is still unconsumed.
    expect(calls).toHaveLength(0);
    const attempt = await getAttempt(db, prepared.attemptId);
    expect(attempt?.status).toBe("PENDING_CONFIRMATION");
    expect((await getActiveConfirmation(db, prepared.attemptId))?.consumedAt ?? null).toBeNull();
  });

  // Guard: the exact same PERSONAL-workspace + off-allow-list-host case must
  // NOT be sandbox-blocked with the flag off — proving the flag, not
  // something else about the fixture, is what blocked the test above.
  it("does not sandbox-block the same personal-workspace case when SANDBOX_FORCE_SAFE is false", async () => {
    const calls: SubmitCall[] = [];
    const outsideUrl = "http://careers.northwind.example/greenhouse/jobs/not-forced-co";
    const outsideHost = "careers.northwind.example";

    const prepared = await previewed(
      "Not Forced Co", { submit: stubSubmit(calls) }, workspaceId, outsideUrl,
    );

    const outcome = await confirmAndSubmitSite(deps({
      config: config({ SANDBOX_FORCE_SAFE: "false" }), submit: stubSubmit(calls),
    }), {
      workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: outsideHost,
    });
    expect(outcome.status).toBe("submitted");
  });

  /**
   * The confirm-time half of the redirect fix (P6 fix-wave review, BLOCKING).
   *
   * `payload.url` is `form.url`, which is where the CAPTURE landed — so before
   * the fix a 302 could make it an internal address, and `confirmAndSubmitSite`
   * would then type the user's CV and answers into that host and upload the
   * files there. A personal workspace has NO host check in the gate matrix at
   * all (`sandboxTargetAllowed` is only consulted for sandbox workspaces), so
   * this refusal is the only thing standing there.
   *
   * The capture stub fakes the landing directly rather than a real redirect —
   * the driver's own guard is what stops the redirect (see apps/worker's
   * driver.test.ts "the navigation guard" suite); this pins the backstop that
   * has to hold even if that guard ever fails.
   */
  it("refuses a confirm whose captured URL is off-policy → target_refused, token unburned", async () => {
    const calls: SubmitCall[] = [];
    const landed = "http://169.254.169.254/latest/meta-data/";
    const prepared = await previewed("Redirected Co", {
      capture: async () => greenhousePage(landed),
    });

    const outcome = await confirmAndSubmitSite(deps({ submit: stubSubmit(calls) }), {
      workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token,
      retypedTarget: "169.254.169.254",
    });

    expect(outcome).toMatchObject({ status: "blocked", code: "target_refused" });
    if (outcome.status !== "blocked") return;
    expect(outcome.reason).toMatch(/internal network/);

    // Before `beginSubmission`, like every other harmless failure: nothing was
    // typed, the attempt is untouched and the token is still spendable.
    expect(calls).toHaveLength(0);
    const attempt = await getAttempt(db, prepared.attemptId);
    expect(attempt?.status).toBe("PENDING_CONFIRMATION");
    expect(attempt?.pendingReceipt).toBeNull();
    expect((await getActiveConfirmation(db, prepared.attemptId))?.consumedAt ?? null).toBeNull();
  });

  it("hands the submit driver the same policy it gated the target with", async () => {
    let seen: { workspaceKind: string; sandboxSiteAllowedHost: string } | null = null;
    const prepared = await previewed("Policy Carried Co");

    const outcome = await confirmAndSubmitSite(deps({
      config: config({ SANDBOX_FORCE_SAFE: "true" }),
      submit: async (args) => {
        seen = args.policy;
        return {
          confirmationId: "NR-1a2b3c4d", finalUrl: `${args.url}/thanks`,
          screenshotPath: "/app/var/files/shots/attempt.png", pageText: "Thanks",
        };
      },
    }), {
      workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST,
    });

    expect(outcome.status).toBe("submitted");
    // SANDBOX_FORCE_SAFE forces the sandbox path, and the driver must be told
    // that — not the workspace's raw kind — or its per-hop guard would be
    // looser than the gate that let the attempt through.
    expect(seen).toEqual({ workspaceKind: "sandbox", sandboxSiteAllowedHost: APPLY_HOST });
  });

  it("refuses before the token burns when no browser can start → driver_unavailable", async () => {
    const calls: SubmitCall[] = [];
    const prepared = await previewed("No Chromium Co");

    const probeDriver = async (): Promise<void> => {
      throw new Error("browserType.launch: Executable doesn't exist at /ms-playwright/chromium/headless_shell");
    };
    const outcome = await confirmAndSubmitSite(deps({ probeDriver, submit: stubSubmit(calls) }), {
      workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST,
    });
    expect(outcome).toMatchObject({ status: "blocked", code: "driver_unavailable" });
    if (outcome.status !== "blocked") return;
    expect(outcome.reason).toMatch(/browser/i);

    // The whole point: this happens BEFORE beginSubmission, so the attempt is
    // not parked NEEDS_RECONCILE claiming "the click may have landed" when no
    // browser ever started.
    expect(calls).toHaveLength(0);
    const attempt = await getAttempt(db, prepared.attemptId);
    expect(attempt?.status).toBe("PENDING_CONFIRMATION");
    expect(attempt?.pendingReceipt).toBeNull();
    expect((await getActiveConfirmation(db, prepared.attemptId))?.consumedAt ?? null).toBeNull();

    // And the same token still works once a browser is available again.
    const retried = await confirmAndSubmitSite(
      deps({ probeDriver: async () => undefined, submit: stubSubmit(calls) }),
      { workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST },
    );
    expect(retried.status).toBe("submitted");
    expect(calls).toHaveLength(1);
  });

  // Spec P6 §3: Chromium runs one at a time, so a second visitor confirming
  // while the box's only browser is in use must be REFUSED, not queued and not
  // charged for it. Same H1(b) property as the no-Chromium case above: the
  // refusal happens before `beginSubmission`, so the token survives.
  it("refuses before the token burns when the browser is busy → driver_unavailable", async () => {
    const calls: SubmitCall[] = [];
    const prepared = await previewed("Busy Browser Co");

    const probeDriver = async (): Promise<void> => {
      throw new FakeBrowserBusyError();
    };
    const outcome = await confirmAndSubmitSite(deps({ probeDriver, submit: stubSubmit(calls) }), {
      workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST,
    });
    expect(outcome).toMatchObject({ status: "blocked", code: "driver_unavailable" });
    if (outcome.status !== "blocked") return;
    // Busy is not broken: the visitor is told to try again, not that Chromium
    // is missing from the image.
    expect(outcome.reason).toMatch(/busy/i);
    expect(outcome.reason).toMatch(/try again/i);
    expect(outcome.reason).not.toMatch(/could not be started/i);

    expect(calls).toHaveLength(0);
    const attempt = await getAttempt(db, prepared.attemptId);
    expect(attempt?.status).toBe("PENDING_CONFIRMATION");
    expect(attempt?.pendingReceipt).toBeNull();
    expect((await getActiveConfirmation(db, prepared.attemptId))?.consumedAt ?? null).toBeNull();

    // The same token still works once the browser is free again — a busy demo
    // must not cost the visitor their confirmation.
    const retried = await confirmAndSubmitSite(
      deps({ probeDriver: async () => undefined, submit: stubSubmit(calls) }),
      { workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST },
    );
    expect(retried.status).toBe("submitted");
    expect(calls).toHaveLength(1);
  });

  // Defence in depth for a `submit` wired without a probe (the interactive path
  // holds its slot across `beginSubmission`, so it cannot get here). The throw
  // arrives AFTER beginSubmission, but a browser that was never started cannot
  // have clicked anything — so it is a plain FAILED, never a NEEDS_RECONCILE
  // that tells a human to go check whether an application landed.
  //
  // And the reason must be TRUE. It used to end "try again in a moment", which
  // is the one thing the visitor cannot do: the token is spent
  // (`token_consumed`) and a FAILED attempt cannot be re-previewed, so their
  // only route is a fresh auto-apply run (P6 task-5 review, BLOCKING 1(1)).
  it("fails (never parks) a submit refused for a busy browser — no browser started, so no click", async () => {
    const calls: SubmitCall[] = [];
    const prepared = await previewed("Raced Browser Co");

    const outcome = await confirmAndSubmitSite(
      deps({ submit: stubSubmit(calls, { kind: "throws", error: new FakeBrowserBusyError() }) }),
      { workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST },
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.reason).toMatch(/busy/i);
    expect(outcome.reason).toMatch(/nothing was submitted/i);
    // The retry it points at must be the one that exists.
    expect(outcome.reason).not.toMatch(/try again in a moment/i);
    expect(outcome.reason).toMatch(/start auto-apply again/i);

    const attempt = await getAttempt(db, prepared.attemptId);
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.failureReason).toMatch(/busy/i);
    // Which is exactly why the message must not promise a retry: the token is
    // gone and the attempt can no longer be previewed.
    const retried = await confirmAndSubmitSite(deps({ submit: stubSubmit(calls) }), {
      workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST,
    });
    expect(retried).toMatchObject({ status: "blocked", code: "token_consumed" });
    expect(await previewSiteSubmission(deps(), { workspaceId, attemptId: prepared.attemptId }))
      .toMatchObject({ status: "blocked" });
  });

  it("parks an attempt whose submit threw — the click may have landed, so never FAILED", async () => {
    const calls: SubmitCall[] = [];
    const prepared = await previewed("Crashed Co");

    const outcome = await confirmAndSubmitSite(deps({ submit: stubSubmit(calls, { kind: "throws" }) }), {
      workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST,
    });
    expect(outcome.status).toBe("needs_reconcile");

    const attempt = await getAttempt(db, prepared.attemptId);
    expect(attempt?.status).toBe("NEEDS_RECONCILE");
    expect(attempt?.failureReason).toMatch(/chromium crashed/i);
    expect((attempt?.pendingReceipt as { channel: string }).channel).toBe("company_site");
  });

  // Spec §11 as revised by the P6 final review (BLOCKING 1): a failure BEFORE
  // the mutation costs the visitor NOTHING — not the attempt and not the
  // confirmation — while only uncertainty AFTER it earns NEEDS_RECONCILE.
  // `DriverError.kind` already says which side of the click the driver died on;
  // what changed is what "before" is worth. It used to be a terminal FAILED
  // attempt with a burned token that `previewSiteSubmission` then refused,
  // which is the exact dead end `08eadd5` was written to make unreachable —
  // reached again, in-driver, by the navigation policy and the field-identity
  // check.
  //
  // The two errors below are the real ones, verbatim: an off-policy redirect
  // hop (`navigation`) and the identity check finding a relabelled question
  // (`fill`).
  const preClickRefusals = [
    {
      kind: "navigation" as const,
      what: "an off-policy redirect",
      message: "refusing to open https://elsewhere.example.com/moved: it is not an allowed target for this workspace",
      matches: /not an allowed target/,
    },
    {
      kind: "fill" as const,
      what: "a relabelled field",
      message: 'refusing to fill #comments ("Anything else? (250 words max)"): '
        + "the question under it changed since this form was reviewed",
      matches: /the question under it changed/,
    },
  ];

  for (const refusal of preClickRefusals) {
    it(
      `hands the confirmation back after ${refusal.what} — pre-click, so nothing was spent (kind ${refusal.kind})`,
      async () => {
        const calls: SubmitCall[] = [];
        const prepared = await previewed(`Pre Click ${refusal.kind} Co`);

        const error = new FakeDriverError(refusal.message, refusal.kind);
        const outcome = await confirmAndSubmitSite(
          deps({ submit: stubSubmit(calls, { kind: "throws", error }) }),
          { workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST },
        );
        // A refusal that costs nothing reports itself the way every other
        // refusal that costs nothing does.
        expect(outcome).toMatchObject({ status: "blocked", code: "driver_refused" });
        if (outcome.status !== "blocked") return;
        expect(outcome.reason).toMatch(refusal.matches);
        expect(outcome.reason).toMatch(/nothing was submitted/);
        expect(outcome.reason).toMatch(/confirmation has not been used/);

        // The attempt is back where `beginSubmission` found it: no pending
        // receipt, no failure reason, and previewable again.
        const attempt = await getAttempt(db, prepared.attemptId);
        expect(attempt?.status).toBe("PENDING_CONFIRMATION");
        expect(attempt?.pendingReceipt).toBeNull();
        expect(attempt?.failureReason).toBeNull();
        // Unconsumed AND unexpired — `getActiveConfirmation` hides either.
        expect((await getActiveConfirmation(db, prepared.attemptId))?.consumedAt ?? null).toBeNull();

        // And the SAME token goes through once the page is what it was — no
        // re-preview, no fresh auto-apply run, nothing re-typed.
        const retried = await confirmAndSubmitSite(deps({ submit: stubSubmit(calls) }), {
          workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST,
        });
        expect(retried.status).toBe("submitted");
        // Two `submit` calls, one application: the refused one typed nothing.
        expect(calls).toHaveLength(2);
        expect((await getAttempt(db, prepared.attemptId))?.status).toBe("SUBMITTED");
      },
    );
  }

  // The guard on the fix above. Only a PROVABLY pre-click kind may be given
  // back; the moment a click may have landed, handing the token back would
  // invite a second application, which is the worst thing this system can do.
  // So the ambiguous kinds keep exactly the behaviour they had: parked for a
  // human, token spent, attempt not previewable.
  it("still parks a post-click ambiguity and does NOT return the token", async () => {
    const calls: SubmitCall[] = [];
    const prepared = await previewed("Ambiguous Guard Co");

    const error = new FakeDriverError("could not submit http://demo-ats:3001/x: Timeout 45000ms exceeded", "timeout");
    const outcome = await confirmAndSubmitSite(
      deps({ submit: stubSubmit(calls, { kind: "throws", error }) }),
      { workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST },
    );
    expect(outcome.status).toBe("needs_reconcile");

    const attempt = await getAttempt(db, prepared.attemptId);
    expect(attempt?.status).toBe("NEEDS_RECONCILE");
    // The token stays spent: a click that timed out may still have landed.
    expect(await getActiveConfirmation(db, prepared.attemptId)).toBeNull();
    // Refused twice over, and neither refusal is retryable: NEEDS_RECONCILE is
    // an in-flight status (`hasBlockingAttempt`), so the gate matrix stops the
    // retry there — and the token underneath it is spent either way.
    const retried = await confirmAndSubmitSite(deps({ submit: stubSubmit(calls) }), {
      workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST,
    });
    expect(retried).toMatchObject({ status: "blocked", code: "attempt_in_flight" });
    expect(calls).toHaveLength(1);
    expect(await previewSiteSubmission(deps(), { workspaceId, attemptId: prepared.attemptId }))
      .toMatchObject({ status: "blocked" });
  });

  it("still parks an attempt whose SUBMIT click itself failed — that one is genuinely ambiguous", async () => {
    const calls: SubmitCall[] = [];
    const prepared = await previewed("Post Click Co");

    const error = new FakeDriverError("could not submit http://demo-ats:3001/x: click intercepted", "submit");
    const outcome = await confirmAndSubmitSite(
      deps({ submit: stubSubmit(calls, { kind: "throws", error }) }),
      { workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST },
    );
    expect(outcome.status).toBe("needs_reconcile");
    expect((await getAttempt(db, prepared.attemptId))?.status).toBe("NEEDS_RECONCILE");
  });

  it("treats a failed between-steps advance as ambiguous — that click was dispatched, and it may have been the real submit", async () => {
    const calls: SubmitCall[] = [];
    const prepared = await previewed("Advance Co");

    const error = new FakeDriverError("could not advance past step 1: Execution context was destroyed", "advance");
    const outcome = await confirmAndSubmitSite(
      deps({ submit: stubSubmit(calls, { kind: "throws", error }) }),
      { workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST },
    );
    expect(outcome.status).toBe("needs_reconcile");
    expect((await getAttempt(db, prepared.attemptId))?.status).toBe("NEEDS_RECONCILE");
  });

  it("bounds and redacts the reason stored for an unrecognised post-click throw — raw driver errors can embed form values", async () => {
    const calls: SubmitCall[] = [];
    const prepared = await previewed("Raw Error Co");

    // The shape of a strict-mode violation escaping the evidence-gathering
    // phase: a long call log whose tail embeds an element snapshot carrying a
    // value the user typed into the form.
    const error = new Error(
      `locator resolved to 2 elements${"\n<intermediate line> ".repeat(20)}\n<input value="applicant-pii@example.com">`,
    );
    const outcome = await confirmAndSubmitSite(
      deps({ submit: stubSubmit(calls, { kind: "throws", error }) }),
      { workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST },
    );
    expect(outcome.status).toBe("needs_reconcile");

    const attempt = await getAttempt(db, prepared.attemptId);
    expect(attempt?.status).toBe("NEEDS_RECONCILE");
    expect(attempt?.failureReason).toMatch(/locator resolved/);
    expect(attempt?.failureReason).not.toMatch(/applicant-pii@example\.com/);
    expect(attempt?.failureReason?.length ?? 0).toBeLessThan(400);
  });

  it("treats a driver timeout as ambiguous — a click that timed out may still have landed", async () => {
    const calls: SubmitCall[] = [];
    const prepared = await previewed("Timeout Co");

    const error = new FakeDriverError("could not open http://demo-ats:3001/x: Timeout 45000ms exceeded", "timeout");
    const outcome = await confirmAndSubmitSite(
      deps({ submit: stubSubmit(calls, { kind: "throws", error }) }),
      { workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST },
    );
    expect(outcome.status).toBe("needs_reconcile");
    expect((await getAttempt(db, prepared.attemptId))?.status).toBe("NEEDS_RECONCILE");
  });

  it("parks an attempt the site accepted without a confirmation id — no evidence, no claim of success", async () => {
    const calls: SubmitCall[] = [];
    const prepared = await previewed("No Receipt Co");

    const outcome = await confirmAndSubmitSite(
      deps({ submit: stubSubmit(calls, { kind: "ok", confirmationId: null }) }),
      { workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST },
    );
    expect(outcome.status).toBe("needs_reconcile");
    expect((await getAttempt(db, prepared.attemptId))?.status).toBe("NEEDS_RECONCILE");
  });

  it("refuses to submit without a wired-up driver, before anything is burned", async () => {
    const prepared = await previewed("No Driver Co");
    const outcome = await confirmAndSubmitSite({ db, config: config() }, {
      workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST,
    });
    expect(outcome.status).toBe("blocked");
    expect((await getAttempt(db, prepared.attemptId))?.status).toBe("PENDING_CONFIRMATION");
  });
});

/**
 * The property a real P5 bug established and P6's browser cap nearly took back:
 * A REFUSAL MUST NEVER BURN A CONFIRMATION TOKEN (H1(b)).
 *
 * This is the only place in this file that touches the production driver
 * adapter, because the thing under test is exactly the seam between them: the
 * orchestrator's `probeDriver`/`submit` and the browser slot behind both. The
 * slot counter is the real global one; `playwright` is mocked at the top of the
 * file, so no Chromium starts.
 *
 * Before the fix (reproduced deterministically, P6 task-5 review): the probe
 * took the slot and gave it straight back, the racing visitor won it in the
 * `beginSubmission` window, and the loser's refusal landed AFTER the token was
 * burned — attempt FAILED, token `token_consumed`, and a FAILED attempt cannot
 * be re-previewed, so the only recovery was a whole new prepare.
 */
d("two concurrent confirms, through the real browser reservation", () => {
  it("refuses the loser BEFORE beginSubmission, and its token still submits afterwards", async () => {
    const cfg = config();
    const winner = await previewed("Race Winner Co");
    const loser = await previewed("Race Loser Co");

    let loserIsDone!: () => void;
    const loserDone = new Promise<void>((resolve) => { loserIsDone = resolve; });
    let winnerHasProbed!: () => void;
    const winnerProbed = new Promise<void>((resolve) => { winnerHasProbed = resolve; });

    const winnerCalls: SubmitCall[] = [];
    const loserCalls: SubmitCall[] = [];

    // The winner: a real reservation. The loser is released the instant the
    // winner's PROBE returns and held until after the loser's whole confirm, so
    // the loser lands inside the exact window the bug lived in — between the
    // probe and `submit`, whose real-world width is `beginSubmission`.
    const winnerRun = withSiteBrowserReservation(cfg, (reserved) => confirmAndSubmitSite(
      deps({
        probeDriver: async () => {
          await reserved.probeDriver();
          winnerHasProbed();
        },
        submit: async (args) => {
          await loserDone;
          return stubSubmit(winnerCalls)(args);
        },
      }),
      { workspaceId, attemptId: winner.attemptId, presentedToken: winner.token, retypedTarget: APPLY_HOST },
    ));

    await winnerProbed;

    const loserOutcome = await withSiteBrowserReservation(cfg, (reserved) => confirmAndSubmitSite(
      deps({ probeDriver: reserved.probeDriver, submit: stubSubmit(loserCalls) }),
      { workspaceId, attemptId: loser.attemptId, presentedToken: loser.token, retypedTarget: APPLY_HOST },
    ));

    loserIsDone();
    expect((await winnerRun).status).toBe("submitted");

    // Refused, not queued, and not charged: blocked (never failed), before
    // `beginSubmission`, so nothing was typed and nothing was burned.
    expect(loserOutcome).toMatchObject({ status: "blocked", code: "driver_unavailable" });
    if (loserOutcome.status !== "blocked") return;
    expect(loserOutcome.reason).toMatch(/busy/i);
    expect(loserCalls).toHaveLength(0);

    const attempt = await getAttempt(db, loser.attemptId);
    expect(attempt?.status).toBe("PENDING_CONFIRMATION");
    expect(attempt?.pendingReceipt).toBeNull();
    const confirmation = await getActiveConfirmation(db, loser.attemptId);
    expect(confirmation?.consumedAt ?? null).toBeNull();

    // The headline: the SAME token, on a later attempt, still submits. Before
    // the fix this came back `{"status":"blocked","code":"token_consumed"}` and
    // the attempt could not even be re-previewed.
    const retried = await withSiteBrowserReservation(cfg, (reserved) => confirmAndSubmitSite(
      deps({ probeDriver: reserved.probeDriver, submit: stubSubmit(loserCalls) }),
      { workspaceId, attemptId: loser.attemptId, presentedToken: loser.token, retypedTarget: APPLY_HOST },
    ));
    expect(retried.status).toBe("submitted");
    expect(loserCalls).toHaveLength(1);
    expect((await getAttempt(db, loser.attemptId))?.status).toBe("SUBMITTED");
  });
});

/**
 * The demo's evidence-screenshot ceiling (the CV-upload leak's twin, closed
 * here): `submit` writes a confirmation PNG under `FILE_STORAGE_DIR` on every
 * successful submission, the six-hourly reset cascades the rows away and
 * leaves the files, and nothing bounded or reclaimed them.
 *
 * Both halves are load-bearing and both are tested here against a real
 * directory: the ceiling must actually refuse, and the collector must actually
 * give the budget back — a ceiling with no reclamation would brick auto-apply
 * on the demo permanently, which is worse than the leak.
 *
 * The refusal's position is the point of most of these assertions. It lands
 * BEFORE `beginSubmission`, because the screenshot is written after the submit
 * click: refusing any later would either throw away the evidence of a real
 * application or leave an attempt whose receipt names a file that was never
 * stored.
 */
d("the demo's evidence-screenshot store", () => {
  /** A `FILE_STORAGE_DIR` of its own per test, so the store is exactly what the test put there. */
  function storeDir(): string {
    return mkdtempSync(path.join(tmpdir(), "careerhq-site-shots-"));
  }

  function demoConfig(fileStorageDir: string): AppConfig {
    return config({ DEMO_MODE: "true", FILE_STORAGE_DIR: fileStorageDir });
  }

  /** `count` screenshots in one of the store's two directories, aged `ageMs` into the past. */
  function fillStore(fileStorageDir: string, dir: string, count: number, ageMs: number): void {
    const dirPath = path.join(fileStorageDir, dir);
    mkdirSync(dirPath, { recursive: true });
    const stamp = (Date.now() - ageMs) / 1000;
    for (let i = 0; i < count; i += 1) {
      const filePath = path.join(dirPath, `shot-${i}.png`);
      writeFileSync(filePath, "png");
      utimesSync(filePath, stamp, stamp);
    }
  }

  it("refuses a full store before the token burns, then lets the SAME token through once the reset's orphans are reclaimed", async () => {
    const fileStorageDir = storeDir();
    const calls: SubmitCall[] = [];
    const prepared = await previewed("Full Disk Co");

    // A store at the file ceiling whose files are all inside the grace window
    // — i.e. every one of them could be someone's in-flight write. Nothing is
    // reclaimable, so the ceiling is the only thing that can answer.
    fillStore(fileStorageDir, "site-screenshots", DEMO_MAX_EVIDENCE_STORE_FILES, 0);

    const outcome = await confirmAndSubmitSite(
      deps({ config: demoConfig(fileStorageDir), submit: stubSubmit(calls) }),
      { workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST },
    );

    expect(outcome).toMatchObject({ status: "blocked", code: "evidence_store_full" });
    if (outcome.status !== "blocked") return;
    expect(outcome.reason).toMatch(/storage is full/);
    expect(outcome.reason).toMatch(/nothing was submitted/);

    // Nothing typed, nothing burned, nothing parked: the attempt is exactly as
    // it was and the same token is still live.
    expect(calls).toHaveLength(0);
    const attempt = await getAttempt(db, prepared.attemptId);
    expect(attempt?.status).toBe("PENDING_CONFIRMATION");
    expect(attempt?.pendingReceipt).toBeNull();
    expect((await getActiveConfirmation(db, prepared.attemptId))?.consumedAt ?? null).toBeNull();
    // And the guard did not "make room" by deleting live-looking files.
    expect(readdirSync(path.join(fileStorageDir, "site-screenshots")))
      .toHaveLength(DEMO_MAX_EVIDENCE_STORE_FILES);

    // Now age them past the grace window — what the six-hourly reset leaves
    // behind, since it drops every attempt and snapshot that pointed at them
    // and touches no files. The next confirm reclaims the lot and goes
    // through, on the token the refusal did not spend.
    fillStore(fileStorageDir, "site-screenshots", DEMO_MAX_EVIDENCE_STORE_FILES, ORPHAN_GRACE_MS + 60_000);

    const retried = await confirmAndSubmitSite(
      deps({ config: demoConfig(fileStorageDir), submit: stubSubmit(calls) }),
      { workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST },
    );

    expect(retried.status).toBe("submitted");
    expect(calls).toHaveLength(1);
    expect(readdirSync(path.join(fileStorageDir, "site-screenshots"))).toEqual([]);
    expect((await getAttempt(db, prepared.attemptId))?.status).toBe("SUBMITTED");
  });

  // The collector's live set is the database, and this attempt's own receipt
  // is in it the moment it commits. A submission must never be able to reclaim
  // the evidence of an earlier one.
  it("never reclaims a screenshot an attempt's receipt still points at", async () => {
    const fileStorageDir = storeDir();
    const first = await previewed("Kept Evidence Co");
    const evidence = path.join(fileStorageDir, "site-screenshots", "kept.png");
    mkdirSync(path.dirname(evidence), { recursive: true });
    writeFileSync(evidence, "png");

    const submitted = await confirmAndSubmitSite(
      deps({
        config: demoConfig(fileStorageDir),
        submit: async (args) => ({
          confirmationId: "NR-kept",
          finalUrl: `${args.url}/thanks`,
          screenshotPath: evidence,
          pageText: "Thanks! Confirmation ID: NR-kept",
        }),
      }),
      { workspaceId, attemptId: first.attemptId, presentedToken: first.token, retypedTarget: APPLY_HOST },
    );
    expect(submitted.status).toBe("submitted");

    // Age it well past the grace window and run another confirm's collector
    // over the same store, alongside a file nothing points at.
    const stamp = (Date.now() - (ORPHAN_GRACE_MS + 60_000)) / 1000;
    utimesSync(evidence, stamp, stamp);
    const orphan = path.join(fileStorageDir, "site-screenshots", "orphan.png");
    writeFileSync(orphan, "png");
    utimesSync(orphan, stamp, stamp);

    const second = await previewed("Second Confirm Co");
    const outcome = await confirmAndSubmitSite(
      deps({ config: demoConfig(fileStorageDir), submit: stubSubmit([]) }),
      { workspaceId, attemptId: second.attemptId, presentedToken: second.token, retypedTarget: APPLY_HOST },
    );

    expect(outcome.status).toBe("submitted");
    expect(readdirSync(path.join(fileStorageDir, "site-screenshots"))).toEqual(["kept.png"]);
  });

  // The outcome that most needs its evidence, and the one that used to lose
  // it. NEEDS_RECONCILE means "the click landed and nobody can say what came of
  // it", so there is no confirmed receipt to hold the path — it was persisted
  // to no row at all, the collector reclaimed the file five minutes later, and
  // the attempt's reason went on telling the reader to check a screenshot that
  // was gone.
  it("never reclaims the screenshot a NEEDS_RECONCILE reason tells the reader to check", async () => {
    const fileStorageDir = storeDir();
    const parked = await previewed("Unconfirmed Co");
    const evidence = path.join(fileStorageDir, "site-screenshots", "reconcile.png");
    mkdirSync(path.dirname(evidence), { recursive: true });
    writeFileSync(evidence, "png");

    const outcome = await confirmAndSubmitSite(
      deps({
        config: demoConfig(fileStorageDir),
        // The confirmation page came back with no confirmation id: not evidence
        // of success, not evidence of failure — a human's problem.
        submit: async (args) => ({
          confirmationId: null,
          finalUrl: `${args.url}/thanks`,
          screenshotPath: evidence,
          pageText: "Thanks for applying!",
        }),
      }),
      { workspaceId, attemptId: parked.attemptId, presentedToken: parked.token, retypedTarget: APPLY_HOST },
    );

    expect(outcome.status).toBe("needs_reconcile");
    if (outcome.status !== "needs_reconcile") return;
    expect(outcome.reason).toMatch(/saved screenshot/);
    expect((await getAttempt(db, parked.attemptId))?.status).toBe("NEEDS_RECONCILE");
    // The attempt points at the file: same key the worker's `submit_result`
    // uses, which is the key the collector's keep-set reads.
    expect(await listEvidenceScreenshotPaths(db)).toContain(evidence);

    // Age it well past the grace window — what the six-hourly reset leaves
    // behind — and drop a genuine orphan beside it, then run another confirm,
    // whose reservation runs the collector over the whole store.
    const stamp = (Date.now() - (ORPHAN_GRACE_MS + 60_000)) / 1000;
    utimesSync(evidence, stamp, stamp);
    const orphan = path.join(fileStorageDir, "site-screenshots", "orphan.png");
    writeFileSync(orphan, "png");
    utimesSync(orphan, stamp, stamp);

    const second = await previewed("Post Reconcile Confirm Co");
    const collected = await confirmAndSubmitSite(
      deps({ config: demoConfig(fileStorageDir), submit: stubSubmit([]) }),
      { workspaceId, attemptId: second.attemptId, presentedToken: second.token, retypedTarget: APPLY_HOST },
    );
    expect(collected.status).toBe("submitted");

    // The referenced screenshot survives and the orphan does not: a keep-set
    // that keeps everything would be no fix at all.
    expect(readdirSync(path.join(fileStorageDir, "site-screenshots"))).toEqual(["reconcile.png"]);
    expect(existsSync(evidence)).toBe(true);
    // And the parked attempt can still point a human at it.
    const snapshot = await getLatestSnapshot(db, parked.attemptId);
    expect((snapshot?.recoveryState as { screenshotPath?: string } | null)?.screenshotPath).toBe(evidence);
  });

  // A personal, self-hosted install owns its disk, and its screenshots are the
  // records of applications it really made. Neither bound nor collector runs.
  it("neither refuses nor reclaims outside demo mode", async () => {
    const fileStorageDir = storeDir();
    const calls: SubmitCall[] = [];
    const prepared = await previewed("Self Hosted Co");

    fillStore(fileStorageDir, "site-screenshots", DEMO_MAX_EVIDENCE_STORE_FILES + 5, ORPHAN_GRACE_MS + 60_000);

    const outcome = await confirmAndSubmitSite(
      deps({ config: config({ FILE_STORAGE_DIR: fileStorageDir }), submit: stubSubmit(calls) }),
      { workspaceId, attemptId: prepared.attemptId, presentedToken: prepared.token, retypedTarget: APPLY_HOST },
    );

    expect(outcome.status).toBe("submitted");
    expect(calls).toHaveLength(1);
    expect(readdirSync(path.join(fileStorageDir, "site-screenshots")))
      .toHaveLength(DEMO_MAX_EVIDENCE_STORE_FILES + 5);
  });
});
