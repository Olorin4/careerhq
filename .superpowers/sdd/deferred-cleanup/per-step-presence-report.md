# Per-step presence — the field that disappears between review and submit

**Branch** `feature/deferred-cleanup` · **baseline** `b29b335` (1,143 tests) ·
**commits** `00d443f` (fixture), `feb6434` (fix), `04faf78` (roadmap + this report)

Driven as the bug manifests **before** the fix and re-measured against the same harness after.
Every claim below is asserted against demo-ats's `/api/submissions` — what the site actually
received — never against the driver's return value.

---

## 1 · The defect

`assertReviewedFieldsIntact` (`apps/worker/src/autoapply/driver.ts`) walks the fields the user
reviewed and requires, for each one the user *decided* about, that the live page still has that
control, still asking that question, still as the same kind of control. It had one exemption:

```ts
const renderedSteps = new Set<number>([0, ...liveFields.map((field) => field.step)]);
…
if (live === undefined) {
  if (!renderedSteps.has(reviewed.step)) continue;   // ← the hole
```

The intent was right — a multi-step form whose later controls appear only after "Next" is
legitimate, and refusing it would break every such ATS. The **inference** was not. "Which steps
are rendered" was read off a single pre-click extraction, so a wizard that *replaces* its later
step instead of revealing it (step 2 not in the DOM until Next swaps it in, step 1 removed when
it does) looks at that moment like a one-step form. Every reviewed field beyond it is written
off as "a step this page has not rendered yet" and is never judged — including a consent tick.

`demo-ats` could not express that shape at all: every multi-step page there (`greenhousePage`)
renders all of its steps up front. That is exactly why the gap survived with no test, as the
roadmap said.

## 2 · The fixture (`00d443f`)

`steppedConsentPage(job, "all" | "replaced")` — one two-step form, two renderings, both posting
to `/stepped/apply/:id`:

- `"all"` (`GET /stepped/jobs/:id`) — both steps in the DOM as inert markup. What a review
  captures: the background-check statement is readable and its box is **pre-ticked**.
- `"replaced"` (`GET /stepped-progressive/jobs/:id`) — step 1 only. A script carries step 2 and,
  on "Next", clears the wizard, re-adds step 1's values as hidden inputs (what a real wizard
  does, and what keeps the posted body a complete application) and inserts step 2.

The attack is the pair: reviewed as `"all"`, served as `"replaced"`.

## 3 · Before / after, against `/api/submissions`

The plan in both runs is the consent case verbatim — name and email answered, and the
background-check box **declined** (`""`, what the review screen's consent row commits on
untick). It is the only step-2 control the plan decides about.

**Before** (`renderedSteps` exemption in place, new test run against it):

```
 FAIL  driver against a wizard whose later step is replaced, not revealed >
       refuses when the step carrying the reviewed consent is replaced instead of revealed
AssertionError: expected { refused: null, …(2) } to deeply equal { refused: 'fill', …(2) }
- Expected                                    + Received
-   "confirmationId": null,                   +   "confirmationId": "NR-11447f54",
-   "recorded": [],                           +   "recorded": [ {
-   "refused": "fill",                        +       "available_from": "",
                                              +       "background_check_consent": "true",
                                              +       "email": "ada@example.com",
                                              +       "name": "Ada Lovelace",
                                              +   } ],
                                              +   "refused": null,
```

demo-ats recorded `background_check_consent: "true"` — the receipt says the user declined. This
is the consent-integrity failure the whole check exists to prevent, reached through a shape the
check could not see.

**After** (`feb6434`):

```
 ✓ refuses when the step carrying the reviewed consent is replaced instead of revealed  460ms
 ✓ still submits a progressive wizard that is reviewed and submitted in the same shape  808ms
 ✓ does not refuse a replaced step the user made no decision on                         660ms
```

with the refusal asserted as `{ refused: "fill", confirmationId: null, recorded: [] }` and the
message:

```
refusing to fill the form at http://localhost:33603/stepped/jobs/stepped-consent-dca3b9c1:
the control the user answered ("I consent to Northwind Robotics carrying out a background
check.") is no longer on the page
```

Nothing reached the site: `recorded: []` for that job id, not merely "something threw".

## 4 · The design, and why it is smaller than "per-step presence in general"

**Chosen:** delete the step scoping from the presence test; judge a decided reviewed field by
whether the driver can reach it at all.

The reasoning is grounded in what the caller can actually do. `fillAndSubmit` fills from
`plannedFills(extracted.fields, …)` — the pre-click extraction, and nothing else. A control that
is not in it is a control the driver will **never** type into, tick or untick, on any step,
however many "Next" clicks later it appears. So for a field the user decided about, absent from
the extraction means precisely one thing: that decision will not reach the form, and whatever
the page ships instead will. There is no step on which that is acceptable, so there is no step
test left.

