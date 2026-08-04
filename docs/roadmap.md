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

## P6 — Hosted demo and portfolio polish

Delivered (2026-08-04, `feature/attestation-consent`, ahead of and outside this phase's numbered plan): the field-level-consent design the P5 final review proposed for reconsideration here has shipped. `detectBlockers` no longer treats a required legal-attestation *checkbox* as a permanent page-level blocker — the review screen renders it as an explicit, never-pre-ticked checkbox next to the exact attestation wording, and only the user's own click sets `source: "user"` into the fingerprinted payload and the confirmed receipt (spec §10.6, revised in spec v0.4 — see [ADR-0007](adr/0007-canonical-form-schema.md)'s revision note). Consent is never reused across applications (`CONSENT_ONLY_FIELDS`, `packages/core/src/autoapply/plan.ts`). A required attestation that is *not* a checkbox — a typed signature, a signature-date field, anything that cannot be rendered as one honest tick — still pauses the attempt exactly as before; `demo-ats`'s `/signature/jobs/:id` fixture is that case's CI/demo proof.

- **Live-page re-verification before typing** (carried from the `feature/attestation-consent` final review, F5): the driver fills from the `RawFormPage` captured at prepare time and re-extracts at submit time, but it never checks that the field under a selector still asks the question the user reviewed. A page edited between review and submit could therefore receive an answer planned for a different field — pre-existing in kind (it predates the consent work), but it matters most for a consent tick, whose whole meaning is the statement it sits next to. Options: pin a per-field label/nearby-text hash into the snapshot and refuse the fill on a mismatch, or fold the re-extracted labels into the payload fingerprint so the confirmation simply fails.
- **DNS-name SSRF, deferred beyond P6** (found by the Task 2 review, partially closed in `7429766`): the auto-apply capture path now refuses non-`http(s)` URLs and literal-IP hosts in loopback/link-local/private ranges — the review proved the hole by capturing `http://169.254.169.254/latest/meta-data/` and reading a local file through `file://`, and the same probe now refuses. What remains open is that the check is on the *literal* host, so a DNS name resolving to a private address still passes. The hosted demo is not exposed (the sandbox host allow-list is a separate, earlier layer), but a **personal** install with `SANDBOX_FORCE_SAFE` off is. Closing it properly needs resolve-then-pin — resolve the hostname, reject the resolved address against the same range table, and connect to the pinned IP so the name cannot be re-resolved between check and fetch.
- `docker-compose.demo.yml`: sandbox workspace, `SANDBOX_FORCE_SAFE`, Mailpit egress, demo-ats allowlist, AI replay mode, 6-hour reset job, mutation rate limits, demo banner.
- VPS deployment behind reverse-proxy TLS; public demo URL.
- Docs complete: architecture diagrams current, full ADR set, `SECURITY.md`, license.
- README final: screenshot gallery, 2–3 minute demo video, one-command quickstart, backup/restore procedure.

**Demo:** the public URL, and `git clone && docker compose up`.

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
