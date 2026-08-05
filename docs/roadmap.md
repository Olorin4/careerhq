# Career HQ — Delivery Roadmap

Six core phases plus an optional seventh. Each ends with green CI, a working demo, and an updated README — the repository is presentable to a prospective client at every point after P1. Spec references: [`career-hq-product-spec.md`](../career-hq-product-spec.md); structure: [`architecture.md`](architecture.md).

## P1 — Foundation, tracker, Fact Bank (done)

The skeleton that proves the architecture.

- Monorepo scaffold (pnpm + Turborepo), `docker-compose.yml` (web, worker, postgres, mailpit), CI pipeline (lint, typecheck, dependency-cruiser, unit tests).
- `packages/contracts`, `packages/db` (initial schema + migrations), `packages/core` (application + attempt state machines with event log), `packages/config`.
- Tracker UI: Kanban board with guarded transitions, application detail with event history, computed one-next-action panel, follow-up due dates.
- Candidate Fact Bank CRUD with categories, sensitivity, verification/review dates, stale-fact flagging.
- CV variant upload (designed + ATS formats, hashes on volume).
- Fictional-persona seed (`pnpm seed`): "Alex Demo", ~15 facts, 2 CV variants, ~10 applications across states with event history.
- README v1, ADR-0001 (Postgres + pg-boss), ADR-0002 (gated-mutation protocol — designed now, enforced from P4).

**Demo:** seeded tracker walkthrough — board, guarded transitions, event log, fact bank.

## P2 — Discovery ingestion and scoring (done)

- `packages/ingest`: normalizer, `(source, external_id)` + content-hash dedupe, expiry detection; fetchers for Remotive, RemoteOK, Arbeitnow, We Work Remotely, The Muse, and Greenhouse/Lever/Ashby board polling from a watchlist. Stretch: HN "Who is hiring", and bring-your-own-key fetchers (Adzuna, Reed.co.uk, USAJobs).
- pg-boss scheduled ingestion; `ingest_runs` + pipeline-health panel.
- Deterministic keyword scorer in `core` with persisted per-term breakdown; scoring-profile settings UI.
- `packages/ai`: chatJson client, sequential fallback, model-tier config; `rerank` task over top-25 with rationale and red flags.
- Discovery inbox UI: ranked list, score breakdown + LLM rationale, promote-to-application, dismiss.
- ADR-0003 (OpenRouter sequential fallback), ADR-0006 (scraping/ToS boundaries).

**Demo:** live feed pull → scored, re-ranked inbox → promote to tracker.

## P3 — AI materials generation (done)

The headline AI demo.

- Grounding service: deterministic fact selection, `generate` task, deterministic citation post-validation in `core`.
- Cover letter and email-body drafting with streaming UI; provenance chips linking each claim to facts; visible AI-generated marking until approval.
- `NEEDS_FACTS` flow: blocked generation prompts "add a verified fact or answer manually".
- Sensitive-question classification (keyword ruleset + LLM tie-break) with hard generation block.
- Answer bank: approve → reusable answers with source facts and review dates.
- Record/replay layer + fixtures; CI runs AI tests in replay mode.
- ADR-0004 (grounding contract and sensitive-answer policy).

**Demo:** grounded generation with citations — including a deliberate on-camera block when no supporting fact exists.

Carried from the P2 final review (fix during P3): clear stale `llm_score` for inbox jobs outside the latest rerank batch so old reranks stop dominating ordering; surface duplicates whose canonical job expired or was dismissed; persist `salaryRaw`/`postedAt` (fetchers already map them — schema v3 columns); replace the dead `#` link when a job has no URL; extract `getOrCreateCompany` into a shared companies repo.

## P4 — Email channel (done)

Carried from the P3 final review (land in P4): replace the hardcoded `hasMaterials: true` assertion in the tracker transition action with a real check (an approved document exists for the chosen channel — `generated_documents` now makes this implementable); schema-guard replay fixture values on read; reorder the LLM sensitivity tie-break after the application-scoping check; extract the duplicated `ProvenanceChips` component; add a two-workspace test for `listReusableAnswers`. **Burned during P4** (commit `d229990`, verified in the Task 15 gate).

