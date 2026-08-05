# `runSubmitJob` double-submit on retry — closed

**Branch** `feature/deferred-cleanup` · **baseline** `7e47c63` · **commit** `546b602`

---

## The hazard, reproduced

The roadmap entry (`docs/roadmap.md`, "Carried beyond P6 → Security") said a post-click
`writeFile` failure in `runSubmitJob` throws and pg-boss would retry it. It does — and the
retry does not merely re-record, it **re-fills the form and clicks Submit again**.

Reproduced against real demo-ats before committing the fix, by neutering the two new guards
and letting the job run the way pg-boss would (`throw` → retry → retry):

```
RUN1 THREW: Error: ENOTDIR: not a directory, mkdir '/tmp/…/storage/autoapply'
AFTER RUN 1: 1
AFTER 2 RETRIES: 3
```

One user intent, **three real applications** at the employer. Counted from demo-ats's
`/api/submissions`, not from the job's return value.

With the fix in place the same sequence leaves **1**.

## What was built

`apps/worker/src/jobs/autoapply.ts`. Three rules, in the order they execute:

1. **Everything that can fail harmlessly still happens before the browser opens** — workspace
   scoping, snapshot, form parse, document resolution, host policy, the evidence-store
   reservation, and `openSession` itself. All still throw and are still retried by pg-boss,
   which is correct *there and only there*: no browser has opened, so nothing was submitted.
2. **The fact that a click may have happened is made durable before it can happen.** A
   `submit_in_flight` marker is written onto the snapshot's `recovery_state` in the instant
   before `fillAndSubmit`. A retry that finds it does not click — it records `submit_unknown`
   with an honest reason and stops. This is the only mechanism that survives the process being
   *killed* mid-click; no post-click write can cover that window.
   A provably pre-click `DriverError` (`navigation`/`fill` — the same set apps/web's
   `PRE_CLICK_DRIVER_ERROR_KINDS` trusts) **withdraws** the marker, so a genuinely
   not-yet-clicked failure stays retryable exactly as before.
3. **Nothing after the click throws.**
   - The evidence write is caught and degrades: `screenshotPath: null` plus a new
     `evidenceError` saying why. A submission with no screenshot is a real submission with
     missing evidence — a degraded-but-terminal outcome, not a failure — and the receipt says
     so instead of claiming a file that is not there.
   - An unclassified throw out of `fillAndSubmit` straddles the click, so it becomes a terminal
     `submit_unknown` rather than a throw. Same judgement `confirmAndSubmitSite` makes when it
     chooses NEEDS_RECONCILE over a guess.
   - The one post-click throw left is the recovery *write* itself, and it is safe precisely
     because rule 2 already ran: the retry it triggers cannot click.

New recovery shapes: `SubmitInFlightRecovery`, `SubmitUnknownRecovery`, and
`SubmitResultRecovery` widened with a nullable `screenshotPath` + `evidenceError`.

`runCaptureJob` now refuses to write onto a snapshot that has begun submitting. That write was
the one thing in the repo that could erase the marker and hand a later submit retry a clean
slate — the double submit, reintroduced sideways.

## Interaction with `attempts_one_submitted_per_application`

The partial unique index is a **backstop for a different thing** and could not have covered
this:

- It is **per application**, and a retry of this job re-submits the **same attempt** — the
  index would not even be consulted.
- It sits behind `completeSubmission` in `apps/web`, which runs **after** the browser has
  clicked. Even where it does fire (a sibling attempt racing to SUBMITTED) it refuses the
  *receipt*, by which time the second application has already been posted to the ATS.

It protects the database's story. Only the pre-click marker protects the world. Both are
wanted; neither substitutes for the other. The index is untouched.

## Tests

`apps/worker/src/jobs/autoapply.test.ts` (driver mocked, 19 tests) and a new
`apps/worker/src/jobs/autoapply.live.test.ts` (real Chromium, real Postgres, real demo-ats,
3 tests). The live file exists because the unit suite's "no second submission" is a claim
about a mock call count; the question that matters is whether a second application reaches the
ATS, and only demo-ats can answer it.

Live suite (asserting against `/api/submissions`, scoped to a job id unique per test, so it is
a delta and never an absolute over the shared store):