It does not break the case the exemption was protecting, because that case **cannot produce the
input the exemption was skipping**: a form whose later controls only exist after a click is
captured the same way at *review* time, so the reviewed snapshot has no fields on those steps
either and the loop never reaches them. The exemption was skipping only inputs where the
reviewed page and the live page genuinely disagree — i.e. exactly the bug.

**Why not a real per-step mechanism** (verify → advance → re-extract → verify): a refusal after
a "Next" click is not provably pre-click. `advance` is deliberately outside
`PRE_CLICK_DRIVER_ERROR_KINDS` because a next-labelled button can turn out to be the submit, so
any refusal raised after the first advance would either lie about being pre-click or park the
attempt in NEEDS_RECONCILE and spend the confirmation token — the failure mode `a1fc4d0` fixed.
A mechanism that can only refuse *before* the first click cannot judge steps that do not exist
before the first click; the honest move is to notice that it does not need to, because the
driver cannot fill them either. This is the "narrower fix" the brief allowed for, and it is
smaller, not weaker: the refusal is strictly wider than before.

**Where the refusal lands:** unchanged. It is raised before `plannedFills` is acted on, before
the first keystroke, so it is `kind: "fill"` → pre-click in apps/web → attempt FAILED and
retryable, confirmation handed back unspent.

## 5 · What is pinned so it cannot decay

| Test | Claim |
| --- | --- |
| `refuses when the step carrying the reviewed consent is replaced instead of revealed` | the consent case, `recorded: []` |
| `still submits a progressive wizard that is reviewed and submitted in the same shape` | a genuinely progressive form is not refused (`recorded: [{name, email}]`) |
| `does not refuse a replaced step the user made no decision on` | not "refuse any page that got shorter" — same two renderings, no decision on step 2, submits |
| `walks all three steps, uploads the CV and submits exactly once` (existing) | the all-steps-up-front multi-step form is untouched |
| the whole existing mutating-proxy suite (kind swap, removal, id shift, no-drift) | no regression in the identity check |

## 6 · Residual, stated rather than hidden

- **An unreviewed control is still submitted as the page ships it.** In the third test the
  replaced step's pre-ticked box goes to the employer, because the review never showed it and
  the plan never answered it. That is review completeness, not field identity: this check judges
  whether the decisions the user *made* survive to the click. Worth a separate item if a real
  ATS is found that hides consent behind a "Next".
- **A progressive form is submitted at its first step.** `totalSteps` comes from the reviewed
  snapshot, which for a progressive page only ever saw step 1, so the driver clicks Submit
  without advancing. Pre-existing, unchanged by this work, and visible in the second test's
  recorded row (`{name, email}` only).
- **A fill failure raised *after* an advance click is still reported `kind: "fill"`.**
  Pre-existing; the advance click itself is `"advance"`, but a later `applyValue` failure claims
  pre-click. Not reachable from this change (the presence check runs before any click), noted
  because it is adjacent.
- **The live suites need a demo-ats built from this branch.** The new tests hit `/stepped/jobs`
  and `/stepped-progressive/jobs`. The `:3001` server on this box is a root-owned process from
  an older build that this session could not restart, so the gate below was run against a fresh
  instance of this commit's build on `:3011` (`DEMO_ATS_URL=http://localhost:3011`). Restart
  `:3001` from this branch before running the gate there.

## 7 · Gate

Run at `feb6434` in a clean, isolated worktree of that commit — the shared working tree carries
another agent's in-flight work (`packages/db/src/host-lock.ts`, which does not typecheck yet),
so a gate run there would have measured their branch, not this one.

```
pnpm typecheck   21 successful, 21 total
pnpm lint        11 successful, 11 total
pnpm test        21 successful, 21 total — 1,149 tests passed, 0 failed (baseline 1,143: +3 demo-ats page tests, +3 live driver tests)
pnpm build       11 successful, 11 total
pnpm depcruise   no dependency violations found (714 modules, 2160 dependencies cruised)
```

Per package: demo-ats 12 · config 72 · email 37 · contracts 19 · ingest 34 · ai 116 ·
autoapply 256 · core 143 · db 105 · worker 147 · web 208. The live suites really ran — the
three new driver tests and `site-e2e.test.ts` (9 tests, 13.3 s) are in the log, not skipped.
`TEST_DATABASE_URL=postgres://careerhq:careerhq@localhost:5433/careerhq_dc3`,
`DEMO_ATS_URL=http://localhost:3011`.
