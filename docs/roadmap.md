# Career HQ — Delivery Roadmap

Six phases. Each ends with green CI, a working demo, and an updated README — the repository is presentable to a prospective client at every point after P1. Spec references: [`career-hq-product-spec.md`](../career-hq-product-spec.md); structure: [`architecture.md`](architecture.md).

## P1 — Foundation, tracker, Fact Bank

The skeleton that proves the architecture.

- Monorepo scaffold (pnpm + Turborepo), `docker-compose.yml` (web, worker, postgres, mailpit), CI pipeline (lint, typecheck, dependency-cruiser, unit tests).
- `packages/contracts`, `packages/db` (initial schema + migrations), `packages/core` (application + attempt state machines with event log), `packages/config`.
- Tracker UI: Kanban board with guarded transitions, application detail with event history, computed one-next-action panel, follow-up due dates.
- Candidate Fact Bank CRUD with categories, sensitivity, verification/review dates, stale-fact flagging.
- CV variant upload (designed + ATS formats, hashes on volume).
- Fictional-persona seed (`pnpm seed`): "Alex Demo", ~15 facts, 2 CV variants, ~10 applications across states with event history.
- README v1, ADR-0001 (Postgres + pg-boss), ADR-0002 (gated-mutation protocol — designed now, enforced from P4).

**Demo:** seeded tracker walkthrough — board, guarded transitions, event log, fact bank.

## P2 — Discovery ingestion and scoring

- `packages/ingest`: normalizer, `(source, external_id)` + content-hash dedupe, expiry detection; fetchers for Remotive, RemoteOK, Arbeitnow, We Work Remotely, The Muse, and Greenhouse/Lever/Ashby board polling from a watchlist. Stretch: HN "Who is hiring", and bring-your-own-key fetchers (Adzuna, Reed.co.uk, USAJobs).
- pg-boss scheduled ingestion; `ingest_runs` + pipeline-health panel.
- Deterministic keyword scorer in `core` with persisted per-term breakdown; scoring-profile settings UI.
- `packages/ai`: chatJson client, sequential fallback, model-tier config; `rerank` task over top-25 with rationale and red flags.
- Discovery inbox UI: ranked list, score breakdown + LLM rationale, promote-to-application, dismiss.
- ADR-0003 (OpenRouter sequential fallback), ADR-0006 (scraping/ToS boundaries).

**Demo:** live feed pull → scored, re-ranked inbox → promote to tracker.

## P3 — AI materials generation

The headline AI demo.

- Grounding service: deterministic fact selection, `generate` task, deterministic citation post-validation in `core`.
- Cover letter and email-body drafting with streaming UI; provenance chips linking each claim to facts; visible AI-generated marking until approval.
- `NEEDS_FACTS` flow: blocked generation prompts "add a verified fact or answer manually".
- Sensitive-question classification (keyword ruleset + LLM tie-break) with hard generation block.
- Answer bank: approve → reusable answers with source facts and review dates.
- Record/replay layer + fixtures; CI runs AI tests in replay mode.
- ADR-0004 (grounding contract and sensitive-answer policy).

**Demo:** grounded generation with citations — including a deliberate on-camera block when no supporting fact exists.

## P4 — Email channel

First live external mutation — the gate framework becomes real.

- `credentials` encryption (libsodium + master key), connection setup with pre-enable test and redacted errors, disconnect/delete.
- Full three-layer gate implementation: env gates, sandbox adapter block, preview → fingerprint → retype-target confirmation → pending receipt → evidence → confirmed receipt.
- SMTP send with attachments; Message-ID + attachment-hash receipts; `FAILED` / `NEEDS_RECONCILE` handling.
- IMAP polling job, header-based threading, retention setting enforcement.
- `classifyReply` + suggestion review queue; auto-ack threshold config.
- Dev/demo sends target Mailpit — visibly harmless and screenshot-friendly.
- ADR-0005 (credential encryption).

**Demo:** draft → preview → retype-target confirm → send → receipt in tracker → simulated reply auto-linked and classified in Mailpit.

## P5 — Assisted auto-apply (Greenhouse, Lever)

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

- `docker-compose.demo.yml`: sandbox workspace, `SANDBOX_FORCE_SAFE`, Mailpit egress, demo-ats allowlist, AI replay mode, 6-hour reset job, mutation rate limits, demo banner.
- VPS deployment behind reverse-proxy TLS; public demo URL.
- Docs complete: architecture diagrams current, full ADR set, `SECURITY.md`, license.
- README final: screenshot gallery, 2–3 minute demo video, one-command quickstart, backup/restore procedure.

**Demo:** the public URL, and `git clone && docker compose up`.

## Sequencing rationale

- P1–P3 alone already showcase three of the four target skills (full-stack, AI, architecture); automation lands in P2 (feeds) and P5 (browser). If time is cut short, the repo still stands.
- Gate *types* exist in `core` from P1 (the state machines depend on them), but the first live channel arrives in P4, so gate code is exercised by real stakes exactly once designed.
- `demo-ats` is built in P5 as a test dependency, not deferred to P6 polish — auto-apply is not "done" until it is e2e-tested against it.