- a post-click evidence failure does not become a second application on retry — run 1 lands
  one submission and does **not throw**; two further runs add nothing; the recovery row names
  the confirmation id demo-ats actually issued, carries `screenshotPath: null`, and says why.
- a retry that finds an in-flight marker never reaches the ATS (`/api/submissions` stays empty
  for that job id) and lands as `submit_unknown`.
- a pre-click failure still throws, still retries, and the retry submits exactly once.

Unit suite adds: pre-click `DriverError` withdraws the marker and the retry legitimately
submits; unclassified throw parks as `submit_unknown` and stays parked; already-`submit_result`
is a no-op across three runs; `runCaptureJob` refuses to overwrite a submit marker.

## Gate

Run against `TEST_DATABASE_URL=…/careerhq_dc2` and demo-ats on `localhost:3001`:

| command | result |
|---|---|
| `pnpm typecheck` | 21 tasks, green |
| `pnpm lint` | 11 tasks, green |
| `pnpm test` | **1115 passed**, 0 failed |
| `pnpm build` | 11 tasks, green |
| `pnpm depcruise` | no violations (709 modules, 2138 dependencies) |

Caveat on the numbers: two other agents are working **inside this same worktree directory**
(`apps/web` server actions, and the capture-policy / DNS-pinning work in
`packages/autoapply` + `apps/worker/src/autoapply/driver.ts`). Their uncommitted work is in
the tree, so the gate covers it too and the test total is above the 1013 baseline for reasons
that are not all mine. My commit stages three files by explicit path and contains nothing of
theirs.

## Is registering the two consumers now safe? **No.**

The roadmap called this a precondition, not the only one. It is closed. Three things are still
missing, and the first is larger than the one just fixed.

1. **The §11 gate still does not run inside the jobs.** `main.ts`'s own comment is the
   specification here: every externally-mutating channel passes the env gate, the sandbox host
   allow-list, and a single-use confirmation token bound to the payload fingerprint.
   `runSubmitJob` now enforces exactly one of the three — the host allow-list
   (`refuseCaptureTarget`, added in the P6 fix wave). It never reads
   `config.submissionsLiveCompanySite`, and it never touches a confirmation token, a payload
   fingerprint or `beginSubmission`. Registering the consumer would make **anything that can
   insert a pg-boss row** a live-submit path with no consent check — which is precisely what
   main.ts says must not ship.
2. **There is no reader.** Nothing in the repo enqueues either queue, and no production
   `SiteDeps.submit` reads `submit_result` / `submit_unknown` back and turns it into an attempt
   transition. The jobs deliberately never move the attempt themselves. Registered today they
   would buy no capability at all: an attempt would land its evidence on the snapshot and sit
   in SUBMITTING forever, never reaching SUBMITTED or NEEDS_RECONCILE. Whoever writes that
   adapter must map `screenshotPath: null` to "record the submission, note the missing
   evidence" and `submit_unknown` to NEEDS_RECONCILE — **never** to a retry.
3. **The queue path has no duplicate/in-flight check.** `hasBlockingAttempt` and the gate
   matrix run in `apps/web` only. Two enqueued submit jobs for two *different* attempts on the
   same application would both click; the unique index would refuse only the second receipt,
   after both applications had been sent. The marker is per snapshot and does not see siblings.

One invariant the new guard leans on, worth writing down: the marker lives on the attempt's
**latest** snapshot, so a new `saveFormSnapshot` for the same attempt between the click and a
retry would hide it. Nothing does that today — snapshots are saved at plan time, and the
attempt is mid-submission — but the schema does not enforce it. If the queue path ever
re-plans an attempt in flight, that check has to move onto the attempt row.

## Not touched, for reconciliation

Both of these now describe a hazard that no longer exists. I did not edit either, because
another agent is working in them:

- `docs/roadmap.md:103` — the "Carried beyond P6 → Security" bullet. Suggested replacement:
  the double-submit precondition is closed (`546b602`); what remains blocking registration is
  that the §11 gate still lives in `apps/web` and not in the jobs, that no reader consumes the
  recovery state, and that the queue path has no duplicate/in-flight check.
- `SECURITY.md:304-311` — same claim, same correction; the two documents are meant to agree.
