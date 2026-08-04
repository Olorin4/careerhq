# Attestation → Field-Level Explicit Consent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Demote a *required checkbox* legal attestation from a page-level blocker to a field-level explicit-consent tick the user checks themselves in the review screen — keeping the page-level pause for attestations we cannot render honestly (typed signature, legal-name retype, signature date) — and close the saved-answer reuse hole that demotion would otherwise open.

**Architecture:** Three pure changes drive everything: `blockers.ts` stops blocking on checkbox attestations and starts blocking on *non-checkbox* attestation controls; the Greenhouse/Lever adapters map the attestation checkbox to `canonicalField: "legal_attestation"`; `plan.ts` Rule 1 refuses saved-answer reuse for `legal_attestation`/`criminal_history` so consent is always freshly given. The review screen then renders that field as a consent tick showing the attestation's full text. `demo-ats` gains a signature-style page as the new blocked-proof fixture.

**Tech Stack:** unchanged — TS strict ESM, Vitest, Next.js 15, Playwright, Hono.

## Global Constraints

- **The safety property is unchanged and non-negotiable:** CareerHQ must never agree to a legal statement on the user's behalf. Demotion is only legitimate because the user personally ticks the box in the review screen, having seen its exact text — spec §10.6's "pause and return control to the user" is satisfied *more* precisely, not less.
- A demoted attestation field MUST always be `needsUser: true` with `source: "user"` until the user acts — never `profile`, never `ai`, and (new) never `saved_answer`.
- **Non-checkbox attestations still block.** A typed signature, a "type your full legal name" input, or a signature-date field next to attestation language cannot be rendered as an honest tick, so `legal_attestation` remains a page-level pause for them.
- Consent is per application: `legal_attestation` and `criminal_history` are excluded from the saved-answer reuse path in `planAnswers`, so a previously approved answer on a *different* application can never auto-satisfy this one.
- The tick, once given, is `source: "user"` and therefore inside the fingerprinted payload — the exact attestation the user consented to is covered by the retype-and-token gate and recorded in the receipt.
- Repo conventions: TS strict, no `any`; ESM `.js` specifiers; db/e2e tests `skipIf` with the established harness (`postgres://careerhq:careerhq@localhost:5433/careerhq`, demo-ats on `localhost:3001`); conventional commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; fixture hash tripwires must be regenerated deliberately and the behavior change stated, never silently re-baselined.

---

### Task 1: Core logic — demote the checkbox, block the signature, refuse reuse

**Files:**
- Modify: `packages/autoapply/src/blockers.ts`, `packages/autoapply/src/adapters/greenhouse.ts`, `packages/autoapply/src/adapters/lever.ts`, `packages/core/src/autoapply/plan.ts`
- Test: `packages/autoapply/src/blockers.test.ts`, `packages/autoapply/src/adapters/greenhouse.test.ts`, `packages/core/src/autoapply/plan.test.ts`

**Interfaces:**
- Produces (behavior changes; no new exported symbols except the adapter hint):
  - `detectBlockers`: a **required checkbox** whose label/nearbyText matches the attestation regex no longer produces a `legal_attestation` blocker. A **non-checkbox** control (`input` of type `text`/`date`, or a `textarea`) whose label/nearbyText matches the attestation regex **does** produce one, with detail naming the control. Optional checkbox attestations remain non-blocking (unchanged).
  - Greenhouse + Lever adapters: a checkbox field whose name/id/label matches `/certif|attest|acknowledg|agree/i` maps to `canonicalField: "legal_attestation"` at `mappingConfidence: 0.9`.
  - `planAnswers` Rule 1: for `canonicalField ∈ {legal_attestation, criminal_history}`, ignore any matching saved answer and always return the user draft (`needsUser: true`, `source: "user"`). Export `CONSENT_ONLY_FIELDS: ReadonlySet<CanonicalField>` holding those two so the UI can key off the same set instead of duplicating the list.

- [ ] **Step 1: Write the failing tests**

