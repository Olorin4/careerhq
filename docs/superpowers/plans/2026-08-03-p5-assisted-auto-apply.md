# CareerHQ P5 — Assisted Auto-Apply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec v0.3 §10: parse a company-site application form into a canonical schema, fill it deterministically from the Fact Bank and answer bank, draft only what's groundable, present a review screen where every answer shows its source, and submit through the same three-layer gated protocol P4 proved — with an in-repo fake ATS (`apps/demo-ats`) as the e2e target and demo destination, plus the carried P4 backlog.

**Architecture:** The browser boundary is deliberately thin: Playwright's only job is to hand back a **serializable `RawFormPage`** (raw field descriptors + page metadata) and later to type/click/screenshot. Everything that decides anything — ATS detection, normalization into the canonical schema, field→answer mapping, sensitivity blocking, blocker detection, confidence — is a **pure function in `packages/autoapply` (parsing/mapping) or `packages/core/src/gates` (submission gates)**, unit-tested against saved HTML/JSON fixtures with no browser. `apps/worker` owns the only live browser; `apps/web` orchestrates prepare → review → confirm and reuses P4's gate matrix and receipt machinery unchanged.

**Tech Stack:** additions — `playwright` (worker only; the Docker worker image already derives from `mcr.microsoft.com/playwright`), `hono` (demo-ats), `linkedom` (fixture-time DOM parsing for pure parser tests). Existing: Node 22, TS strict ESM, Drizzle/Postgres, pg-boss, Zod 3, Vitest 3, Next.js 15.

## Global Constraints

- **Review-first is absolute (spec §10.2/§11):** nothing is typed into a live form until the user has approved the review screen, and nothing is submitted until the same gate matrix P4 uses (`evaluateSubmissionGates`, `@careerhq/core/gates`) returns `allowed` — env gate `SUBMISSIONS_LIVE_COMPANY_SITE` (default OFF), sandbox host allow-list, single-use hashed token + retype-target + byte-identical payload fingerprint, no confirmed/in-flight attempt. Pending receipt before the final click; confirmed receipt only after evidence (confirmation page screenshot + confirmation id/URL); ambiguity after the click → `NEEDS_RECONCILE`, never auto-retried (spec §10.6).
- **Retype target for this channel is the application URL's host** (`careers.acme.example`) — the email channel retypes the recipient; here the equivalent "exact target" is the host being submitted to. `EmailSubmissionPayload`'s sibling `SiteSubmissionPayload` carries it.
- **Sensitive answers are never AI-generated (spec §10.4/§7.2.5):** `classifyQuestionSensitivity` + `mergeSensitivityRulings` (P3, `@careerhq/core`) gate every free-text field; sensitive fields are deterministic-from-facts or user-only, and a sensitive field left unanswered blocks submission rather than being guessed.
- **AI is optional (spec §1.4):** with no `OPENROUTER_API_KEY`, parsing/mapping/filling/submitting all work; only `interpretField` and screening-question drafting are skipped, and their fields surface as "needs your answer".
- **Pause and return control (spec §10.6):** on CAPTCHA, login wall, identity verification, assessment, unsupported file control, or legal attestation → attempt goes `BLOCKED` with a typed reason; never attempt to bypass. Detection is a pure function over the parsed page.
- **Parser versioning (spec §10.5):** every `FormSnapshot` records `parserVersion` (`PARSER_VERSION` const, bumped when normalization output changes) and the raw page fixture hash; adapters have saved-HTML regression fixtures.
- **Duplicate requisition (spec §10.6):** a second attempt at the same `(workspace, canonical requisition key)` is refused unless the user passes an explicit override recorded in the event log.
- **Scope fence:** Greenhouse + Lever adapters and a generic fallback ONLY. LinkedIn/Indeed/Glassdoor and any CAPTCHA/anti-bot circumvention remain permanently out (spec §19); the demo/e2e target is always `apps/demo-ats`.
- **Package boundaries (dependency-cruiser):** `autoapply` may import `contracts` + `core` only — NOT `db`, NOT `apps` (extend the existing `ingest-and-ai-purity` rule to include it, with a negative test). Playwright is a `worker` dependency, never an `autoapply` one.
- Repo conventions: TS strict, no `any`; ESM `.js` specifiers; db tests `skipIf(!process.env.TEST_DATABASE_URL)` against this host's `postgres://careerhq:careerhq@localhost:5433/careerhq` with throwaway workspace + `afterAll` cleanup; P1 action conventions; conventional commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; dep-adding commits include the lockfile; **every new env var lands in `.env.example` AND `infra/docker-compose.yml` in the task that introduces it** (the standing P2/P3 lesson).
- New env vars: `SUBMISSIONS_LIVE_COMPANY_SITE` (web+worker, default `false`), `SANDBOX_SITE_ALLOWED_HOST` (web+worker, default `demo-ats`), `DEMO_ATS_URL` (worker+web, default `http://demo-ats:3001`), `AUTOAPPLY_BROWSER_TIMEOUT_MS` (worker, default `45000`).

---

### Task 1: Contracts — canonical form schema

**Files:**
- Modify: `packages/contracts/src/index.ts` (append)
- Test: `packages/contracts/src/autoapply.test.ts`

**Interfaces:**
- Produces (appended to `@careerhq/contracts`):
```ts
export const FIELD_KINDS = ["text", "textarea", "email", "tel", "url", "select", "multiselect", "checkbox", "radio", "file", "date", "hidden"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];
export const fieldKindSchema = z.enum(FIELD_KINDS);

export const CANONICAL_FIELDS = [
  "full_name", "first_name", "last_name", "email", "phone",
  "location", "remote_preference", "relocation", "travel",
  "linkedin_url", "github_url", "portfolio_url", "website_url",
  "current_company", "current_title", "years_experience", "education",
  "work_authorization", "visa_sponsorship", "availability", "notice_period",
  "desired_salary", "demographics", "criminal_history", "legal_attestation",
  "resume_file", "cover_letter_file", "cover_letter_text", "screening_question", "unknown",
] as const;
export type CanonicalField = (typeof CANONICAL_FIELDS)[number];
export const canonicalFieldSchema = z.enum(CANONICAL_FIELDS);

export const BLOCKER_KINDS = ["captcha", "login_required", "identity_verification", "assessment", "unsupported_file_control", "legal_attestation", "parse_failure"] as const;
export type BlockerKind = (typeof BLOCKER_KINDS)[number];
export const blockerKindSchema = z.enum(BLOCKER_KINDS);

export const canonicalFormFieldSchema = z.object({
  id: z.string().min(1),                       // stable per-field id assigned by the parser (selectorHash)
  kind: fieldKindSchema,
  label: z.string().default(""),
  helpText: z.string().default(""),
  required: z.boolean().default(false),
  options: z.array(z.object({ value: z.string(), label: z.string() })).default([]),
  maxLength: z.number().int().positive().optional(),
  accept: z.string().optional(),               // file inputs
  step: z.number().int().min(0).default(0),    // multi-step forms
  canonicalField: canonicalFieldSchema.default("unknown"),
  mappingConfidence: z.number().min(0).max(1).default(0),
  sensitive: z.boolean().default(false),
});
export type CanonicalFormField = z.infer<typeof canonicalFormFieldSchema>;

export const canonicalFormSchema = z.object({
  atsType: z.enum(["greenhouse", "lever", "generic"]),
  parserVersion: z.string().min(1),
  url: z.string().url(),
  requisitionKey: z.string().min(1),            // stable id for duplicate detection
  title: z.string().default(""),
  companyName: z.string().default(""),
  totalSteps: z.number().int().min(1).default(1),
  fields: z.array(canonicalFormFieldSchema),
  blockers: z.array(z.object({ kind: blockerKindSchema, detail: z.string().default("") })).default([]),
  parseConfidence: z.number().min(0).max(1),
});
export type CanonicalForm = z.infer<typeof canonicalFormSchema>;

export const ANSWER_SOURCES = ["fact", "saved_answer", "profile", "ai", "user", "document"] as const;
export type AnswerSource = (typeof ANSWER_SOURCES)[number];
export const answerSourceSchema = z.enum(ANSWER_SOURCES);

export const plannedAnswerSchema = z.object({
  fieldId: z.string().min(1),
  value: z.string(),                            // for file fields: the cv_variant/document id
  source: answerSourceSchema,
  sourceFactIds: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  needsUser: z.boolean().default(false),        // unanswered, low-confidence, or sensitive-without-a-fact
  differsFromApproved: z.boolean().default(false),
  note: z.string().default(""),
});
export type PlannedAnswer = z.infer<typeof plannedAnswerSchema>;

export const interpretFieldResultSchema = z.object({
  canonicalField: canonicalFieldSchema,
  confidence: z.number().min(0).max(1),
});
export type InterpretFieldResult = z.infer<typeof interpretFieldResultSchema>;
```

