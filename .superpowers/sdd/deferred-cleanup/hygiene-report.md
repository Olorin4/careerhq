# Deferred cleanup — two hygiene items

Branch `feature/deferred-cleanup`, worktree `.claude/worktrees/deferred-cleanup`.
Own database `careerhq_dc2` on `localhost:5433`; `demo-ats` on `localhost:3001`.

| | |
|---|---|
| Item 1 — driver test scoped to its own submissions | `be0a73c` |
| Item 2 — React hydration #418 on `/applications/[id]` | `b9a7364` |

Both commits were staged by explicit path. The worktree is shared with a
concurrent agent whose work in `packages/db/src/repos/**`,
`apps/web/src/lib/workspace.ts` and the read-path pages was left uncommitted and
untouched.

---

## Item 1 — an assertion that could fail for reasons unrelated to the code

### What was wrong

`apps/worker/src/autoapply/driver.test.ts` asserted `toEqual([])` against
`submissionsFor(jobId)` in two places:

- line 504, `reports an un-tickable consent box as a FILL failure` (`hidden-consent-1`)
- line 589, `refuses to fill a field whose question changed since review` (`consent-drift-1`)

Every sibling in the file takes a `before` snapshot and asserts a delta. The
file's own header says why:

> The demo-ats store is process-global and shared with apps/web's
> `site-e2e.test.ts`, which runs as a separate turbo task against the same
> server. Neither suite may wipe it or assert on its total size (…) Scope every
> assertion to the job id the suite submits to instead.

Both of these use **fixed** job ids, so the absolute form is a claim about the
total state of a long-lived shared service rather than about the attempt under
test. A `demo-ats` holding a row for either job id from any earlier run turns
them red with no code change.

### What was changed

Both now snapshot `before` and compare submission ids:

```ts
expect((await submissionsFor(jobId)).map((s) => s.id)).toEqual(before.map((s) => s.id));
```

The docblock above the drift test, which described "the empty submissions list"
as the proof, was corrected to "the unchanged submissions list for this job".

### The audit of the rest of the file

`grep` over `driver.test.ts` for absolute-shape assertions found five sites:

| Site | Job id | Verdict |
|---|---|---|
| 504 | `hidden-consent-1` (fixed) | **fixed** |
| 589 | `consent-drift-1` (fixed) | **fixed** |
| 810, 822, 843 (`recorded: []`) | `consent-kind-swap-${RUN}` etc., `RUN = randomUUID().slice(0,8)` | already scoped by construction — a fresh id every run cannot carry a stale row |

Also checked, and reported rather than changed:

- `apps/worker/src/jobs/autoapply.live.test.ts` has four assertions of the same
  literal shape (213, 258, 287, 295) — all against `randomUUID`-suffixed job
  ids, so already scoped.
- `apps/web/src/lib/site-e2e.test.ts` uses `before.length` deltas throughout.

`driver.test.ts` was the only file with the problem, and those two were the only
two assertions in it.

### Proof it fixes the actual failure mode

Rather than trust the reasoning, the failure state was manufactured. A
submission was POSTed to `demo-ats` for both job ids:

```
$ curl -X POST -F name=… http://localhost:3001/hidden-consent/apply/hidden-consent-1   -> 200
$ curl -X POST -F name=… http://localhost:3001/consent/apply/consent-drift-1           -> 200
$ curl -s http://localhost:3001/api/submissions | …
[('hidden-consent-1', 'NR-b7f58764'), ('consent-drift-1', 'NR-5ab30821')]
```

With those rows present — the exact condition under which `toEqual([])` is
false by construction — the suite runs green:

```
✓ src/autoapply/driver.test.ts (48 tests) 7087ms
  Test Files  1 passed (1)
       Tests  48 passed (48)
```

### Roadmap

`docs/roadmap.md` was free (unmodified by the concurrent agent when checked and
when committed). The entry under **Carried beyond P6 → Operational** was struck;
the diff is a single-line deletion.

---

## Item 2 — React hydration error #418 on `/applications/[id]`

### Diagnosis (not a guess)

`pnpm build`, then a real `next start` on `:3097` against `careerhq_dc2`, then a
real Chromium via Playwright reading the page console.

