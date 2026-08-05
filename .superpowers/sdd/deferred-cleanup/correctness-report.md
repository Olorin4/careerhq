# The two "Carried beyond P6 → Correctness" items — closed

**Branch** `feature/deferred-cleanup` · **baseline** `12686c8` (1,132 tests) ·
**commits** `bd8ed98`, `34ee474`

Both were driven as the bug manifests before being fixed, and the fix was measured against
the same harness afterwards. Gate re-run in full against
`postgres://careerhq:careerhq@localhost:5433/careerhq_dc1` with demo-ats on `:3001`.

---

## 1 · A `NEEDS_RECONCILE` attempt cited a screenshot the collector then deleted

### The defect

`confirmAndSubmitSite` parks an attempt in NEEDS_RECONCILE on the two post-click outcomes it
cannot read — the page came back with no confirmation id, or the receipt was refused — and the
reason it writes says, verbatim, *"check `<finalUrl>` and the saved screenshot"*.

NEEDS_RECONCILE is precisely the outcome with **no confirmed receipt**: the click landed and
nobody can say what came of it. `completeSubmission` is what records
`confirmed_receipt->>'screenshotPath'`, and it did not run. So the path the driver had just
written to `site-screenshots/` was persisted to **no row at all**.

The demo's evidence collector derives its keep-set from the database's live set
(`listEvidenceScreenshotPaths`), so five minutes later — one grace window — it reclaimed the
file, while the attempt's reason went on telling the reader to go and look at it. The app
pointed at evidence that no longer existed, on the one outcome where a human most needs it.

Reproduced by disabling the new call and running the new test: the store directory comes back
**empty** — the referenced screenshot and a genuine orphan reclaimed alike — and
`listEvidenceScreenshotPaths` does not contain the path at all.

### The fix

`recordRecoveryScreenshot` (`packages/db/src/repos/form-snapshots.ts`) merges the path onto
the newest snapshot's `recovery_state`, on the **same `screenshotPath` key at the same level**
`runSubmitJob`'s `submit_result` already writes and `listEvidenceScreenshotPaths` already
reads. That is deliberate: one shape and one keep-set, not a second mechanism beside the first.
No change to the keep-set query was needed — choosing the key it already reads *is* the fix —
and its doc comment now names the second writer, since it enumerates its sources exhaustively.

Two properties are load-bearing:

- **Merged (`jsonb ||`), never replaced.** The row can be carrying `runSubmitJob`'s
  `submit_in_flight` marker (`546b602`) — the only durable record that a submit click may
  already have happened, and the one thing standing between a retried queue job and a second
  application at the employer. A fresh write here would have erased it. A non-object
  `recovery_state` is treated as absent rather than concatenated, and `current_step` is not
  touched: this writes one key, not a new recovery state.
- **Post-click, so it never throws.** `keepReconcileEvidence` logs on failure, exactly as
  `markNeedsReconcileSafely` beside it does. Losing the file is bad; losing the attempt's
  explanation on the way to complaining about it is worse.

### Evidence

`apps/web/src/lib/site-submission.test.ts` — a confirm whose page shows no confirmation id,
whose screenshot is then aged past `ORPHAN_GRACE_MS` and left in the store beside a genuine
orphan, followed by a second confirm whose reservation runs the collector over both:

- the referenced screenshot **survives** and the orphan is **reclaimed** in the same pass — a
  keep-set that keeps everything would be no fix at all;
- the parked attempt still points at it (`recovery_state.screenshotPath`), and
  `listEvidenceScreenshotPaths` contains it.

`packages/db/src/repos/form-snapshots.test.ts` — the path lands where the keep-set reads it,
and merging it onto a `submit_in_flight` marker leaves the marker, its `startedAt` and the
snapshot's `current_step` intact.

---

## 2 · Reads could straddle a demo reset commit

### The defect

Every dashboard page was two or more statements: resolve the workspace, then list or count
what belongs to it. The six-hourly reset is one advisory-locked transaction that DELETEs its
workspace (cascading every row under it) and re-INSERTs the lot under a **new id**. The data is
therefore never half-built — but a page load could still catch the boundary: the resolve
returned the old workspace, the reset committed, and the count that followed found nothing
under an id that no longer existed. The visitor was shown an empty demo: a moment that never
existed.

### The fix

`readInOneSnapshot` / `readWorkspaceSnapshot` in `apps/web/src/lib/workspace.ts` run a page's
reads inside one `repeatable read`, `read only` transaction, so every statement reads the
snapshot the first of them took — same workspace generation, or none of it.