`packages/autoapply/src/blockers.test.ts` — replace the existing required-checkbox-attestation case and add the new ones:
```ts
it("does NOT block on a required attestation CHECKBOX (it becomes a consent tick)", () => {
  const page = pageWith([
    field({ selector: "#ack", tag: "input", type: "checkbox", required: true,
            labelText: "I certify that the information provided is accurate" }),
  ]);
  expect(detectBlockers(page).map((b) => b.kind)).not.toContain("legal_attestation");
});
it("still blocks on a typed-signature attestation (not renderable as a tick)", () => {
  const page = pageWith([
    field({ selector: "#sig", tag: "input", type: "text", required: true,
            labelText: "Type your full legal name to certify this application" }),
  ]);
  const blockers = detectBlockers(page);
  expect(blockers.map((b) => b.kind)).toContain("legal_attestation");
  expect(blockers.find((b) => b.kind === "legal_attestation")?.detail).toContain("#sig");
});
it("still blocks on a signature-date attestation", () => {
  const page = pageWith([
    field({ selector: "#sigdate", tag: "input", type: "date", required: true,
            labelText: "Date of signature — I attest the above is true" }),
  ]);
  expect(detectBlockers(page).map((b) => b.kind)).toContain("legal_attestation");
});
it("does not block on an optional attestation checkbox", () => {
  const page = pageWith([
    field({ selector: "#opt", tag: "input", type: "checkbox", required: false,
            labelText: "I acknowledge the privacy notice" }),
  ]);
  expect(detectBlockers(page).map((b) => b.kind)).not.toContain("legal_attestation");
});
```
(Use the file's existing `pageWith`/`field` helpers; if they are named differently, follow the file's own convention rather than inventing new ones.)

`packages/autoapply/src/adapters/greenhouse.test.ts` — the existing test asserting the attestation checkbox stays `"unknown"` is now wrong; change it to:
```ts
it("maps the required attestation checkbox to legal_attestation", () => {
  const form = parseGreenhouse(loadFixtureRawPage());
  const ack = form.fields.find((f) => f.kind === "checkbox");
  expect(ack?.canonicalField).toBe("legal_attestation");
  expect(ack?.mappingConfidence).toBe(0.9);
});
```

