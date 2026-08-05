# The host-wide browser cap, the per-visitor decision, and the last four locale-dependent dates

Branch `feature/deferred-cleanup`, worktree `.claude/worktrees/deferred-cleanup`, database
`careerhq_dc2` on `localhost:5433`, `demo-ats` on `localhost:3001`.

Three items: the last **Operational** entry on the deferred list (a browser cap that is per
process, plus the per-visitor rate-limiting question), and two date follow-ons to `b9a7364`.

---

## Item 1 — the box's real browser limit was two, not one

### What was wrong

`apps/worker/src/autoapply/browser-limit.ts` counts open Chromiums on `globalThis`, capped at
`AUTOAPPLY_MAX_CONCURRENT_BROWSERS` (default 1). It is per **process**, and it says so. But
`apps/web` launches browsers in-process from its server actions and `apps/worker` launches its
own, so two containers each honestly reporting "one" is two Chromiums on a 3.7 GB VPS whose
`mem_limit`s (900 MB web + 1200 MB worker + 400 + 128 + 128 = 2756 MB worst case) were arithmetic
over a *bounded number of browsers*, not a bounded number per container. `careerhq-web` already
idles at ~47% of its share.

### What was built

`packages/db/src/host-lock.ts` — a host-wide slot bound over Postgres advisory locks, taken by
both processes **in addition to** the per-process counter, never instead of it.

```
acquireHostBrowserSlot(databaseUrl, maxConcurrent) -> Promise<() => Promise<void>>
```

For slot `i` in `0 .. maxConcurrent-1`, `select pg_try_advisory_lock(620260806, i)` on a dedicated
connection; the first that answers true is the slot, and the returned release runs
`pg_advisory_unlock` on the same connection. Four decisions, each because the alternative breaks
something specific:

- **`pg_try_…`, not `pg_advisory_lock`.** The in-process cap refuses immediately and the
  visitor-facing behaviour depends on it: a confirm that cannot get a browser must fail *now*,
  while its confirmation token is still unburned, rather than queue behind another visitor's
  Playwright run. A blocking lock would silently convert an honest "busy, try again" into a hang
  that eventually surfaces somewhere far less recoverable. **This property is tested, timed.**
- **Session-level, not `pg_advisory_xact_lock`.** The hold spans a whole confirm — probe,
  `beginSubmission`, fill, click, screenshot — which is browser time, not transaction time.
  Holding a transaction across it would park an `idle in transaction` backend for the duration,
  pinning vacuum's xmin horizon on a 400 MB Postgres. A session lock has the release semantics
  that actually matter anyway: **Postgres drops every lock the connection held the instant the
  connection dies**, so a `docker kill`, an OOM kill or a segfault cannot strand a slot. Nothing
  has to notice the crash; nothing has to expire.
- **A dedicated connection, not `createDb`'s pool.** `createDb` pools ten connections and hands
  out whichever is free. A session lock taken through it would be released by whatever connection
  the unlock query landed on — usually not the holder — and the lock would ride, invisibly, on a
  connection the pool then gave to a page render. `max_lifetime: null` is set explicitly, because
  postgres-js recycles connections after 30–60 minutes by default and that would drop a held lock
  mid-confirm with nobody asking it to.
- **The two-int key form.** `pg_try_advisory_lock(int4, int4)` and `pg_advisory_xact_lock(bigint)`
  occupy different lock spaces (`objsubid` 2 and 1), so these keys cannot collide with
  `DEMO_SEED_LOCK_KEY` even by arithmetic accident. The second int being the slot index is what
  makes a configured cap of N genuinely N host-wide rather than one.

Advisory locks are **re-entrant within a session**, which is a trap rather than a feature here:
asking twice for a key this connection already holds returns true and hands out a slot that does
not exist. The lock object tracks what it holds and skips those keys. Tested directly.

