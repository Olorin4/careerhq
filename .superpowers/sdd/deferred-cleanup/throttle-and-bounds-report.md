# Throttle the remaining eleven actions, and bound the free text

Two "Carried beyond P6 → Operational" entries from `docs/roadmap.md`, done as one pass.
Branch `feature/deferred-cleanup`, baseline `7e47c63`.

---

## Item 1 — eleven unthrottled mutating server actions

All eleven now call `demoRateLimit` before they touch anything, in the established
shape: check after input validation, before `getDb()`, return the refusal in the
action's own failure type, never throw it.

| # | Action | File | Bucket | Was |
|---|--------|------|--------|-----|
| 1 | `createApplicationAction` | `applications/actions.ts` | `createApplication` | `Promise<void>` → converted |
| 2 | `transitionApplicationAction` | `applications/actions.ts` | `transitionApplication` | one-line |
| 3 | `selectCvAction` | `applications/actions.ts` | `selectCv` | one-line |
| 4 | `createFactAction` | `facts/actions.ts` | `createFact` | `Promise<void>` → converted |
| 5 | `reverifyFactAction` | `facts/actions.ts` | `reverifyFact` | `Promise<void>` → converted |
| 6 | `archiveFactAction` | `facts/actions.ts` | `archiveFact` | `Promise<void>` → converted |
| 7 | `acceptSuggestionAction` | `inbox/actions.ts` | `acceptSuggestion` | one-line |
| 8 | `dismissSuggestionAction` | `inbox/actions.ts` | `dismissSuggestion` | one-line |
| 9 | `saveScoringProfileAction` | `settings/actions.ts` | `saveScoringProfile` | one-line |
| 10 | `addWatchlistEntryAction` | `settings/actions.ts` | `addWatchlistEntry` | one-line |
| 11 | `removeWatchlistEntryAction` | `settings/actions.ts` | `removeWatchlistEntry` | `Promise<void>` → converted |

Six one-line fixes, five `useActionState` conversions — exactly the split the roadmap
predicted. All eleven are cheap row writes, so none is a heavy bucket: they take the
plain `DEMO_RATE_LIMIT_PER_MIN` budget (default 30/min), not the 5/min heavy cap.

### The five conversions, across three pages

Each `void` action grew a return type so a refusal has somewhere to land. A thrown
server-action failure reaches the visitor as Next's full-page "Application error"
overlay — the bug this project has already fixed twice.

- `applications/new-application-form.tsx` — already a client component; now
  `useActionState(createApplicationAction, null)`. Every text input re-seeds its
  `defaultValue` from the values the refusal carried back, because React resets an
  uncontrolled form once its action resolves. Without that, "try again in 40s" would
  also silently empty everything just typed.
- `facts/fact-form.tsx` — same treatment.
- `facts/fact-row-actions.tsx` (**new**) — the Re-verify and Archive forms lifted out
  of the server-rendered `facts/page.tsx`, one `useActionState` each so a throttled
  archive cannot look like a failed re-verify.
- `settings/watchlist-remove-form.tsx` (**new**) — the Remove button lifted out of
  the server-rendered `settings/page.tsx`.

Shared helpers in `apps/web/src/lib/form-state.ts` (**new**): `submittedTextValues`
(carry the typed values back) and `describeZodIssue` (a rejection as one readable
line — extracted because every schema that moved from `.parse` to `.safeParse`
needs it).

One shared CSS class, `.form-error` in `globals.css`, matching the existing
per-panel error styling rather than copying it four more times.

---

## Item 2 — free-text caps

`TEXT_LIMITS` in `packages/contracts/src/index.ts` — one named set both apps agree on.

| Key | Chars | Applied to | Why this number |
|-----|-------|-----------|-----------------|
| `name` | 200 | company, job title, CV label, watchlist company, `fieldId`, `presentedToken` | A one-line name. Longest real company name is ~60. |
| `emailAddress` | 254 | `emailDraft.to`, `retypedTarget` (email channel) | The exact RFC 5321 maximum — no legal address is refused. |
| `url` | 2 048 | `jobUrl`, `evidenceUrl`, prepare `url`, `retypedTarget` (site) | Past the ~2 000 every browser caps a URL at. |
| `term` | 100 | one line of a scoring textarea; `boardSlug` | A role/stack/keyword phrase. |
| `terms` | 200 | how many lines one scoring textarea may contribute | Two orders of magnitude past any real profile. |
| `headline` | 500 | fact `claim`, email `subject` | A sentence shown as a heading. |
| `note` | 2 000 | reconcile `evidenceNote`, Q&A `question` | A short note or a form question. |
| `detail` | 10 000 | application `notes`, fact `detail`, one planned answer `value` | A paragraph or two. |
| `prose` | 50 000 | manual document `content`, manual answer, email `body` | Long-form text a person wrote. ~25× the longest cover letter anyone writes. |