The first attempt reproduced **nothing** — and that is the useful part of the
result. With the browser on the host's own locale and time zone the console was
clean. The error only appears when the visitor's settings differ from the
server's, which is why it shows up on a hosted demo and not on a developer's
laptop.

**Before**, browser `en-GB` / `America/New_York`, application
`8fb122d9-…` (documents, answers and a company-site attempt):

```
[pageerror] Minified React error #418; visit
https://react.dev/errors/418?args[]=text&args[]= for the full message
```

React's production build names the mismatch kind (`text`) but not the text, so
the SSR HTML was diffed against the hydrated DOM at every date node:

```
DIFF  ssr=materials-doc-date: 8/5/2026, 4:02:20 PM
       dom=materials-doc-date: 05/08/2026, 09:02:20
DIFF  ssr=qa-answer-date:     8/5/2026, 4:02:20 PM
       dom=qa-answer-date:     05/08/2026, 09:02:20
DIFF  ssr=qa-answer-date:     8/5/2026, 4:02:20 PM
       dom=qa-answer-date:     05/08/2026, 09:02:20
DIFF  ssr=site-attempt-date:  8/5/2026, 4:02:20 PM
       dom=site-attempt-date:  05/08/2026, 09:02:20
```

### What it actually was

`Date#toLocaleString()` called inside **client** components.

`toLocaleString` reads the host's locale and time zone. The Node process that
server-renders the HTML formats with the container's ICU default (`en-US` /
`Europe/Athens` on this host); the browser formats the same `Date` with the
visitor's settings when it hydrates. Different text nodes → #418, and React
discards and re-renders the subtree.

Four call sites on that page, all `"use client"`: `materials.tsx:236`,
`qa.tsx:148`, `site-panel.tsx:1013`, `email-panel.tsx:465,467`.

**The countdown was ruled out, not assumed innocent.** `ExpiryCountdown` seeds
`useState(() => Date.now())`, which would indeed differ between server and
client — but it renders only when `preview`/`prepareOutcome` state exists, and
that state is set by a client action *after* mount. It never appears in the
server-rendered HTML, so it cannot mismatch. Confirmed by the SSR/DOM diff
above: no countdown node in the SSR output.

`messages.tsx:33` and `page.tsx:107` also called `toLocale*`, but both are
server components — no hydration, no mismatch.

### The fix

Two helpers added to the existing `apps/web/src/lib/time.ts`:

```ts
export function formatTimestamp(value: Date | string): string   // "2026-08-05 13:02 UTC"
export function formatDate(value: Date | string): string        // "2026-08-05"
```

Built on `toISOString`, deliberately, rather than a pinned
`Intl.DateTimeFormat("en-GB", { timeZone: "UTC" })`: ISO output is defined by
the language to be UTC and locale-free, so it cannot diverge even between hosts
with different ICU builds. The zone is spelled out in the rendered text because
a timestamp with no zone is worse than one in a zone the reader did not choose.

**`suppressHydrationWarning` was not used anywhere.** It suppresses the console
message but not the behaviour: React still discards and re-renders the subtree.
It would have hidden the very symptom that made this findable while leaving the
page doing the wrong thing.

Converted:

| File | Why |
|---|---|
| `[id]/materials.tsx`, `[id]/qa.tsx`, `[id]/site-panel.tsx`, `[id]/email-panel.tsx` | the reproduced #418 |
| `applications/board.tsx`, `inbox/suggestions.tsx` | identical defect in client components; latent only because the seed has no card with a due date and no pending suggestion |
| `[id]/messages.tsx`, `[id]/page.tsx` | server-rendered, never mismatched — converted so the same page does not print the server's zone beside the fixed values |

### Verification — same method as the diagnosis

`pnpm build`, fresh `next start`, real Chromium. **After**, same page, same
browser settings:

```
=== http://localhost:3097/applications/8fb122d9-… locale=en-GB tz=America/New_York
--- console ---
--- SSR vs DOM ---
SAME  ssr=materials-doc-date: 2026-08-05 13:02 UTC
       dom=materials-doc-date: 2026-08-05 13:02 UTC
SAME  ssr=qa-answer-date:     2026-08-05 13:02 UTC
       dom=qa-answer-date:     2026-08-05 13:02 UTC
SAME  ssr=qa-answer-date:     2026-08-05 13:02 UTC
       dom=qa-answer-date:     2026-08-05 13:02 UTC
SAME  ssr=site-attempt-date:  2026-08-05 13:02 UTC
       dom=site-attempt-date:  2026-08-05 13:02 UTC
```