- `repeatable read` is the correctness half. It is not a lock and holds nothing back: the
  reset commits underneath as usual, and a **read-only** REPEATABLE READ transaction cannot
  raise a serialization failure, so there is nothing to retry.
- `read only` is about scope, not isolation: this is a page's own reads agreeing with each
  other, not a transaction held open across a request. A write that finds its way inside is
  refused by Postgres rather than silently extending the transaction's life — asserted.
- **The bootstrap stays outside the snapshot.** `getActiveWorkspace` creates the workspace
  under `DEMO_SEED_LOCK_KEY` and re-reads under that lock, and a re-read inside a REPEATABLE
  READ snapshot cannot see the commit the lock just waited for — which is exactly how two demo
  workspaces got created before `d008a30`. The snapshot answers first; only a genuinely empty
  database falls through to the bootstrap and one retry.

All nine dashboard pages under `(dashboard)/` were converted in one pass, and the ten
list/count helpers they call now take `DbOrTx`. Converting one page but not its neighbour
would advertise a guarantee the app does not have — the same rule the throttling pass followed.

### Measurement

Against the **real** `seedDemoWorkspace` and the real page-shaped read, 1,549 polled reads
while resets ran continuously:

| reader | empty demos seen | resets during the poll |
| --- | --- | --- |
| two statements (before) | **13** of 1,549 | 26 |
| one snapshot (after) | **0** of 1,549 | 30 |

(The roadmap's prior figure was 3 of 1,549; this harness polls harder, so its baseline is
higher. The "after" number is 0 by construction, not by luck.)

Then in a real `next start` (`DEMO_MODE=true`, port 3099), 300 HTTP requests to
`/applications` while 139 back-to-back demo resets ran: **0 non-200s, 0 empty boards**. All
nine pages return 200 and render seeded content.

### What is committed, and why it is not the real reset

`apps/web/src/lib/read-snapshot.test.ts` runs the same probe — 1,549 concurrent polled reads
through repeated resets, asserting the snapshot reader sees zero empty workspaces — against a
**workspace of its own**, not the demo one. `apps/worker`'s `demo-reset` suite runs in
parallel with it and asserts row counts on the demo workspace between its own resets,
unlocked; a second process deleting that workspace mid-assertion would have made that suite
flaky for reasons unrelated to it, which is the cross-suite race this repo has already had to
fix twice. The defect is not specific to the demo's name — it is "resolve a workspace by
predicate, then read what hangs off it, in two statements" — and the probe reproduces exactly
that, with nobody else watching. Typical run: 38–42 empty workspaces for the naive reader, 0
for the snapshot reader.

The file also carries a widened-window test that states the property outright rather than
racing for it (both readers pause 600 ms between the two statements, a reset commits inside
that window: naive → 0 applications, snapshot → all of them), plus assertions that
`readWorkspaceSnapshot` really runs at `repeatable read` / `transaction_read_only = on` and
hands over the resolved demo workspace.

---

## Gate

Run in full on this branch, against the dedicated database:

| gate | result |
| --- | --- |
| `pnpm typecheck` | 21/21 tasks |
| `pnpm lint` | 11/11 tasks |
| `pnpm test` | **1,143 passed**, 0 failed (baseline 1,132; +7 here, +4 from the parallel hygiene commits) |
| `pnpm build` | 11/11 tasks |
| `pnpm depcruise` | no violations (718 modules, 2,173 dependencies) |

Real-server verification as `docs/roadmap.md` requires for `apps/web` changes: `next start`,
all nine dashboard pages 200 with real data, and the reset hammer above.

## Disclosed, not silently resolved

- **The committed straddle probe uses a probe-owned workspace, not the demo one** (reasoning
  above). The real-reset measurement in the table was run out-of-band and is reported here
  rather than committed as a gate test, because a second demo resetter in the suite would make
  `apps/worker/src/jobs/demo-reset.test.ts` flaky.
- **`IngestHealth` on the jobs page is still its own read**, outside the page's snapshot: it is
  a nested server component with its own `getDb()`. It renders "no ingestion runs yet" rather
  than an empty workspace, so it cannot show the failure this item is about, and folding it in
  would have meant changing a component another branch was editing. Worth doing when that
  component is next touched.
- **Server actions were left alone.** They resolve the workspace and then write; a read
  snapshot is the wrong tool there, and the item is scoped to a page's reads agreeing with
  each other.
- **The third NEEDS_RECONCILE branch** — an unclassified throw out of `submit` — has no
  screenshot to persist: the driver threw before returning one. Nothing to keep, so nothing
  was added.