Wiring, at the call sites only — `packages/autoapply/` and `apps/worker/src/autoapply/` were off
limits (a concurrent agent's territory), so `browser-limit.ts` is untouched and composition
happens where the browser is asked for:

- `apps/web/src/lib/site-driver.ts` — `acquireBothSlots` / `withBothSlots`. In-process slot first
  (no I/O when this process is already busy, and no denying the other container a host slot for
  the microseconds before discovering it), host second, released in reverse. Neither lock ever
  waits, so the ordering cannot deadlock against a caller doing the opposite. Both halves are
  taken by `probeDriver`, i.e. **before `beginSubmission`**, for the reason the reservation exists
  at all: a host slot taken later, inside `submit`, would let another container's Chromium refuse
  a confirm whose token was already spent.
- `apps/worker/src/jobs/autoapply.ts` — the same pair around both `openSession()` calls. Those
  consumers are still unregistered, so this is not live; it is the half that makes the cap
  host-wide the moment they are.
- `apps/web/src/lib/site-submission.ts` — `isBrowserBusyFailure` now recognises
  `HostBrowserBusyError` beside `BrowserBusyError`. Deliberately one outcome: to a visitor,
  "another application already has the browser" is the same sentence and the same remedy
  whichever container is holding it.

### Evidence

**Two real connections** — `packages/db/src/host-lock.test.ts`, 7 tests. Every contention test
stands up a second `createHostBrowserSlotLock`, which is a second Postgres backend. Two `acquire`
calls on one object would prove nothing (same session, re-entrant).

| Property | How it is proven |
| --- | --- |
| The second connection is **refused, not queued** | Holder takes slot 0; the second `acquire` rejects with `HostBrowserBusyError` in **under 1 s**, while the holder is still holding. The timing is the assertion: a blocking lock would sit until the release, which happens *after* it. The winner is asserted to still hold its slot — a refusal that also dropped the winner's slot would pass a naive test and be worse than no cap. |
| The lock **is released when the holder finishes** | Second connection refused, holder releases, second connection acquires. |
| A **killed** holder's lock frees | Holder acquires; its `pg_backend_pid()` is killed with `pg_terminate_backend` from a *third* connection — no release ever runs, the way a `docker kill` or an OOM kill leaves things. The other connection then acquires. |
| A cap of N is N **host-wide** | Two connections take one slot each at `maxConcurrent = 2`; a third is refused; the first releases and the third gets exactly the freed index. |
| One connection cannot take the **same** slot twice | Both slots go to one connection, a third call is refused — without the held-set, re-entrancy would make the cap a per-connection fiction. |
| Release is idempotent | Calling a spent release again does not unlock the slot another connection now holds. |
| A cap of 0 or 1.5 is refused | `RangeError`, mirroring `configureBrowserLimit`. |

**Through a real `next start`** (production build, `DEMO_MODE=true`, `SANDBOX_FORCE_SAFE=true`,
`AI_MODE=replay`, `SANDBOX_SITE_ALLOWED_HOST=localhost:3001`, seeded demo workspace, Playwright
clicking the actual review-screen UI against `demo-ats`) — because a green Vitest run does not
prove anything about Next's webpack server bundles, which is this repo's own stated verification
practice:

- With an **outside connection holding slot 0** (a stand-in for the worker container), clicking
  *Prepare* returns *"the application page could not be read: the auto-apply browser is busy with
  another application — try again in a moment"* and **records no attempt**. This process's own
  counter was completely free; the refusal came entirely from the host lock.
- With the slot free, the same *Prepare* reaches the full review screen (17 fields, 3 steps,
  parsed from the live `demo-ats` Greenhouse page).
- Polling `pg_locks` every 50 ms across a real prepare: the advisory lock is held from **70 ms to
  351 ms** — exactly the browser's life — and **0** locks remain on the class afterwards.
- `pg_stat_activity` shows the web process opened **exactly one** `careerhq-browser-slot`
  connection across all its route bundles, before and after. (Correctness never depended on that:
  two lock connections still cannot both hold one advisory key, so per-bundle duplication would
  cost connections, not the cap. It is checked because this repo has been bitten twice by
  module-level state being per bundle.)

### What I did NOT prove

- **Two real containers.** Every test and the live probe used two Postgres *connections* from one
  or two host processes. That is the seam the lock turns on — Postgres cannot tell a connection
  from another container from a connection from this test — but nobody ran `docker compose up` and
  watched `web` and `worker` fight over a browser.
- **The reconnect window.** If the lock connection drops and postgres-js transparently reconnects
  mid-hold, the lock is gone server-side while this process still believes it holds one. I removed
  the routine cause (`max_lifetime: null`), clear the bookkeeping on `onclose`, and report an
  unlock the server says it never held — but I did not force a mid-hold reconnect and observe the
  degradation. Its shape is bounded by construction: losing the outer bound leaves the
  per-process cap, which is exactly what shipped before this existed.
- **A second host.** Two boxes on one database share these slots. Correct for the lock, wrong for
  a RAM budget. Stated in the roadmap and `SECURITY.md`, not solved.
- **The worker's live path.** `runCaptureJob`/`runSubmitJob` are wired but their pg-boss consumers
  remain unregistered (a separate hard precondition on the deferred list), so the worker half is
  proven only by its unit tests, not by a running queue.
- **Memory.** I did not measure RSS with one browser versus two. The cap is a count, and the
  arithmetic it protects is `docker-compose.demo.yml`'s, unchanged.

### A consequence worth naming

A host-wide cap makes every browser-driving test suite in the monorepo contend for one slot
against a single shared `TEST_DATABASE_URL`, and turbo runs the packages' test tasks concurrently.
On the shipped key, `site-e2e` holding a slot for a moment made `site-submission`'s refusal
assertions pass for entirely the wrong reason — and 15 tests failed the first time I ran the gate.
The fix is a per-file lock namespace (`HostBrowserSlotLockOptions.lockClass`, and
`configureHostBrowserLockClass` for suites that drive the real production path), applied in
`site-driver.test.ts`, `site-submission.test.ts`, `site-e2e.test.ts`, `jobs/autoapply.test.ts` and
`jobs/autoapply.live.test.ts`. Production never passes it, so `web` and `worker` always meet on
the same key. It restores exactly the independence the per-process counter used to give these
tests for free.

`site-driver.test.ts` also now needs a real database (it used to run against a fake
`DATABASE_URL`), and gains two tests that are the app-level statement of the whole item: a confirm
is refused while another *process* holds the browser, and the other process is denied for as long
as a confirm is running.

---

## Item 1b — per-visitor rate limiting: not built, and the reason is recorded

The deferred entry read *"one aggressive visitor consumes the shared budget for everyone"* as a
defect. I think it is the design on this deployment, and I have written that into the roadmap and
`SECURITY.md` rather than leaving it open forever.

1. **There is no visitor to be per.** No authentication, no session, and the demo is deliberately
   *one workspace every visitor shares*. Per-visitor budgets would not give anyone their own data
   — visitors are already editing the same rows. The only thing they buy is fairness between
   anonymous strangers, not protection.
2. **Both available identities are visitor-controlled.** A cookie is one `document.cookie` away
   from being new. An IPv6 client has a /64 at minimum to rotate through.
3. **The origin cannot see the visitor without trusting a header it does not own.** Behind
   Cloudflare the origin sees proxy addresses. The vhost sets `X-Real-IP $remote_addr` and
   `X-Forwarded-For $proxy_add_x_forwarded_for`, but `$remote_addr` at the edge is a Cloudflare
   address unless the edge's `00-realip.conf` has already rewritten it — and **that file is not in
   this repo**; it belongs to the shared edge stack on the box. Meanwhile the documented quickstart
   is `git clone && docker compose up`, with no edge at all, where `X-Forwarded-For` is entirely
   attacker-supplied. Trusting it would make the limiter both trivially bypassable *and* a way to
   grow an unbounded map of attacker-chosen keys — on the container whose RAM is the binding
   constraint. Today's map is bounded by the number of action names, a compile-time constant, and
   needs no eviction pass; that property is documented in `rate-limit.ts` and is worth more here
   than fairness.
4. **What actually protects the box is a resource bound, not a rate.** The host-wide browser cap
   above, the 2 MB/64 MB disk ceilings, the six-hourly reset, the `mem_limit`s and the gate
   matrix. A visitor holding the button down cannot hold two browsers however fast they click, and
   the refusal they get is honest and immediate.

Revisit condition, written into the entry: if the demo ever grows real accounts. Identity would
then exist, and per-account would be both meaningful and enforceable.

---

## Item 2 — four server components printed the container's timezone

`cvs`, `overview`, `answers` and `facts` called `toLocaleDateString()` in server components. Not
hydration bugs (they never re-render on the client), but every visitor saw dates formatted in the
container's zone and ICU locale. All four now go through `formatDate` from
`apps/web/src/lib/time.ts` (`b9a7364`), which is `toISOString().slice(0, 10)` — defined by the
language to be UTC and locale-free.

Swept for others: `toLocaleDateString`, `toLocaleString`, `toLocaleTimeString`, `toDateString`,
`toUTCString` and `Intl.` across `apps/` and `packages/`. **Zero remaining** outside `time.ts`'s
own doc comment and one worker *test* fixture building an RFC 5322 `Date:` header, which is
correct there.

---

## Item 3 — `timeAgo`'s default argument

`timeAgo(date, now = new Date())` was called from two places with the default. One
(`jobs/health.tsx`) is a server component and cannot mismatch; the other
(`settings/email/connection-form.tsx`) is `"use client"` **rendered from a server page**, so React
renders it once in Node and again in the browser at hydration — two `new Date()` calls, and a
`lastCheckedAt` sitting on a bucket edge renders "1h ago" in the HTML and "2h ago" after
hydration. Same class as `b9a7364`, reached by a different route. Never observed; nothing
prevented it.

A default cannot be made safe — whatever it computes, it computes twice. So `now` is now
**required**, and typed as epoch milliseconds rather than a `Date`, because a number crosses the
server/client boundary as itself:

- `ConnectionsTable` takes `now` as a prop; `settings/email/page.tsx` (a server component) passes
  `Date.now()`. Both renders are handed the same number and cannot disagree. `router.refresh()`
  after a test or disconnect re-renders on the server with a fresh one. This is the same shape
  `email-panel`'s `ExpiryCountdown` already uses.
- `IngestHealth` computes one `now` for the whole table, so two rows a millisecond apart cannot
  land in different buckets either.
- `time.test.ts`'s "defaults to current time" test is replaced by one that pins the actual
  property: a value one second short of the 1h→2h edge renders identically for a repeated `now`,
  and flips bucket for a `now` one second later — so the equality is a property of passing the
  same instant, not of the buckets being coarse.

### Evidence for Items 2 and 3

Real `next start` (production build), server `TZ=Asia/Kolkata`, driven by Playwright with
`locale: "de-DE"`, `timezoneId: "America/New_York"` — three axes apart from the server on both
locale and zone. Seven pages: `/overview`, `/cvs`, `/answers`, `/facts`, `/jobs`,
`/settings/email`, `/applications`.

- Every date rendered is ISO `YYYY-MM-DD`. No `05.08.2026` (what a de-DE browser would produce),
  no `8/5/2026` (what the server's ICU default would).
- For every page, the set of date-shaped strings in the **server HTML** equals the set in the
  **hydrated DOM**. `/jobs` and `/settings/email` both render `1h ago` on both sides — the
  `timeAgo` path, including the client component.
- **0 console messages and 0 page errors across all seven pages.** Not "no hydration warnings" —
  the console was completely silent.

What that does *not* prove: the hydration mismatch itself was never reproduced before the fix
(the window is one bucket edge wide and would need the render to straddle it), so Item 3 rests on
the argument and the type, not on a caught failure.

---

## Gate

Full repo, run against `careerhq_dc2`:

| Command | Result |
| --- | --- |
| `pnpm typecheck` | 21/21 tasks green |
| `pnpm lint` | green (32/32 with typecheck) |
| `pnpm build` | 11/11 green |
| `pnpm depcruise` | `no dependency violations found (724 modules, 2192 dependencies cruised)` |
| `pnpm test` | see below |

Tests, per package, forced (no turbo cache): demo-ats 12, contracts 19, config 72, email 37,
ingest 34, autoapply 256, core 143, ai 116, **db 112** (was 105; +7 host-lock), worker 147,
**web 210** (was 208; +2 cross-process at the app seam).

Baseline for this branch was 1143 at `b29b335`, re-measured and confirmed before any edit.

**Three failures are not mine and were not touched:** `apps/worker/src/autoapply/driver.test.ts`'s
three "wizard whose later step is replaced, not revealed" tests, added by the concurrent agent in
`00d443f`/`feb6434`, fail with `no raw field named name in …/stepped/jobs/…`. They fail in
isolation as well as under the full run, so they are not contention with my change. That file is
in `apps/worker/src/autoapply/`, which I was told to stay out of.

## Also worth a look

- `SECURITY.md` and the roadmap are meant to agree, and both carried a stale
  "eleven actions unthrottled" / "no `.max()`" pair that `312d5cf` had already closed. Someone
  updated both while I was working; I only rewrote the browser-cap and rate-limiting entries.
- The branch moved under me four times during this session (`00d443f`, `feb6434`, `04faf78`,
  `da7bdf9`) — a concurrent agent is committing to `feature/deferred-cleanup` from the same
  working tree. Every stage here was by explicit path; nothing was amended, rebased or stashed.