Console empty — no errors, no warnings.

Swept wider, since one clean page proves little. Browser locales `en-GB` and
`de-DE`, time zones `America/New_York`, `Asia/Kolkata`, `America/Los_Angeles`,
`Europe/Athens`; routes `/applications`, `/overview`, `/inbox`, `/cvs`,
`/facts`, `/answers`, `/jobs`, `/settings` and four `/applications/[id]` pages
covering documents, answers, site attempts, email attempts and messages. Every
combination: `CLEAN`.

The final sweep was run with `DEMO_MODE=true` — the hosted demo's own
configuration, and the one where the sandbox workspace's seeded data actually
renders. Under the personal-workspace default the board renders no cards at all,
so a sweep without it would have proved nothing about `/applications`. A
`next_action_due` was set on two seeded applications so the board's and the
detail page's due-date paths were genuinely exercised (`due 2026-08-09` appears
in both).

### Not done, and why

Four `toLocaleDateString()` call sites remain in **server** components:
`cvs/page.tsx:58`, `overview/page.tsx:56`, `answers/page.tsx:44`,
`facts/page.tsx:93-94`. They are not hydration bugs — nothing re-renders them on
the client — but they do display the server's time zone. All four files are
being edited by the concurrent agent for the read-transaction work, so they were
left for that pass rather than fought over.

Separately: `timeAgo(date, now = new Date())` is called from two client
components (`jobs/health.tsx:47`, `settings/email/connection-form.tsx:94`) with
the default `now`. That is a genuine latent mismatch — a server render at
"59m ago" and a hydration one second later at "1h ago" — but it needs the render
to straddle a bucket boundary, it did not reproduce in any sweep, and the fix is
a different shape (pass a stable `now`, or render after mount). Noted, not
touched.

---

## Gate

Run in this worktree against `careerhq_dc2` on `:5433`, with `demo-ats` live on
`:3001` and a real Chromium available.

| Command | Result |
|---|---|
| `pnpm typecheck` | exit 0 — 21/21 tasks |
| `pnpm lint` | exit 0 — 11/11 tasks |
| `pnpm test` | exit 0 — 21/21 tasks, **1139 tests passed**, 0 failed, 0 skipped |
| `pnpm build` | exit 0 — 11/11 tasks |
| `pnpm depcruise` | exit 0 — no violations (717 modules, 2169 dependencies) |

Per-package test totals: demo-ats 9, contracts 19, config 72, email 37, ai 116,
ingest 34, autoapply 256, core 143, db 105, worker 144, web 204.

**On the number.** The stated baseline of 1132 was at `12686c8`. The concurrent
agent committed `bd8ed98` onto this branch during the work, and `pnpm test` ran
against a tree that included it plus that agent's uncommitted changes. 1132 + 4
(the `formatTimestamp`/`formatDate` cases added to `time.test.ts`) = 1136; the
remaining 3 are not mine. The run is honest but it is not a clean measurement of
this branch alone.

`driver.test.ts` reports 48 tests, none skipped — the `live(…)` suites really did
run against `demo-ats` rather than being silently skipped.

## Concerns

1. **The gate numbers are mixed.** See above. A clean re-run after the
   concurrent agent commits would be worth having before this branch merges.
2. **The two commits touch `apps/web` files adjacent to the concurrent agent's
   read-path work.** `applications/[id]/page.tsx` and `board.tsx` were verified
   to contain only this work at commit time, but `overview/page.tsx` and the
   `packages/db` repos were deliberately left alone; if that agent also converts
   date rendering there, the formats need reconciling to one helper.
3. **`formatTimestamp` renders UTC, not visitor-local time.** That is the price
   of determinism without a round trip. If visitor-local display is wanted
   later, the shape is: render the UTC value on the server, upgrade it in a
   `useEffect` after mount — never `toLocaleString` during render.