**The comparison that matters.** These fields were bounded only by
`experimental.serverActions.bodySizeLimit`, now 6 MB and applied to *every* action —
so raising it so a real CV upload gets the app's own message instead of a 413
loosened every `notes` box by the same factor. `prose` at 50 000 chars is ~120×
tighter than that; `detail` is ~600× tighter.

### Rejections render, they do not throw

Adding a `.max()` to a `.parse()` call site would have traded one unbounded input for
one very visible crash. Every capped schema is now `.safeParse` with the rejection
returned in a shape its caller already renders:

| File | Action | Where the rejection renders |
|------|--------|-----------------------------|
| `applications/actions.ts` | `createApplicationAction` | `CreateApplicationState` in the form |
| `facts/actions.ts` | `createFactAction` | `CreateFactState` in the form |
| `settings/actions.ts` | `saveScoringProfileAction`, `addWatchlistEntryAction` | already `safeParse` |
| `cvs/actions.ts` | `uploadCvAction` | already `safeParse` |
| `applications/[id]/qa-actions.ts` | `askQuestionAction`, `saveManualAnswerAction` | failed outcome / `ManualAnswerState` |
| `applications/[id]/materials-actions.ts` | `createManualDocumentAction` | `ManualDocumentState` |
| `applications/[id]/email-actions.ts` | create/update draft, reconcile, confirm | `{ ok: false, reason }` / `blocked` |
| `applications/[id]/site-actions.ts` | prepare, update answer, confirm | `failed` / `{ ok: false }` / `blocked` |

The two confirm actions return `status: "blocked", code: "invalid_input"` — `code`
is already a free string carrying the gate or load code.

### Other unbounded free text found — reported, not changed

**Deliberately left uncapped: machine-produced text.** These schemas describe data
the app *receives*, not data it *accepts* from a person, and a `.max()` would turn an
unusually long job posting or model response into a failed ingest:

- `normalizedJobSchema`: `title`, `companyName`, `location`, `salaryRaw`, `descriptionMd`
- `rerankResultSchema`: `rationale`, `redFlags`
- `generationResultSchema`: `answer`, `unsupportedClaims`, `clarificationNeeded`
- `canonicalFormFieldSchema`: `label`, `helpText`, `options`, `accept`
- `parsedFormSchema`: `parserVersion`, `requisitionKey`, `title`, `companyName`, blocker `detail`
- `plannedAnswerSchema`: `note`, `sourceFactIds`
- reply-classification `quotedEvidence`

**One genuine remaining gap:** `apps/web/src/app/(dashboard)/settings/email/actions.ts`
takes seven person-typed fields with no length bound — `label`, `fromAddress`,
`displayName`, `smtpPassword`, `imapPassword`, `imapFolders`, plus SMTP/IMAP
`host`/`username` via `smtpConfigSchema`/`imapConfigSchema` in contracts.

Not fixed here, and the reason is specific rather than an omission: **every action in
that file returns `DEMO_MODE_REFUSAL` before parsing anything when `demoMode` is on**
(`createConnectionAction`, `testConnectionAction`, `disconnectAction`). The file's
guarantee is "none of this runs on a public URL", so an unbounded field there is not
reachable by the visitor the caps exist to bound. It is a one-line-per-field fix
whenever someone wants the sweep to be total — the file already returns
`{ ok: false, reason }` for every validation failure, so nothing would have to be
rewired.

---

## Verification

Full repo gate, run on the final tree, against `postgres://…@localhost:5433/careerhq_dc3`:

| Gate | Result |
|------|--------|
| `pnpm typecheck` | 21/21 tasks green |
| `pnpm lint` | 11/11 tasks green |
| `pnpm test` | 21/21 tasks green — **1 132 tests, 0 failures** (`@careerhq/web` 199, was 182) |
| `pnpm build` | 11/11 tasks green |
| `pnpm depcruise` | 0 violations (717 modules, 2 161 dependencies) |

### Committed tests

`apps/web/src/app/(dashboard)/input-guards.test.ts` (**new**, 17 tests):

- A table naming **all eleven** actions with the bucket each spends, plus a check
  that the table holds eleven distinct buckets — adding a twelfth mutating action to
  one of those four files without a row here goes red.
- For each: the refusal **resolves** (never rejects) in the action's own failure
  shape, and lands before `getDb()` is called.
- Outside demo mode, a fully exhausted bucket still lets the action through.
- The caps render as a message and keep what was typed; text exactly at the cap is
  accepted.

### Real-browser evidence

Vitest resolves through Node; Next compiles server actions through a separate webpack
pass — and a form whose action signature changed but which silently stops submitting
passes both `pnpm build` and the test suite. So both modes were driven against a real
`next start` (production build, not `next dev`) with Playwright/Chromium:

- `next start -p 3210`, `DEMO_MODE=false`
- `next start -p 3211`, `DEMO_MODE=true DEMO_RATE_LIMIT_PER_MIN=1`

**111 checks, 0 failures** (34 + 37 + 20 + 20 across two scripts × two modes). Every
one of the eleven actions was clicked in both modes. Sample of the demo-mode output:

```
PASS  createApplication #2 refused in the form — Not logged — too many requests, try again in 29s.
PASS  createApplication #2 re-seeds what was typed — Beta demo 1785935488543
PASS  createApplication #2 re-seeds the notes — the second one, which demo mode must refuse
PASS  transitionApplication refusal renders in the card — too many requests, try again in 60s
PASS  createFact #2 refused in the form — Not saved — too many requests, try again in 29s.
PASS  createFact over-cap renders the cap as a message — Not saved — claim: String must contain at most 500 character(s).
PASS  reverifyFact refusal renders in the row — Not applied — too many requests, try again in 59s.
PASS  archiveFact #2 refusal renders in the row — Not applied — too many requests, try again in 59s.
PASS  addWatchlistEntry #2 refused in the form — too many requests, try again in 29s
PASS  saveScoringProfile refusal renders in the form — too many requests, try again in 59s
PASS  saveScoringProfile over-cap renders the cap as a message — roles.1: String must contain at most 100 character(s)
PASS  removeWatchlistEntry #2 refusal renders in the row — Not removed — too many requests, try again in 59s.
PASS  selectCv #2 refusal renders next to the control — too many requests, try again in 59s
PASS  dismissSuggestion #2 refusal renders in the row — too many requests, try again in 59s
PASS  acceptSuggestion refusal renders in the row — too many requests, try again in 59s
```

Every step also asserted the page body contains no "Application error" / "a
server-side exception" / "Internal Server Error" text, and that no `pageerror` fired.
With `DEMO_MODE=false` the same clicks all succeeded: rows created, facts archived,
watchlist entries removed, CV selected, suggestions dismissed — nothing throttled, and
`acceptSuggestion` reporting its ordinary domain refusal ("no transition SHORTLISTED →
ACKNOWLEDGED") inline, which is the pre-existing behaviour unchanged.

---

## Notes for the caller

- **`docs/roadmap.md` was not edited** — a concurrent agent holds it. The two
  "Operational" bullets it carries (eleven unthrottled actions; free-text `.max()`)
  are both now done and should be struck.
- **The worktree is shared** with the two concurrent agents, not isolated per agent.
  Everything here was staged and committed by explicit path; `apps/worker/**`,
  `packages/autoapply/**`, `apps/web/src/lib/site-driver.ts` and
  `apps/web/src/lib/site-submission.ts` were left untouched and uncommitted by this
  pass. An early full `pnpm typecheck` failed on the other agent's in-progress
  `apps/worker/src/autoapply/pinned-navigation.ts`; it was green by the time the
  final gate ran.
- **The rate limiter is still per-process and per-action, not per-visitor.** That is
  the separate roadmap entry directly above these two and is unchanged: one
  aggressive visitor still consumes the shared budget for everyone. Throttling these
  eleven makes the app consistent; it does not make the limiter a quota.