`packages/core/src/autoapply/plan.test.ts`:
```ts
it("never reuses a saved answer for a legal attestation — consent must be fresh", () => {
  const form = formWith([
    canonicalFormFieldSchema.parse({
      id: "ack", kind: "checkbox", required: true,
      label: "I certify that the information provided is accurate",
      canonicalField: "legal_attestation", mappingConfidence: 0.9,
    }),
  ]);
  const { answers } = planAnswers({
    form, profile: {}, resumeDocumentId: null, previouslyApproved: {},
    savedAnswers: [{
      questionNorm: normalizeQuestion("I certify that the information provided is accurate"),
      answer: "true", sourceFactIds: [], staleForReuse: false,
    }],
  });
  expect(answers[0]?.source).toBe("user");
  expect(answers[0]?.needsUser).toBe(true);
  expect(answers[0]?.value).toBe("");
});
it("never reuses a saved answer for criminal history", () => {
  const form = formWith([
    canonicalFormFieldSchema.parse({
      id: "ch", kind: "select", required: true, label: "Have you ever been convicted of a felony?",
      canonicalField: "criminal_history", mappingConfidence: 0.9,
    }),
  ]);
  const { answers } = planAnswers({
    form, profile: {}, resumeDocumentId: null, previouslyApproved: {},
    savedAnswers: [{ questionNorm: normalizeQuestion("Have you ever been convicted of a felony?"),
                     answer: "No", sourceFactIds: [], staleForReuse: false }],
  });
  expect(answers[0]?.source).toBe("user");
  expect(answers[0]?.needsUser).toBe(true);
});
it("still reuses a saved answer for other sensitive fields (e.g. notice period)", () => {
  const form = formWith([
    canonicalFormFieldSchema.parse({
      id: "np", kind: "text", required: true, label: "What is your notice period?",
      canonicalField: "notice_period", mappingConfidence: 0.9,
    }),
  ]);
  const { answers } = planAnswers({
    form, profile: {}, resumeDocumentId: null, previouslyApproved: {},
    savedAnswers: [{ questionNorm: normalizeQuestion("What is your notice period?"),
                     answer: "Two weeks", sourceFactIds: [], staleForReuse: false }],
  });
  expect(answers[0]?.source).toBe("saved_answer");
  expect(answers[0]?.needsUser).toBe(false);
});
```
(Use the file's existing form/field builders; the third test guards against over-broad refusal.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @careerhq/autoapply test && pnpm --filter @careerhq/core test`
Expected: the new blocker/adapter/plan cases FAIL; the previously-passing "required checkbox blocks" and "attestation stays unknown" assertions are the ones you replaced.

- [ ] **Step 3: Implement**

`blockers.ts` — replace the attestation loop:
```ts
  // A REQUIRED ATTESTATION CHECKBOX IS NOT A BLOCKER (spec §10.6, revised):
  // it is demoted to a field-level consent tick the user checks personally in
  // the review screen, having seen its exact text. That returns control to the
  // user more precisely than abandoning the attempt — and the tick, being
  // source "user", lands inside the fingerprinted payload and the receipt.
  //
  // What we still cannot render honestly is an attestation that is not a simple
  // yes/no: a typed signature, a "type your full legal name" input, or a
  // signature date. Those still pause the page.
  for (const field of page.fields) {
    const isCheckbox = field.tag === "input" && field.type === "checkbox";
    if (isCheckbox) continue;
    const isTypedControl =
      field.tag === "textarea" || (field.tag === "input" && ["text", "date"].includes(field.type));
    if (!isTypedControl || !field.required) continue;
    const text = `${field.labelText} ${field.nearbyText}`;
    if (ATTESTATION_RE.test(text)) {
      blockers.push({
        kind: "legal_attestation",
        detail: `${field.selector}: ${field.labelText || field.nearbyText}`,
      });
    }
  }
```
Update the doc comment above `detectBlockers` to match (it currently states the opposite rule).

`adapters/greenhouse.ts` and `adapters/lever.ts` — add a kind-aware hint so a checkbox matching `/certif|attest|acknowledg|agree/i` on name/id/label maps to `legal_attestation` at 0.9. Follow each file's existing hint-application structure exactly (they already support kind-aware targets from the P5 cover-letter fix).

`packages/core/src/autoapply/plan.ts`:
```ts
/**
 * Consent must be given freshly, per application: an attestation or a criminal-history
 * disclosure approved on ANOTHER application can never auto-satisfy this one, because
 * reusing it would amount to CareerHQ answering on the user's behalf.
 */
export const CONSENT_ONLY_FIELDS: ReadonlySet<CanonicalField> = new Set<CanonicalField>([
  "legal_attestation",
  "criminal_history",
]);
```
and in Rule 1:
```ts
  if (isSensitiveField(field)) {
    if (CONSENT_ONLY_FIELDS.has(field.canonicalField)) return userDraft(CONSENT_NOTE, false);
    return saved ? savedAnswerDraft(saved) : userDraft(SENSITIVE_NOTE, false);
  }
```
with `const CONSENT_NOTE = "you must answer this yourself for each application";` beside `SENSITIVE_NOTE`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @careerhq/autoapply test && pnpm --filter @careerhq/core test`
Expected: PASS. The Greenhouse fixture-hash tripwire must STILL pass — the fixture is the raw page, unaffected by mapping changes. If it fails, stop: something changed the extraction, not the mapping.

- [ ] **Step 5: Commit**

```bash
git add packages/autoapply packages/core
git commit -m "feat(autoapply,core): demote checkbox attestations to field-level consent

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: demo-ats — a signature-style attestation page for the blocked proof

**Files:**
- Modify: `apps/demo-ats/src/pages.ts`, `apps/demo-ats/src/main.ts`
- Test: `apps/demo-ats/src/pages.test.ts`

**Interfaces:**
- Consumes: the Task 1 rule (non-checkbox attestation blocks).
- Produces: `signaturePage(job)` exported from `pages.ts` and served at `GET /signature/jobs/:id` — a Lever-style single-page form that is complete and fillable EXCEPT that it ends with a required **text** input labelled `Type your full legal name to certify this application is true and complete` plus a required **date** input labelled `Date of signature`. It must include a resume file input (so `login_required`'s no-password rule and `unsupported_file_control` do not fire) and must NOT contain a password input or captcha marker — the only blocker it triggers is `legal_attestation`.

- [ ] **Step 1: Write the failing test**

`apps/demo-ats/src/pages.test.ts`:
```ts
it("signature page carries a typed-signature and date attestation, no checkbox", () => {
  const html = signaturePage(job);
  expect(html).toContain('data-source="lever"');
  expect(html.toLowerCase()).toContain("type your full legal name");
  expect(html.toLowerCase()).toContain("date of signature");
  expect(html).toContain('name="resume"');
  expect(html).not.toContain('type="password"');
  expect(html).not.toContain("g-recaptcha");
});
```
- [ ] **Step 2: FAIL run** — `pnpm --filter @careerhq/demo-ats test`.
- [ ] **Step 3: Implement** `signaturePage` (copy `leverPage`'s structure; swap its notice-period section for the two signature controls) and register `GET /signature/jobs/:id` in `main.ts` beside the existing job routes.
- [ ] **Step 4: PASS run** — `pnpm --filter @careerhq/demo-ats test`; then rebuild and smoke it: `pnpm --filter @careerhq/demo-ats build`, restart the local instance on 3001, and `curl -s localhost:3001/signature/jobs/sig-1 | grep -c "legal name"` → 1. Paste the transcript.
- [ ] **Step 5: Commit** — `feat(demo-ats): signature-style attestation page for the blocked-pause fixture`

---

### Task 3: Review screen — render the consent tick

**Files:**
- Modify: `apps/web/src/app/(dashboard)/applications/[id]/site-panel.tsx`

**Interfaces:**
- Consumes: `CONSENT_ONLY_FIELDS` from `@careerhq/core`; the planner's `needsUser`/`source` on each answer.
- Produces (UI behavior):
  - A field whose `canonicalField` is in `CONSENT_ONLY_FIELDS` renders as a **consent row**, visually distinct from the ordinary sensitive lock row: the field's **full label text is shown in full** (not truncated — this is the statement being agreed to), above an explicit control.
  - For `kind === "checkbox"`: an actual checkbox input, unchecked by default, whose label is `I agree to this statement` — ticking it calls `updatePlannedAnswerAction` with value `"true"`; unticking sets `""`. Never pre-ticked, regardless of any stored value on first render of a fresh plan.
  - Copy on the row: **"You must tick this yourself — CareerHQ never agrees to legal statements on your behalf."** (replacing the generic "CareerHQ never fills this automatically" for these fields only).
  - For non-checkbox consent fields (`criminal_history` selects/text), keep the existing needs-you input but use the same consent copy.
  - The summary bar's needs-you count and the Preview gate are unchanged — they already key off `needsUser`, which stays true until the user acts.

- [ ] **Step 1: Implement** the consent row in `FieldRow`/`FieldInput` (follow the file's existing badge/row conventions; do not duplicate `isSensitiveField` logic — import the set).
- [ ] **Step 2: Verify manually** — demo-ats on 3001; dev server with `SUBMISSIONS_LIVE_COMPANY_SITE=true`, `SANDBOX_SITE_ALLOWED_HOST=localhost`, `CAREERHQ_MASTER_KEY` set, `DATABASE_URL` on 5433. Drive the real server actions: prepare against `http://localhost:3001/greenhouse/jobs/eng-1` → it now reaches **ready** (previously blocked); the attestation row renders with its full text, unticked, blocking Preview; tick it via `updatePlannedAnswerAction` with `"true"` → needsUser clears; fill the remaining needs-you fields; preview → confirm with the retyped host → submitted; confirm via `curl localhost:3001/api/submissions` that the attestation field arrived as ticked. Also: prepare `http://localhost:3001/signature/jobs/sig-1` → **blocked** with kind `legal_attestation`. Paste both transcripts.
- [ ] **Step 3: Typecheck + lint + web tests.**
- [ ] **Step 4: Commit** — `feat(web): render legal attestations as an explicit consent tick`

---

### Task 4: e2e, docs, and the full gate

**Files:**
- Modify: `apps/web/src/lib/site-e2e.test.ts`, `README.md`, `docs/roadmap.md`, `docs/adr/0007-canonical-form-schema.md`

**Interfaces:**
- e2e updates:
  - The existing `blocked / legal_attestation` case currently prepares the Greenhouse attestation job. Repoint it at `/signature/jobs/<id>` (still asserting kind `legal_attestation` and that NO submission was recorded).
  - Add a case proving the demotion end-to-end: prepare the Greenhouse job → `ready`; assert the attestation field is present with `needsUser: true` and `source: "user"`; `updatePlannedAnswer` it to `"true"`; resolve the other needs-you fields; preview → confirm → `submitted`; assert the recorded demo-ats submission carries the attestation field as ticked.
  - Keep the captcha case unchanged.
- Docs:
  - `docs/adr/0007-canonical-form-schema.md` — append a short "Revision (2026-08-04)" note: required checkbox attestations are field-level consent; non-checkbox attestations still pause; consent is never reused across applications.
  - `README.md` — update the auto-apply feature description wherever it states that attestations block, and mention the consent tick.
  - `docs/roadmap.md` — remove the P6 "reconsider promoting attestation" note (now done) and record it as delivered.
- [ ] **Step 1: Update the e2e cases; run them** (demo-ats + Postgres up): `TEST_DATABASE_URL=postgres://careerhq:careerhq@localhost:5433/careerhq pnpm --filter @careerhq/web test`.
- [ ] **Step 2: Write the docs changes.**
- [ ] **Step 3: Full gate** — `pnpm lint && pnpm typecheck && pnpm depcruise && pnpm build && TEST_DATABASE_URL=… pnpm test --force` (uncached, default concurrency). Paste tails.
- [ ] **Step 4: Commit** — `test(web),docs: attestation consent end-to-end and ADR revision`

---

## Final Verification (Definition of Done)

1. A required attestation **checkbox** no longer blocks: the Greenhouse demo job reaches `ready` and can be submitted after the user personally ticks it.
2. A **typed-signature/date** attestation still pauses the attempt with kind `legal_attestation` and records no submission.
3. The consent field is never pre-ticked, never `profile`/`ai`-sourced, and never satisfied by a saved answer from another application (unit-proven for both `legal_attestation` and `criminal_history`, with a guard test proving other sensitive fields still reuse saved answers).
4. The ticked value is `source: "user"` and therefore inside the fingerprinted payload and the confirmed receipt.
5. Full gate green, uncached, at default concurrency.