- [ ] **Step 1: Write the failing test**

`packages/contracts/src/autoapply.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  BLOCKER_KINDS, CANONICAL_FIELDS, canonicalFormFieldSchema, canonicalFormSchema, plannedAnswerSchema,
} from "./index.js";

describe("auto-apply contracts (spec §10.3)", () => {
  it("canonical field list covers every §10.3 category incl. sensitive ones", () => {
    for (const f of ["work_authorization", "visa_sponsorship", "desired_salary", "demographics", "criminal_history", "legal_attestation", "notice_period", "relocation"]) {
      expect(CANONICAL_FIELDS).toContain(f);
    }
  });
  it("form field defaults are conservative", () => {
    const f = canonicalFormFieldSchema.parse({ id: "a", kind: "text" });
    expect(f.canonicalField).toBe("unknown");
    expect(f.mappingConfidence).toBe(0);
    expect(f.sensitive).toBe(false);
    expect(f.required).toBe(false);
  });
  it("form requires url, requisitionKey, parserVersion and bounded confidence", () => {
    const base = { atsType: "greenhouse", parserVersion: "1", url: "https://x.example/a", requisitionKey: "k", fields: [], parseConfidence: 0.9 };
    expect(canonicalFormSchema.parse(base).totalSteps).toBe(1);
    expect(canonicalFormSchema.safeParse({ ...base, parseConfidence: 1.5 }).success).toBe(false);
    expect(canonicalFormSchema.safeParse({ ...base, url: "not-a-url" }).success).toBe(false);
  });
  it("planned answers default to not-needing-user and no diff", () => {
    const a = plannedAnswerSchema.parse({ fieldId: "a", value: "v", source: "fact", confidence: 0.9 });
    expect(a.needsUser).toBe(false);
    expect(a.differsFromApproved).toBe(false);
    expect(a.sourceFactIds).toEqual([]);
  });
  it("blocker kinds include every §10.6 pause reason", () => {
    expect(BLOCKER_KINDS).toEqual([
      "captcha", "login_required", "identity_verification", "assessment",
      "unsupported_file_control", "legal_attestation", "parse_failure",
    ]);
  });
});
```
- [ ] **Step 2: FAIL run** — `pnpm --filter @careerhq/contracts test`.
- [ ] **Step 3: Append the Interfaces block verbatim.** **Step 4: PASS + build + full contracts suite.**
- [ ] **Step 5: Commit** — `feat(contracts): canonical application-form schema`

---

### Task 2: P4 carried backlog burn-down

**Files:**
- Modify: `packages/email/src/threading.ts`, `apps/worker/src/jobs/email-sync.ts`, `apps/web/src/app/(dashboard)/applications/[id]/email-panel.tsx`
- Test: `packages/email/src/threading.test.ts`, `packages/db/src/crypto.test.ts`, `apps/web/src/lib/email-submission.test.ts`, `apps/worker/src/jobs/email-sync.test.ts`