First live external mutation — the gate framework becomes real.

- `credentials` encryption (libsodium + master key), connection setup with pre-enable test and redacted errors, disconnect/delete.
- Full three-layer gate implementation: env gates, sandbox adapter block, preview → fingerprint → retype-target confirmation → pending receipt → evidence → confirmed receipt.
- SMTP send with attachments; Message-ID + attachment-hash receipts; `FAILED` / `NEEDS_RECONCILE` handling.
- IMAP polling job, header-based threading, retention setting enforcement.
- `classifyReply` + suggestion review queue; auto-ack threshold config.
- Dev/demo sends target Mailpit — visibly harmless and screenshot-friendly.
- ADR-0005 (credential encryption).

**Demo:** draft → preview → retype-target confirm → send → receipt in tracker → simulated reply auto-linked and classified in Mailpit.

## P5 — Assisted auto-apply (Greenhouse, Lever) (done)

Carried from the P4 final review (land in P5, all minor/deferred — no correctness gap blocks P4's own DoD): sender-domain reply matching treats a mail subdomain (e.g. `mail.acme.com`) and its parent domain (`acme.com`) as unrelated, so a legitimate ATS-relay sender falls through to no match rather than the sender-domain fallback — widen or deliberately scope `matchInboundToApplication` (`packages/email/src/threading.ts`); a per-folder IMAP fetch failure currently skips the sync-state advance for every folder on that connection, not just the failing one (safe — nothing already-fetched is lost — but wasteful, since a persistently broken folder blocks re-fetch progress on healthy siblings too); add the concurrency test proving two simultaneous `confirmAndSend` calls on the same token cannot both complete (the repo-layer compare-and-swap already enforces this — only the test is missing); add nonce-randomness and short-ciphertext-buffer unit tests for `sealSecret`/`openSecret` (`packages/db/src/crypto.ts` — manually verified correct, coverage deferred); the "please re-preview" UI copy omits `token_missing` from its reasons list (UX-only — the gate itself already denies it correctly).

- Canonical application-form schema in `contracts`.
- `apps/demo-ats`: fictional company careers site with Greenhouse-style multi-step and Lever-style single-page forms — CI e2e target and demo destination.
- Playwright driver in worker: isolated context, per-step recovery state, pause-and-return on CAPTCHA/login/assessment/attestation.
- Greenhouse adapter, Lever adapter, generic parser fallback with lowered confidence; saved-HTML regression fixtures + `parser_version`.
- Deterministic fill from facts/answer bank; `interpretField` for ambiguous fields; `generate` for screening questions.
- Review screen: every answer with source, AI-marking, diffs from previously approved answers, unanswered/low-confidence flags.
- Gated submit with confirmation-page evidence capture; duplicate-requisition detection with explicit override.
- ADR-0007 (canonical form schema).

**Demo:** full end-to-end auto-apply against `demo-ats`.

## P6 — Hosted demo and portfolio polish (done)

Delivered (2026-08-04, `feature/attestation-consent`, ahead of and outside this phase's numbered plan): the field-level-consent design the P5 final review proposed for reconsideration here has shipped. `detectBlockers` no longer treats a required legal-attestation *checkbox* as a permanent page-level blocker — the review screen renders it as an explicit, never-pre-ticked checkbox next to the exact attestation wording, and only the user's own click sets `source: "user"` into the fingerprinted payload and the confirmed receipt (spec §10.6, revised in spec v0.4 — see [ADR-0007](adr/0007-canonical-form-schema.md)'s revision note). Consent is never reused across applications (`CONSENT_ONLY_FIELDS`, `packages/core/src/autoapply/plan.ts`). A required attestation that is *not* a checkbox — a typed signature, a signature-date field, anything that cannot be rendered as one honest tick — still pauses the attempt exactly as before; `demo-ats`'s `/signature/jobs/:id` fixture is that case's CI/demo proof.

- **Live-page re-verification before typing** (carried from the `feature/attestation-consent` final review as F5) — **done** in `b848f93` and hardened in `3248d4a`. Before a keystroke, the driver refuses to fill a control unless it still has the same id, the same field-identity hash (selector *and* the question beside it) and the same `CanonicalFormField.kind` it had at review, checked from both the live page's side and the reviewed side. A mismatch throws pre-click, so the refusal costs nothing: the orchestrator undoes `beginSubmission` — the confirmation goes back to unconsumed and the attempt back to `PENDING_CONFIRMATION` — and the same token confirms again once the page matches what was reviewed, instead of the attempt being parked `NEEDS_RECONCILE`. (Corrected in the P6 final branch review: until then it was `FAILED` with the token spent, which is not retryable at all.) The residual gaps are carried below.
- **DNS-name SSRF** (found by the Task 2 review, partially closed in `7429766`, redirect half closed in `5d5c1ec`, resolve-then-pin closed after P6 on `feature/deferred-cleanup`): see the carried list below — the entry there is the current, corrected wording and this line is only a pointer, not a second copy.
- `docker-compose.demo.yml`: sandbox workspace, `SANDBOX_FORCE_SAFE`, Mailpit egress, demo-ats allowlist, AI replay mode, 6-hour reset job, mutation rate limits, demo banner — plus hard `mem_limit`s, log rotation, and a profiled one-shot `migrate` service so a fresh box needs no Node toolchain.
- Demo safety as a runtime mode, not a fork: `DEMO_MODE` resolves the sandbox workspace, disables credential setup server-side, arms the per-action rate limiter, and schedules a transactional six-hourly wipe-and-reseed that a personal deployment never so much as registers.
- Disk ceilings a reset gives back: 2 MB per CV and a 64 MB/100-file store in demo mode, a shared 64 MB/200-file ceiling for auto-apply evidence screenshots reserved *before* the submit click, and Next's server-action body limit raised to 6 MB so the app's own caps are the ones that decide.
- Global browser-concurrency limit with an honest refusal, holding the slot across a whole confirm so a refusal cannot burn a confirmation token.
- AI replay fixtures for every demo flow, so the demo spends no tokens and depends on no provider's uptime.
- VPS deployment behind the existing `edge-nginx` reverse-proxy TLS; public demo URL <https://careerhq.nickkalas.dev>.
- Docs complete: architecture diagram refreshed with the demo overlay and the edge proxy, full ADR set, [`SECURITY.md`](../SECURITY.md), MIT [`LICENSE`](../LICENSE), and [`runbook-demo.md`](runbook-demo.md) with real deploy/update/reset/backup/restore/rollback commands.
- README final: screenshot gallery, walkthrough recording, one-command quickstart verified from a clean clone, complete env table.

**Demo:** the public URL, and `git clone && docker compose up`.

### Carried beyond P6

Found by execution during P6 and deliberately not fixed, each with the reason it was left. A deferred item without its rationale gets re-litigated or silently dropped, so the reasoning is part of the entry. The security-relevant ones are also stated in [`SECURITY.md`](../SECURITY.md); the two documents are meant to agree.

**Security**

- **DNS-name SSRF — resolve-then-pin — done.** The capture policy refuses non-`http(s)` URLs and literal private/loopback/link-local/CGNAT/benchmarking/IPv6-translation hosts, and it re-applies itself at **every redirect hop** — judged from the `Location` header before the hop is requested. (An earlier version of this entry claimed the hosted demo was unaffected because the sandbox host allow-list is a separate, earlier layer. That was wrong and was proven wrong: until `5d5c1ec`, one `302` from the allow-listed host to `127.0.0.1` walked straight through. The allow-list narrows which *first* host may be visited; it never constrained where that host could send the browser next.) What remained — the check being on the *literal* host — is now closed: every navigation's hostname is resolved, **every** A and AAAA record must pass the same range table (`isInternalAddress`, one predicate shared with the literal check), and a main-frame `GET` is then fetched over a socket dialled at exactly those addresses, so the name cannot be re-resolved between check and fetch. Proven by exploit against real public DNS (`127-0-0-1.nip.io`): before, the loopback page's contents came back in `bodyText` with one request reaching the loopback server; after, the navigation is refused and the loopback server receives zero — first hop and redirect hop alike, with `https://example.com/` still captured normally. The check lives in `packages/autoapply/src/target-policy.ts`; the pin, which is inseparable from it, in `apps/worker/src/autoapply/pinned-navigation.ts`.
- **Non-GET navigations and subresources are not pinned, and non-GET is not chain-walked.** Both are policy- and resolution-checked, but Chromium makes those connections itself and resolves the name a second time to do it, so a rebinding answer in that window is not caught. The submit POST is additionally backstopped by a landed-URL assertion, but that assertion lands *after* the click. Replaying a multipart POST through the guard's own fetch to close either was judged worse than the gap, for the same reason as before: it risks submitting an application twice. Subresources are not host-checked at all — they cannot return a body to the app, so what they reach is blind.
- **The sandbox allow-list is an origin comparison now — but its shipped value still names only a host.** `matchesSandboxAllowList` compares scheme + host + port and accepts `demo-ats`, `demo-ats:3001` or `http://demo-ats:3001`; the confirm-time gate (`sandboxTargetAllowed`) uses the same predicate against `payload.url` rather than comparing `payload.host`, so a port cannot slip past it either. A value with no port still matches any port on that host, which is what the default `demo-ats` and both Compose files do today: rejecting the bare spelling would have broken every existing deployment, and `packages/config` parses this variable as a plain string. `.env.example`, README's env table and the local demo recipe now show the port-pinned spelling, and site-e2e runs it. The Compose values were left alone deliberately — a stricter value there is one this branch could not verify against a running stack.
- **The worker's queue capture path gets the strict default, not the sandbox exemption.** `apps/worker/src/jobs/autoapply.ts` passes only `isNavigationAllowed`, so the driver falls back to `defaultAddressPolicy`, which refuses an internal address unless the caller's own predicate already allows that address (or the literal host is an allow-listed internal name). In Compose, where the allow-listed target is the *name* `demo-ats` and its address is private by design, that path would refuse — a one-line fix (pass `allowsResolvedAddress` beside `allowsCaptureTarget`, exactly as `apps/web/src/lib/site-driver.ts` does) left to whoever registers those consumers, which is already gated on the `writeFile`-retry hazard below. Refusing is the right way round for a default to be wrong, and the path is unreachable until then.
- **A post-click `writeFile` failure in `runSubmitJob` throws, and pg-boss would retry it — a double submit.** Unreachable today because neither auto-apply consumer is registered in `apps/worker/src/main.ts`. **This is a hard precondition on ever registering them**, not a nice-to-have: double submission is the failure mode the entire gated protocol exists to prevent.

**Correctness**

- **A field that disappears between review and submit is not always caught.** The identity check compares fields the live extraction returned; requiring presence outright would break multi-step forms whose later controls do not exist in the first extraction. Step scoping is what keeps that workable, and "rendered steps" is inferred from a single pre-click extraction — so a form whose later-step fields are *replaced* rather than revealed after "Next" is not judged. Needs a per-step design. Matters most for a consent tick.
- **`NEEDS_RECONCILE` screenshot paths are persisted to no row**, so in demo mode the evidence collector reclaims the file after five minutes while the attempt's reason still tells the user to check it. Fix: persist the path onto the snapshot's `recovery_state`, as the worker already does elsewhere.
- **Three of 1,549 reads can straddle a demo reset commit.** Resolving the workspace and counting applications are two statements; the data is never half-built, but a page load can catch the boundary. Needs a read transaction in `apps/web`.

**Operational**

- **Rate limiting is per-process and per-action, not per-visitor.** One aggressive visitor consumes the shared budget for everyone. The browser cap has the same shape — per process, so `web` and `worker` can each hold one Chromium. A host-wide cap needs `pg_try_advisory_lock` or equivalent outside both processes.
- **Eleven mutating server actions remain unthrottled** across `applications/`, `facts/`, `inbox/` and `settings/actions.ts`. None is dangerous on a public URL: they write rows, which the six-hourly reset reclaims — unlike `uploadCv`, which wrote files it did not. Six are one-line fixes; five return `void` and need a `useActionState` conversion across three pages. Do it as **one complete pass** — throttling one action but not its neighbour in the same file advertises a guarantee the file lacks.
- **Free-text fields have no `.max()`** — `notes`, `claim`, `detail` and the scoring textareas are bounded only by Next's server-action body limit. That limit is now 6 MB and applies to *every* action, so the previously-1 MB implicit bound on these row writes is six times looser than it was, which makes adding the caps more worthwhile than it was when they were skipped.

**The identity check now fails closed — a trade made deliberately in `3248d4a`**

- **The driver is strictly more willing to refuse than before, and no real ATS was available to probe it against — only `demo-ats`.** After the consent-bypass fix, a fill is refused unless the field has the same id, the same `fieldIdentityHash`, *and* the same `CanonicalFormField.kind`. What to watch when this first meets a real Greenhouse or Lever page: an ATS that legitimately re-renders a control into a different `type`, or reveals a field conditionally *within the same step*, will be refused; step scoping is the only thing preventing multi-step breakage, and a form whose later-step fields are replaced rather than revealed would be refused (no committed test covers that shape, since `demo-ats` renders all steps up front); and T6's original tolerance for a field that *disappears* is deliberately reversed for rendered steps. Refusing is the safe direction — a refusal is pre-click and genuinely retryable (the confirmation is handed back unspent; see the entry above), whereas the bug it replaced sent a consent the user had declined. But if false refusals show up against a real ATS, the fix is to narrow the `kind` comparison, **not** to restore the old skip.

**Verification practice** (worth stating here, and in CONTRIBUTING when there is one)

- **A green `pnpm build` plus a green Vitest run does not prove the app works.** Vitest resolves through Node; Next compiles server actions through a separate webpack pass with different semantics. Two real bugs shipped through a fully green gate this phase: `import.meta.dirname` undefined in the flight-action bundle (every `/applications/[id]` action 500'd while 204 tests passed), and a module-level `Map` instantiated once per bundle rather than once per process (the rate limiter's counters silently unshared). Anything touching a server action, an API route, or module-level state in `apps/web` must be verified against a real `next start`.

## P7 — Restricted-source connector (optional, post-core)

Spec §5.3. Deliberately last: it must never jeopardize the core portfolio, and it is excluded from the hosted demo entirely.

- `services/restricted-ingest`: Python service wrapping JobSpy (LinkedIn, Indeed, Glassdoor, Google Jobs, ZipRecruiter) under a dedicated Compose profile; narrow JSON contract to the worker.
- Consent flow in settings: risk disclosure, typed acknowledgment, versioned consent record, revocation; UI hides restricted sources until consent exists.
- Safeguards: mandatory proxy pool (refuses host IP), per-board circuit breakers, bounded runs; `RESTRICTED_SOURCES_ENABLED` env gate; sandbox can never reach it.
- Restricted-source provenance labels in the inbox; standard dedup and scoring.
- ADR-0006 updated with the isolation/consent design.

**Demo:** local-only walkthrough (screenshots/video, not the hosted demo): consent flow → bounded run → labeled listings in the inbox.

## Sequencing rationale

- P1–P3 alone already showcase three of the four target skills (full-stack, AI, architecture); automation lands in P2 (feeds) and P5 (browser). If time is cut short, the repo still stands.
- Gate *types* exist in `core` from P1 (the state machines depend on them), but the first live channel arrives in P4, so gate code is exercised by real stakes exactly once designed.
- `demo-ats` is built in P5 as a test dependency, not deferred to P6 polish — auto-apply is not "done" until it is e2e-tested against it.