**Interfaces:**
- Five items (all from the roadmap's P5 note):
  1. **Subdomain sender matching** — in `matchInboundToApplication`'s sender-domain fallback only: a sender domain matches an indexed domain when equal OR when it ends with `"." + indexed`. Collect candidates across ALL suffix-matching indexed domains; link only when exactly one distinct applicationId survives (the never-guess rule is preserved). Never match the reverse direction (`acme.com` sender must not match an indexed `mail.acme.com`).
  2. **Per-folder syncState** — `syncConnection` persists `updateSyncState` after EACH folder completes (move the call inside the loop, accumulating into the same object), so one broken folder no longer discards healthy siblings' progress.
  3. **Concurrency test** — in `email-submission.test.ts`, fire two `confirmAndSend` calls on the same attempt/token with `Promise.all` (transport stub counts sends): exactly one `submitted`, the other blocked/refused, and the stub sent exactly ONE message.
  4. **Crypto tests** — `sealSecret` twice over the same plaintext+key yields different sealed bytes (nonce randomness); `openSecret` on a 5-byte buffer throws `CryptoError` (not RangeError).
  5. **UI copy** — add `"token_missing"` to `REQUIRES_FRESH_PREVIEW` in `email-panel.tsx`.

- [ ] **Step 1: Write the failing tests**

`packages/email/src/threading.test.ts` (append):
```ts
it("matches a subdomain sender to its parent-domain application", () => {
  const senderDomains = new Map([["acme.example", ["app-1"]]]);
  const m = matchInboundToApplication(
    { inReplyTo: null, references: [], fromAddr: "recruiting@mail.acme.example" },
    new Map(), senderDomains,
  );
  expect(m).toEqual({ applicationId: "app-1", matchMethod: "sender" });
});
it("does not match a parent-domain sender to a subdomain entry", () => {
  const senderDomains = new Map([["mail.acme.example", ["app-1"]]]);
  const m = matchInboundToApplication(
    { inReplyTo: null, references: [], fromAddr: "hr@acme.example" }, new Map(), senderDomains,
  );
  expect(m).toBeNull();
});
it("refuses when suffix matching makes the candidate set ambiguous", () => {
  const senderDomains = new Map([["acme.example", ["app-1"]], ["mail.acme.example", ["app-2"]]]);
  const m = matchInboundToApplication(
    { inReplyTo: null, references: [], fromAddr: "x@mail.acme.example" }, new Map(), senderDomains,
  );
  expect(m).toBeNull();
});
it("still links when several suffix matches point at the SAME application", () => {
  const senderDomains = new Map([["acme.example", ["app-1"]], ["mail.acme.example", ["app-1"]]]);
  const m = matchInboundToApplication(
    { inReplyTo: null, references: [], fromAddr: "x@mail.acme.example" }, new Map(), senderDomains,
  );
  expect(m).toEqual({ applicationId: "app-1", matchMethod: "sender" });
});
```
`packages/db/src/crypto.test.ts` (append):
```ts
it("uses a fresh nonce per seal", async () => {
  const key = await generateMasterKeyB64();
  const a = await sealSecret(key, "same-secret");
  const b = await sealSecret(key, "same-secret");
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
});
it("rejects a sealed buffer shorter than the nonce", async () => {
  const key = await generateMasterKeyB64();
  await expect(openSecret(key, new Uint8Array([1, 2, 3, 4, 5]))).rejects.toBeInstanceOf(CryptoError);
});
```
`apps/worker/src/jobs/email-sync.test.ts` (append): two folders where the SECOND throws → assert `updateSyncState` persisted the first folder's uid (read the connection row back).
`apps/web/src/lib/email-submission.test.ts` (append): the `Promise.all` concurrency case described above.

- [ ] **Step 2: FAIL runs.** **Step 3: Implement all five.** **Step 4: PASS + full repo gate.**
- [ ] **Step 5: Commit** — `fix(email,db,web): P4 backlog — subdomain threading, per-folder sync state, concurrency and crypto tests`

---

### Task 3: `apps/demo-ats` — the fictional ATS

**Files:**
- Create: `apps/demo-ats/package.json`, `apps/demo-ats/tsconfig.json`, `apps/demo-ats/src/main.ts`, `apps/demo-ats/src/pages.ts`, `apps/demo-ats/src/store.ts`
- Modify: `infra/docker-compose.yml` (service `demo-ats`, profile `demo` AND available by default for e2e — see below), `.env.example`
- Test: `apps/demo-ats/src/pages.test.ts`

**Interfaces:**
- Produces a Hono server (`PORT` env, default 3001) serving a fictional company "Northwind Robotics":
  - `GET /` — index listing the two openings.
  - `GET /greenhouse/jobs/:id` — **Greenhouse-style multi-step form**: step 1 identity (first/last/email/phone, resume file input, LinkedIn url), step 2 details (`select` for work authorization, `select` for visa sponsorship, textarea "Why do you want to work at Northwind Robotics?", checkbox legal attestation), step 3 voluntary demographics (radio gender, radio veteran status, both with "Decline to self-identify"). Markup deliberately mimics Greenhouse: `<div id="application_form">`, fields wrapped in `<div class="field">`, labels via `<label for>`, required marked `aria-required="true"`, a `data-source="greenhouse"` marker on the root, `Next`/`Submit` buttons carrying `id="btn_next"` / `id="btn_submit"`.
  - `GET /lever/jobs/:id` — **Lever-style single page**: all fields on one page, `<form class="application-form" data-source="lever">`, `name="cards[...]"`-style names, resume input `name="resume"`, one textarea "Additional information", a `select` for notice period.
  - `GET /captcha/jobs/:id` — a page with a `<div class="g-recaptcha">` and a submit button (the pause-and-return fixture).
  - `GET /login/jobs/:id` — a page whose form is a username/password login (login-wall fixture).
  - `POST /greenhouse/apply/:id`, `POST /lever/apply/:id` — accept multipart, store the submission in memory, and respond with a **confirmation page** containing `Application received` and `Confirmation ID: NR-<8 hex>`; the id is also in a `data-confirmation-id` attribute.
  - `GET /api/submissions` — JSON list of received submissions (the e2e assertion surface, Mailpit-style), `DELETE /api/submissions` clears.
- `pages.ts` exports the HTML builders as pure functions (`greenhousePage(job)`, `leverPage(job)`, `captchaPage(job)`, `loginPage(job)`, `confirmationPage(id)`) so they are snapshot-testable AND reusable as parser fixtures (Task 5/6 import them to generate fixtures — no scraping needed).
- Compose: service `demo-ats` built from `infra/Dockerfile.demo-ats`, `ports: ["3001:3001"]`, no dependencies, `DEMO_ATS_URL` added to web+worker env (`${DEMO_ATS_URL:-http://demo-ats:3001}`). Present in the default compose file (the e2e suite needs it like Mailpit), NOT behind a profile.

- [ ] **Step 1: Write the failing test**

`apps/demo-ats/src/pages.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { captchaPage, confirmationPage, greenhousePage, leverPage, loginPage } from "./pages.js";

const job = { id: "eng-1", title: "Senior Robotics Engineer", company: "Northwind Robotics" };

describe("demo-ats pages", () => {
  it("greenhouse page carries the ats marker, 3 steps and the sensitive selects", () => {
    const html = greenhousePage(job);
    expect(html).toContain('data-source="greenhouse"');
    expect(html).toContain('id="application_form"');
    expect(html).toContain('data-step="3"');
    expect(html.toLowerCase()).toContain("work authorization");
    expect(html.toLowerCase()).toContain("sponsorship");
    expect(html).toContain('id="btn_submit"');
  });
  it("lever page is single-step with a resume input and notice-period select", () => {
    const html = leverPage(job);
    expect(html).toContain('data-source="lever"');
    expect(html).toContain('name="resume"');
    expect(html.toLowerCase()).toContain("notice period");
    expect(html).not.toContain('id="btn_next"');
  });
  it("captcha and login pages expose their blocker markers", () => {
    expect(captchaPage(job)).toContain("g-recaptcha");
    expect(loginPage(job)).toContain('type="password"');
  });
  it("confirmation page exposes the id twice (text and attribute)", () => {
    const html = confirmationPage("NR-abc12345");
    expect(html).toContain("Application received");
    expect(html).toContain("Confirmation ID: NR-abc12345");
    expect(html).toContain('data-confirmation-id="NR-abc12345"');
  });
});
```
- [ ] **Step 2: Scaffold the package** (deps `hono` + `@hono/node-server`; scripts `dev`/`build`/`start`/`test`/`lint`/`typecheck`). **FAIL run.**
- [ ] **Step 3: Implement pages + server + in-memory store.**
- [ ] **Step 4: PASS; start it locally (`PORT=3001 pnpm --filter @careerhq/demo-ats dev`) and curl each route (`/greenhouse/jobs/eng-1`, `/lever/jobs/eng-2`, `/captcha/jobs/x`, `/login/jobs/x`), POST a multipart application with curl and confirm the confirmation page + `/api/submissions`. Add the compose service and verify `docker compose config`. Transcripts in the report.**
- [ ] **Step 5: Commit** — `feat(demo-ats): fictional greenhouse/lever style application forms`

---

### Task 4: `packages/autoapply` — raw page contract, generic parser, blocker detection

**Files:**
- Create: `packages/autoapply/package.json`, `packages/autoapply/tsconfig.json`, `packages/autoapply/src/index.ts`, `packages/autoapply/src/raw.ts`, `packages/autoapply/src/detect.ts`, `packages/autoapply/src/generic.ts`, `packages/autoapply/src/blockers.ts`
- Modify: `.dependency-cruiser.cjs` (add `autoapply` to the purity rule's `from`)
- Test: `packages/autoapply/src/generic.test.ts`, `packages/autoapply/src/blockers.test.ts`, `packages/autoapply/src/detect.test.ts`

**Interfaces:**
- Produces:
```ts
// raw.ts — the ONLY shape the browser hands back (must be JSON-serializable)
export interface RawField {
  selector: string;            // unique CSS selector the driver can re-find
  tag: "input" | "textarea" | "select" | "button";
  type: string;                // input type or "" (textarea/select)
  name: string; id: string;
  labelText: string;           // resolved from <label for>, wrapping label, aria-label or aria-labelledby
  nearbyText: string;          // trimmed text of the closest field container, ≤400 chars
  placeholder: string;
  required: boolean;           // required attr OR aria-required="true"
  maxLength: number | null;
  accept: string | null;
  options: Array<{ value: string; label: string }>;
  step: number;                // 0-based; driver assigns per visible step
}
export interface RawFormPage {
  url: string; title: string; bodyText: string;   // bodyText ≤ 20_000 chars, whitespace-collapsed
  rootMarkers: string[];                          // e.g. ["data-source=greenhouse", "id=application_form"]
  fields: RawField[];
  buttons: Array<{ selector: string; id: string; text: string }>;
  totalSteps: number;
}
export const PARSER_VERSION = "1";
export function rawFieldId(field: RawField): string;   // sha256(selector)[0..16] — stable CanonicalFormField.id
// detect.ts
export function detectAts(page: RawFormPage): { atsType: "greenhouse" | "lever" | "generic"; confidence: number };
// greenhouse: rootMarkers/url contain "greenhouse" or "#application_form" → 0.95; lever: "lever" marker or
// "cards[" name prefix → 0.95; else generic → 0.4.
// blockers.ts
export function detectBlockers(page: RawFormPage): Array<{ kind: BlockerKind; detail: string }>;
// captcha: any selector/marker matching /recaptcha|hcaptcha|turnstile|cf-challenge/i, or bodyText /verify you are human/i
// login_required: a password input present AND no file input (a real application form has a resume upload)
// identity_verification: bodyText /verify your identity|government[- ]issued id/i
// assessment: bodyText /coding (challenge|assessment)|timed test|hackerrank|codility/i
// unsupported_file_control: a file input whose accept excludes pdf AND excludes doc (we can only attach PDFs)
// legal_attestation: a required checkbox whose label matches /certify|attest|under penalty|legally binding/i
// (legal_attestation is a BLOCKER only when required — spec §10.6 forbids us from ticking it for the user)
// generic.ts
export function parseGenericForm(page: RawFormPage, opts: { atsType: "greenhouse" | "lever" | "generic"; parseConfidence: number }): CanonicalForm;
// kind from tag/type; label = labelText || placeholder || nearbyText-first-line; options passed through;
// requisitionKey = `${new URL(page.url).host}${new URL(page.url).pathname}`; title/companyName from page.title
// ("<title> at <company>" split on " at " when present); canonicalField left "unknown" (Task 7 maps); blockers attached.
```
- Package deps: `@careerhq/contracts` only (+ vitest, `linkedom` devDep for the fixture helper below). Tests build `RawFormPage` fixtures from the demo-ats HTML using a shared test helper `packages/autoapply/src/testing/from-html.ts` that parses HTML with `linkedom` and emits `RawFormPage` using the SAME extraction rules the driver will use — one place to keep them honest (the driver in Task 8 reimplements them in browser JS; Task 8 asserts parity against this helper).

- [ ] **Step 1: Write the failing tests** — build a `RawFormPage` from `greenhousePage(job)` (import from `@careerhq/demo-ats` — add it as a devDependency; it is a pure function) via the helper, then assert: `detectAts` → greenhouse 0.95; generic parse yields ≥10 fields with stable ids (same input → same ids, different selector → different id), the textarea kind, `select` options preserved, `required` flags from `aria-required`, `totalSteps` 3, `requisitionKey` = host+path. From `captchaPage`/`loginPage`: `detectBlockers` returns exactly `captcha` / `login_required`. A required attestation checkbox → `legal_attestation`; the same checkbox unrequired → no blocker.
- [ ] **Step 2: Scaffold package + FAIL.** **Step 3: Implement.** **Step 4: PASS + build + lint + depcruise (add rule; MANDATORY negative test: temp `import "@careerhq/db"` in autoapply → error → revert; record both outputs).**
- [ ] **Step 5: Commit** — `feat(autoapply): raw page contract, ats detection, generic parser and blocker rules`

---

### Task 5: Greenhouse adapter + regression fixtures

**Files:**
- Create: `packages/autoapply/src/adapters/greenhouse.ts`, `packages/autoapply/fixtures/greenhouse-page.json`
- Modify: `packages/autoapply/src/index.ts`
- Test: `packages/autoapply/src/adapters/greenhouse.test.ts`

**Interfaces:**
- Produces:
```ts
export function parseGreenhouse(page: RawFormPage): CanonicalForm;
// Runs parseGenericForm with atsType "greenhouse", parseConfidence 0.9, then applies Greenhouse-specific
// canonicalField hints by NAME/ID pattern (these are stable across real Greenhouse boards):
//   first_name|job_application[first_name] → first_name; last_name → last_name; email → email; phone → phone;
//   resume|job_application[resume] → resume_file; cover_letter → cover_letter_file;
//   urls[LinkedIn]|linkedin → linkedin_url; urls[GitHub] → github_url; urls[Website|Portfolio] → portfolio_url;
//   location|job_application[location] → location; question_*/custom_question → screening_question;
//   gender|race|ethnicity|veteran|disability|self_identif → demographics;
// each hint sets mappingConfidence 0.9. Fields the hints don't cover keep "unknown"/0.
export const GREENHOUSE_FIXTURE_HASH: string;  // sha256 of the committed fixture — regression tripwire
```
- The fixture is the serialized `RawFormPage` for `greenhousePage(job)` written by a small script step (`pnpm --filter @careerhq/autoapply exec tsx scripts/write-fixture.ts greenhouse`) — commit BOTH the fixture and a test asserting the live helper output still hashes to `GREENHOUSE_FIXTURE_HASH` (this is the parser-drift alarm spec §10.5 asks for).

- [ ] **Step 1: Write the failing tests** — from the committed fixture: first/last/email/phone/resume/linkedin all map to their canonical fields at 0.9; the demographics radios map to `demographics`; the "Why do you want to work at Northwind Robotics?" textarea maps to `screening_question`; unknown custom fields stay `unknown` at 0; `atsType` is greenhouse; the fixture-hash tripwire test.
- [ ] **Step 2: FAIL.** **Step 3: Implement + generate the fixture.** **Step 4: PASS + full autoapply suite.**
- [ ] **Step 5: Commit** — `feat(autoapply): greenhouse adapter with regression fixture`

---

### Task 6: Lever adapter + regression fixtures

**Files:**
- Create: `packages/autoapply/src/adapters/lever.ts`, `packages/autoapply/fixtures/lever-page.json`
- Modify: `packages/autoapply/src/index.ts`
- Test: `packages/autoapply/src/adapters/lever.test.ts`

**Interfaces:**
- Produces:
```ts
export function parseLever(page: RawFormPage): CanonicalForm;
// parseGenericForm with atsType "lever", parseConfidence 0.9, then Lever name-pattern hints:
//   name (single field) → full_name; email → email; phone → phone; org|company → current_company;
//   resume → resume_file; urls[LinkedIn]|cards[...][linkedin] → linkedin_url; urls[GitHub] → github_url;
//   urls[Portfolio] → portfolio_url; comments|additional_information → screening_question;
//   notice|availability → notice_period; salary|compensation → desired_salary;
//   work_auth|authorized → work_authorization; sponsor → visa_sponsorship;
// each hint sets mappingConfidence 0.9.
export const LEVER_FIXTURE_HASH: string;
export function parseForm(page: RawFormPage): CanonicalForm;
// The single entry point later tasks use: detectAts → parseGreenhouse | parseLever | parseGenericForm(generic, 0.4).
```
- [ ] **Step 1: Write the failing tests** — from the committed lever fixture: single `full_name`, resume→`resume_file`, notice-period select→`notice_period`, "Additional information" textarea→`screening_question`, `totalSteps` 1; the hash tripwire; PLUS `parseForm` dispatch tests (greenhouse fixture → greenhouse adapter output; lever fixture → lever; a marker-less page → generic at 0.4 confidence).
- [ ] **Step 2: FAIL.** **Step 3: Implement.** **Step 4: PASS + full autoapply suite + build + lint.**
- [ ] **Step 5: Commit** — `feat(autoapply): lever adapter and parseForm dispatch`

---

### Task 7: Core — deterministic field mapping and answer planning

**Files:**
- Create: `packages/core/src/autoapply/plan.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/autoapply/plan.test.ts`

**Interfaces:**
- Consumes: `classifyQuestionSensitivity`/`mergeSensitivityRulings` (P3), `CanonicalForm`, `PlannedAnswer`.
- Produces (pure — the deciding brain of the fill):
```ts
export interface ProfileValues {                   // deterministic identity/contact values from the Fact Bank
  full_name?: string; first_name?: string; last_name?: string; email?: string; phone?: string;
  location?: string; linkedin_url?: string; github_url?: string; portfolio_url?: string;
  current_company?: string; current_title?: string;
}
export interface SavedAnswerLike { questionNorm: string; answer: string; sourceFactIds: string[]; staleForReuse: boolean }
export interface PlanInputs {
  form: CanonicalForm;
  profile: ProfileValues;
  savedAnswers: SavedAnswerLike[];
  resumeDocumentId: string | null;                 // cv_variant id for file fields
  previouslyApproved: Record<string, string>;      // questionNorm → previously approved answer (for diffing)
}
export const MIN_FILL_CONFIDENCE = 0.7;
export function planAnswers(inputs: PlanInputs): { answers: PlannedAnswer[]; unresolved: string[] };
// Rules (test-pinned, in order per field):
// 1. sensitive fields (canonicalField ∈ {work_authorization, visa_sponsorship, desired_salary, demographics,
//    criminal_history, legal_attestation, notice_period, availability, relocation} OR
//    classifyQuestionSensitivity(label).sensitive) → source "user", needsUser true, confidence 0,
//    UNLESS an exact saved_answer exists for the normalized label (then source "saved_answer", needsUser false).
//    NEVER "ai" for these.
// 2. file fields → resume_file gets resumeDocumentId (source "document", confidence 1); missing → needsUser.
// 3. profile-mapped fields with a value → source "profile", confidence = field.mappingConfidence, needsUser when
//    confidence < MIN_FILL_CONFIDENCE.
// 4. screening_question / free-text with a saved answer (exact questionNorm match) → source "saved_answer",
//    confidence 0.9, needsUser false, staleForReuse → note "saved answer past review date" + needsUser true.
// 5. everything else → needsUser true, source "user", confidence 0, and its field id is listed in `unresolved`
//    (Task 11 offers AI drafting for the non-sensitive subset of these).
// differsFromApproved: true when a planned value for a questionNorm present in previouslyApproved differs from it.
export function requiresUserBeforeSubmit(answers: PlannedAnswer[], form: CanonicalForm): string[];
// field ids blocking submission: any REQUIRED field whose answer is missing/empty, or needsUser, or
// (sensitive AND source ∈ {ai}) — the last is a belt-and-braces invariant that must never trigger.
```
- [ ] **Step 1: Write the failing tests** — sensitive select (work authorization) → needsUser even when a plausible profile value exists, never `ai`; the same with an exact saved answer → filled from `saved_answer`; resume file → `document` with the id; unmapped custom textarea → unresolved + needsUser; low mappingConfidence (0.5) profile field → needsUser true; `differsFromApproved` true when the saved answer differs from `previouslyApproved`; stale saved answer → needsUser + note; `requiresUserBeforeSubmit` lists required-empty fields and returns `[]` for a fully planned form.
- [ ] **Step 2: FAIL.** **Step 3: Implement.** **Step 4: PASS + full core suite.**
- [ ] **Step 5: Commit** — `feat(core): deterministic auto-apply answer planning with sensitive-field blocking`

---

### Task 8: Worker — Playwright driver

**Files:**
- Create: `apps/worker/src/autoapply/driver.ts`, `apps/worker/src/autoapply/extract.ts`
- Modify: `apps/worker/package.json` (dep `playwright`, `@careerhq/autoapply`), `infra/Dockerfile.worker` (ensure browsers present — base image `mcr.microsoft.com/playwright:v1.56.0-jammy` for the runtime stage; document why), `infra/docker-compose.yml` + `.env.example` (`AUTOAPPLY_BROWSER_TIMEOUT_MS`, `DEMO_ATS_URL`), `packages/config/src/index.ts` (+ the two vars, + test)
- Test: `apps/worker/src/autoapply/driver.test.ts` (integration against demo-ats; skipIf the demo-ats probe fails)

**Interfaces:**
- Produces:
```ts
export interface BrowserSession { close(): Promise<void> }
export interface DriverDeps { timeoutMs: number }
export async function openSession(): Promise<BrowserSession>;                       // chromium.launch({headless:true})
export async function capturePage(session: BrowserSession, url: string, deps: DriverDeps): Promise<RawFormPage>;
// navigate, wait domcontentloaded, run the in-page extractor (extract.ts's EXTRACT_SCRIPT via page.evaluate),
// assign step indexes (fields hidden behind a "Next" button get incrementing steps by walking visible steps),
// return the RawFormPage. Throws DriverError (typed) on navigation/timeouts.
export async function fillAndSubmit(session: BrowserSession, args: {
  url: string; form: CanonicalForm; answers: PlannedAnswer[];
  files: Record<string, string>;     // fieldId → absolute file path
  deps: DriverDeps;
}): Promise<{ confirmationId: string | null; finalUrl: string; screenshotPng: Buffer; pageText: string }>;
// per step: set values by selector (fill/select/check/setInputFiles), click the step's Next; on the last step
// click Submit ONCE; then capture screenshot + final URL + text; confirmationId from
// [data-confirmation-id] or /Confirmation ID:\s*([A-Za-z0-9-]+)/ in the text.
export class DriverError extends Error { constructor(message: string, readonly kind: "navigation" | "timeout" | "fill" | "submit") }
```
- `extract.ts` exports `EXTRACT_SCRIPT` — a string of browser-side JS returning the `RawFormPage` shape (minus step assignment). It MUST use the same label/nearbyText rules as the Task 4 test helper; the driver test asserts parity: `capturePage(demo-ats greenhouse URL)` field ids/labels equal the helper's output over the same HTML (fetch the HTML separately and run the helper).
- Config additions: `autoapplyBrowserTimeoutMs` (default 45000), `demoAtsUrl` (default `http://demo-ats:3001`).

- [ ] **Step 1: Write the failing integration test** — probe `DEMO_ATS_URL ?? http://localhost:3001` and skip cleanly when absent; `capturePage` on the greenhouse page → ≥10 fields, totalSteps 3, parity with the pure helper; `capturePage` on the captcha page + `detectBlockers` → captcha; `fillAndSubmit` with a tiny PDF and a complete answer set → confirmationId matches `/^NR-[0-9a-f]{8}$/`, `/api/submissions` shows exactly one new submission with the expected email.
- [ ] **Step 2: FAIL.** **Step 3: Implement** (`pnpm install`; `pnpm --filter @careerhq/worker exec playwright install chromium` locally if the browser is missing — document if it cannot be installed in this sandbox and mark the affected tests skipped with a clear reason; the Dockerfile change stands either way).
- [ ] **Step 4: PASS (or documented skip) + full worker suite + repo gate; verify `docker compose config` carries the new vars.**
- [ ] **Step 5: Commit** — `feat(worker): playwright auto-apply driver with in-page extractor`

---

### Task 9: DB — form snapshots and site-attempt support

**Files:**
- Create: `packages/db/src/repos/form-snapshots.ts`
- Modify: `packages/db/src/schema/index.ts`, `packages/db/src/index.ts`; **extract** the channel-agnostic functions from `packages/db/src/repos/email-attempts.ts` into a new `packages/db/src/repos/attempts.ts` (pure move — `advance`, `recordPreview`, `getActiveConfirmation`, `getLatestConfirmation`, `beginSubmission`, `completeSubmission`, `failSubmission`, `markNeedsReconcile`, `resolveReconcile`, `hasBlockingAttempt`, `getAttempt`), leaving `email-attempts.ts` with only the email-specific `createEmailAttempt`/`updateEmailDraft` plus `export * from "./attempts.js"` so every existing import keeps working unchanged
- Create (generated): `packages/db/migrations/0005_*.sql`
- Test: `packages/db/src/repos/form-snapshots.test.ts`, extend `packages/db/src/repos/email-attempts.test.ts` (unchanged behavior after the extraction)

**Interfaces:**
- Produces:
```ts
// schema: form_snapshots per spec §12
export const formSnapshots = pgTable("form_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  attemptId: uuid("attempt_id").notNull().references(() => applicationAttempts.id, { onDelete: "cascade" }),
  atsType: text("ats_type").notNull(),                   // greenhouse|lever|generic
  url: text("url").notNull(),
  requisitionKey: text("requisition_key").notNull(),
  parserVersion: text("parser_version").notNull(),
  canonicalForm: jsonb("canonical_form").notNull(),      // CanonicalForm
  plannedAnswers: jsonb("planned_answers").notNull(),    // PlannedAnswer[]
  currentStep: integer("current_step").notNull().default(0),
  recoveryState: jsonb("recovery_state"),                // non-secret per-step progress
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("form_snapshots_attempt").on(t.attemptId, t.capturedAt)]);
// repos/form-snapshots.ts
export async function saveFormSnapshot(db: Db, input: { attemptId: string; form: CanonicalForm; answers: PlannedAnswer[] }): Promise<FormSnapshot>;
export async function getLatestSnapshot(db: Db, attemptId: string): Promise<FormSnapshot | null>;
export async function updateSnapshotAnswers(db: Db, snapshotId: string, answers: PlannedAnswer[]): Promise<FormSnapshot | null>;
export async function updateRecoveryState(db: Db, snapshotId: string, currentStep: number, recoveryState: unknown): Promise<void>;
export async function findRequisitionAttempt(db: Db, workspaceId: string, requisitionKey: string): Promise<{ attemptId: string; applicationId: string } | null>;
// joins attempts→applications for workspace scope; only CONFIRMED (status SUBMITTED) attempts count as duplicates
// repos/attempts.ts (extracted, channel-agnostic — email-attempts.ts keeps its existing exports by re-export)
export async function createSiteAttempt(db: Db, input: { applicationId: string; url: string }): Promise<ApplicationAttempt>;
// channel "company_site", status DRAFT, draft_payload { url }
export { recordPreview, getActiveConfirmation, getLatestConfirmation, beginSubmission, completeSubmission,
         failSubmission, markNeedsReconcile, resolveReconcile, hasBlockingAttempt, getAttempt } from "./attempts.js";
```
- The extraction must be behavior-preserving: `email-attempts.test.ts` continues to pass untouched.

- [ ] **Step 1: Write the failing tests** — snapshot save/get/update round trip; `updateSnapshotAnswers` replaces the array; `updateRecoveryState` persists step+state; `findRequisitionAttempt` returns the confirmed attempt for a duplicate key and `null` for a fresh key AND `null` when the only prior attempt FAILED (not a duplicate); `createSiteAttempt` yields channel `company_site` in DRAFT.
- [ ] **Step 2: FAIL.** **Step 3: Implement + `db:generate` (quote the migration SQL: 1 CREATE TABLE + index) + migrate on 5433.** **Step 4: PASS + FULL db suite (proving the extraction is clean) + repo gate.**
- [ ] **Step 5: Commit** — `feat(db): form snapshots, site attempts and channel-agnostic attempt repo`

---

### Task 10: AI — interpretField task

**Files:**
- Create: `packages/ai/src/tasks/interpret-field.ts`
- Modify: `packages/ai/src/index.ts`
- Test: `packages/ai/src/tasks/interpret-field.test.ts`

**Interfaces:**
- Produces:
```ts
export interface InterpretFieldInput {
  label: string; nearbyText: string; kind: FieldKind;
  options: Array<{ value: string; label: string }>;
  jobTitle: string; companyName: string;
}
export function buildInterpretPrompt(input: InterpretFieldInput): { system: string; user: string };
export async function interpretField(input: InterpretFieldInput, opts: FallbackOptions): Promise<FallbackResult<InterpretFieldResult>>;
// fast tier; schema interpretFieldResultSchema; system prompt lists the EXACT canonical field values and says:
// map the described form field to exactly one; answer "unknown" when unsure; NEVER guess a sensitive category
// (work_authorization, visa_sponsorship, desired_salary, demographics, criminal_history, legal_attestation) unless
// the label unambiguously says so; return confidence 0..1.
// isUseful: canonicalField ∈ CANONICAL_FIELDS (schema already guarantees) AND NOT (canonicalField is sensitive AND confidence < 0.8)
// — a low-confidence sensitive guess is useless; the caller must fall back to "unknown"/needsUser.
```
- [ ] **Step 1: Write the failing tests** — prompt contains every canonical field value and the sensitive-caution sentence; mocked valid response → ok; a sensitive canonicalField at 0.5 confidence → `not_useful` (single-model list); "unknown" at 0.9 → ok.
- [ ] **Step 2: FAIL.** **Step 3: Implement.** **Step 4: PASS + full ai suite.**
- [ ] **Step 5: Commit** — `feat(ai): interpretField task with sensitive-guess guard`

---

### Task 11: Web — auto-apply orchestrator (prepare / refine / confirm)

**Files:**
- Create: `apps/web/src/lib/site-submission.ts`
- Modify: `packages/config/src/index.ts` (+`submissionsLiveCompanySite`, `sandboxSiteAllowedHost`; compose web+worker + `.env.example` + tests)
- Test: `apps/web/src/lib/site-submission.test.ts` (real db, injected driver + AI)

**Interfaces:**
- Consumes: `parseForm`, `detectBlockers`, `planAnswers`, `requiresUserBeforeSubmit`, `interpretField`, `generateGrounded` (P3), the attempt/snapshot repos, `evaluateSubmissionGates` + `payloadFingerprint` + token helpers (`@careerhq/core/gates`).
- Produces:
```ts
export interface SiteSubmissionPayload {           // the fingerprinted artifact
  applicationId: string; url: string; host: string; requisitionKey: string;
  parserVersion: string; formHash: string;         // sha256 of canonicalJson(form.fields)
  answers: Array<{ fieldId: string; value: string; source: AnswerSource }>;
  attachments: Array<{ fieldId: string; filename: string; sha256: string }>;
}
export interface SiteDeps {
  db: Db; config: AppConfig;
  capture?: (url: string) => Promise<RawFormPage>;                 // injected; real impl calls the worker driver
  submit?: (args: { url: string; form: CanonicalForm; answers: PlannedAnswer[]; files: Record<string, string> }) =>
    Promise<{ confirmationId: string | null; finalUrl: string; screenshotPath: string; pageText: string }>;
  interpret?: typeof interpretField; generate?: typeof generateGrounded;
}
export type PrepareOutcome =
  | { status: "ready"; attemptId: string; snapshotId: string; form: CanonicalForm; answers: PlannedAnswer[]; blocking: string[] }
  | { status: "blocked"; kind: BlockerKind; detail: string }
  | { status: "duplicate"; existingApplicationId: string }
  | { status: "failed"; reason: string };
export async function prepareSiteApplication(deps: SiteDeps, args: { workspaceId: string; applicationId: string; url: string; overrideDuplicate?: boolean }): Promise<PrepareOutcome>;
// capture → detectBlockers (any → blocked, attempt marked BLOCKED with the reason) → parseForm →
// findRequisitionAttempt (duplicate unless overrideDuplicate, which appends an application_event
// {trigger:"user", payload:{duplicateOverride:true, requisitionKey}}) → load profile facts/saved answers/CV →
// planAnswers → for each unresolved NON-SENSITIVE field with an api key: interpretField (re-plan that field) and,
// for screening questions, generateGrounded (source "ai", visibly marked; validation per P3 — failures leave
// needsUser) → saveFormSnapshot → attempt DRAFT→READY when nothing blocks.
export async function updatePlannedAnswer(deps: SiteDeps, args: { workspaceId: string; snapshotId: string; fieldId: string; value: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
// user edits in the review screen → source "user", confidence 1, needsUser false; forbidden on file fields.
export type SitePreviewOutcome =
  | { status: "ok"; attemptId: string; fingerprint: string; payload: SiteSubmissionPayload; expiresAt: string; token: string }
  | { status: "blocked"; reason: string };
export async function previewSiteSubmission(deps: SiteDeps, args: { workspaceId: string; attemptId: string }): Promise<SitePreviewOutcome>;
// refuses while requiresUserBeforeSubmit is non-empty (reason lists the field labels)
export type SiteConfirmOutcome =
  | { status: "submitted"; confirmationId: string | null; finalUrl: string }
  | { status: "blocked"; code: string; reason: string }
  | { status: "failed"; reason: string }
  | { status: "needs_reconcile"; reason: string };
export async function confirmAndSubmitSite(deps: SiteDeps, args: { workspaceId: string; attemptId: string; presentedToken: string; retypedTarget: string }): Promise<SiteConfirmOutcome>;
// Mirrors P4's confirmAndSend EXACTLY: recompute fingerprint from current snapshot; gate inputs
// (env gate submissionsLiveCompanySite; sandboxTargetAllowed = payload.host === config.sandboxSiteAllowedHost;
// hasBlockingAttempt; retypedTarget vs payload.host); application-state pre-check (canTransition → SUBMITTED via
// "attempt") — the P4 final-review fix, same shape; beginSubmission (pending receipt) BEFORE deps.submit;
// submit → confirmationId present → completeSubmission (evidence: confirmationId, finalUrl, screenshotPath,
// pageTextExcerpt ≤500) → submitted; submit throws → markNeedsReconcile (a click may have landed — NEVER failSubmission
// after the click); refused completeSubmission after a real submit → markNeedsReconcile.
```
- [ ] **Step 1: Write the failing tests** (injected capture/submit/AI stubs, real db): blocked capture (captcha fixture) → blocked + attempt BLOCKED; duplicate requisition → duplicate, and with `overrideDuplicate` → ready + event logged; sensitive field never receives an AI value even when `interpret`/`generate` stubs would supply one (spy: generate never called for sensitive fields); preview refused while a required field needsUser; tampered snapshot answers after preview → confirm `fingerprint_mismatch`; wrong retyped host → `target_mismatch`; env gate off → `gate_closed`; happy path → submitted with receipts + application SUBMITTED; submit-throws → needs_reconcile (never failed).
- [ ] **Step 2: FAIL.** **Step 3: Implement.** **Step 4: PASS + full repo gate + `docker compose config` for the two new vars.**
- [ ] **Step 5: Commit** — `feat(web): gated auto-apply orchestrator with duplicate override and blockers`

---

### Task 12: Web — auto-apply review screen and confirm UI

**Files:**
- Create: `apps/web/src/app/(dashboard)/applications/[id]/site-panel.tsx` (client), `apps/web/src/app/(dashboard)/applications/[id]/site-actions.ts`
- Modify: `apps/web/src/app/(dashboard)/applications/[id]/page.tsx` (render `<SitePanel/>` with server-fetched attempts + latest snapshot)

**Interfaces:**
- Actions (thin zod wrappers over Task 11): `prepareSiteApplicationAction({applicationId, url, overrideDuplicate?})`, `updatePlannedAnswerAction({snapshotId, fieldId, value})`, `previewSiteSubmissionAction({attemptId})`, `confirmAndSubmitSiteAction({attemptId, presentedToken, retypedTarget})`, `resolveReconcileAction` (reuse P4's).
- **Review screen (spec §10.2.8 — this is the phase's showpiece):** URL input + Prepare button; blocked outcome → the blocker kind and a "handle this manually" explanation with the link; duplicate outcome → the existing application link + an explicit "Apply anyway" override button; ready → the parsed form rendered field by field, grouped by step, each row showing: label (+ required marker), the planned value in an editable input, a **source badge** (`fact`/`saved answer`/`profile`/`AI — not yet approved`/`you`/`document`), confidence, a **"needs your answer"** highlight, and a **"differs from previously approved"** marker; sensitive fields carry a lock badge and the note "CareerHQ never fills this automatically"; a summary bar with counts (`n fields · m need you`) and a Preview button DISABLED while any blocking field remains.
- Preview → review payload (host, requisition key, answer count, attachment filename + sha prefix, fingerprint prefix, expiry countdown) + retype-the-host confirm input → outcome panes identical in shape to the email panel (submitted shows confirmation id + final URL + a link to the stored screenshot path; blocked shows gate code; needs_reconcile offers the two resolution buttons).
- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify manually** (this host): demo-ats running (`pnpm --filter @careerhq/demo-ats dev`), dev server with `SUBMISSIONS_LIVE_COMPANY_SITE=true`, `SANDBOX_SITE_ALLOWED_HOST=localhost`, master key set; drive the real actions: prepare against `http://localhost:3001/greenhouse/jobs/eng-1` → review shows sensitive selects as needs-you; fill them; preview; confirm with the retyped host → submitted with a confirmation id; check `/api/submissions`. Then: prepare the captcha URL → blocked pane; prepare the same greenhouse URL twice → duplicate pane + override. Transcripts in the report.
- [ ] **Step 3: Typecheck + lint + web tests.**
- [ ] **Step 4: Commit** — `feat(web): auto-apply review screen with per-answer provenance and gated submit`

---

### Task 13: Worker — autoapply job wiring

**Files:**
- Create: `apps/worker/src/jobs/autoapply.ts`
- Modify: `apps/worker/src/main.ts`
- Test: `apps/worker/src/jobs/autoapply.test.ts`

**Interfaces:**
- Produces the queue side so the web app never launches a browser in a request:
```ts
export interface CaptureJobData { workspaceId: string; applicationId: string; attemptId: string; url: string }
export interface SubmitJobData { workspaceId: string; attemptId: string }
export async function runCaptureJob(db: Db, config: AppConfig, data: CaptureJobData): Promise<void>;
// opens a session, capturePage, stores the RawFormPage on the attempt's snapshot recoveryState
// ({ kind: "raw_page", page }) so the web orchestrator can parse without a browser; closes the session always.
export async function runSubmitJob(db: Db, config: AppConfig, data: SubmitJobData): Promise<void>;
// reads the snapshot + planned answers + resolved file paths, calls fillAndSubmit, writes the screenshot under
// `${fileStorageDir}/autoapply/${attemptId}.png`, and records the result on the snapshot recoveryState
// ({ kind: "submit_result", confirmationId, finalUrl, screenshotPath, pageText }) — the web orchestrator's
// injected `submit` in production reads this back; never transitions the attempt itself (the gate owns that).
// main.ts registers queues `autoapply.capture` and `autoapply.submit` (no cron — enqueued on demand).
```
- Design note to state in the report: P5 keeps the browser in the worker and passes results through the snapshot, so the gated decision path stays in one place (web) exactly as P4 established.
- [ ] **Step 1: Write the failing test** — stubbed driver functions; capture job persists the raw page on the snapshot; submit job writes the screenshot file and the result blob; a driver throw leaves the attempt untouched and records nothing partial.
- [ ] **Step 2: FAIL.** **Step 3: Implement.** **Step 4: PASS + full worker suite + repo gate.**
- [ ] **Step 5: Commit** — `feat(worker): autoapply capture and submit queue jobs`

---

### Task 14: End-to-end — demo-ats gated auto-apply round trip

**Files:**
- Create: `apps/web/src/lib/site-e2e.test.ts`

**Interfaces:**
- The DoD proof, mirroring P4's Mailpit suite: skipIf no `TEST_DATABASE_URL`; probe demo-ats (`GET /api/submissions`) and skip cleanly when absent; the browser must REALLY run.
- **Cross-app wiring (do this in this task):** `apps/worker` is an app, not a library, so `apps/web` cannot import it. Add `"exports": { "./autoapply": { "types": "./dist/autoapply/index.d.ts", "default": "./dist/autoapply/index.js" } }` to `apps/worker/package.json`, create `apps/worker/src/autoapply/index.ts` re-exporting `openSession`/`capturePage`/`fillAndSubmit`/`DriverError`, and add `"@careerhq/worker": "workspace:*"` as a **devDependency** of `apps/web` (test-only — assert in the report that no `apps/web/src` production file imports it; a lint-style grep suffices). The e2e test then injects `capture`/`submit` built on those real driver functions. If dependency-cruiser objects to an app→app edge, scope the rule to production paths (exclude `*.test.ts`) rather than weakening it — explain the change in the report.
- Cases: (1) full round trip — application + CV + approved doc → prepare against the greenhouse URL → fill the needs-you sensitive fields via `updatePlannedAnswer` → preview → confirm with the correct token + retyped host → submitted; `/api/submissions` shows exactly one submission whose email matches the fact-bank email and whose resume filename matches the CV variant; application state SUBMITTED; the screenshot file exists. (2) gate off → `gate_closed`. (3) tampered answer after preview → `fingerprint_mismatch`. (4) wrong host retyped → `target_mismatch`. (5) second prepare for the same requisition → `duplicate`. (6) captcha URL → `blocked` with kind `captcha` and NO submission recorded.
- Cleanup: `DELETE /api/submissions` in `afterAll`.
- [ ] **Step 1: Write the test; run it. Fix any integration bugs it surfaces (report them as findings).**
- [ ] **Step 2: Full gate.** **Step 3: Commit** — `test(web): demo-ats gated auto-apply end-to-end`

---

### Task 15: ADR-0007, README, roadmap, full verification

**Files:**
- Create: `docs/adr/0007-canonical-form-schema.md`
- Modify: `README.md`, `docs/roadmap.md`, `docs/architecture.md` (system diagram gains demo-ats + the autoapply package)
- [ ] **Step 1: Write ADR-0007** (~35 lines, 0003/0004/0005 style): DOM selectors are implementation details, never the data model (spec §10.3) — the browser returns a serializable `RawFormPage` and every decision is a pure function over it; consequences: adapters are fixture-testable without a browser, parser drift is caught by hash tripwires + `parserVersion`, the same review/gate path serves any future channel; honest cost: the in-page extractor duplicates the label/nearbyText rules and is kept honest by a parity test.
- [ ] **Step 2: README** — auto-apply into shipped features (parse → review with provenance → gated submit; Greenhouse/Lever/generic; blockers pause and return control; duplicate override; demo-ats as the only demo destination); env table gains `SUBMISSIONS_LIVE_COMPANY_SITE`, `SANDBOX_SITE_ALLOWED_HOST`, `DEMO_ATS_URL`, `AUTOAPPLY_BROWSER_TIMEOUT_MS`; the local demo recipe; **P1–P5 done in BOTH status locations** (the recurring check); roadmap P5 marked done with any new carried backlog.
- [ ] **Step 3: Full gate** — `pnpm lint && pnpm typecheck && pnpm depcruise && TEST_DATABASE_URL=postgres://careerhq:careerhq@localhost:5433/careerhq pnpm test`; paste tails; grep tests for network calls (Mailpit/demo-ats/localhost allowed; everything else forbidden) and state the result.
- [ ] **Step 4: Commit** — `docs: ADR-0007 canonical form schema, README auto-apply`

---

## Final Verification (Definition of Done for P5)

1. Full gate green; only localhost services (Postgres, Mailpit, demo-ats) touched by tests.
2. Parsing is browser-free and fixture-tested: Greenhouse and Lever adapters produce the canonical schema from committed fixtures, with hash tripwires guarding drift and `parserVersion` recorded on every snapshot.
3. The review screen shows EVERY answer with its source; AI-drafted text is visibly marked; low-confidence/unanswered/differs-from-approved are flagged; Preview is impossible while any required field still needs the user.
4. Sensitive fields are never AI-filled — spy-proven in the orchestrator tests and enforced twice (planner + `requiresUserBeforeSubmit`).
5. The same three-layer gate governs the final click: env gate off → `gate_closed`; sandbox host mismatch → `sandbox_blocked`; tampered answers → `fingerprint_mismatch`; wrong retyped host → `target_mismatch`; duplicate → refused with an explicit override path recorded in the event log.
6. Pending receipt precedes the click; confirmation evidence (id, final URL, screenshot) lands in the confirmed receipt; a throwing submit becomes `NEEDS_RECONCILE`, never `FAILED`.
7. Blockers (captcha, login, assessment, attestation, unsupported upload) pause with a typed reason and no attempt to bypass.
8. Real e2e against demo-ats proves the round trip and all five refusals.
9. P4 backlog burned (subdomain threading, per-folder sync state, concurrency + crypto tests, UI copy).
10. Compose carries every new env var on the right services (verified in the introducing task).
