# Career HQ Product Specification

**Version:** 0.3
**Status:** Working specification
**Product description:** An AI-assisted, self-hosted job-search workflow platform that helps a user discover suitable roles, prepare high-quality grounded applications, submit them through supported channels under an explicit safety protocol, and track outcomes.

**Project intent:** Career HQ is a portfolio project. It must demonstrate production-grade full-stack engineering (Next.js/TypeScript), responsible AI integration, browser/feed automation, and architecture quality — in a public repository containing zero real personal data, with a hosted demo a visitor can explore in under two minutes. It is not a commercial multi-tenant SaaS.

---

## 1. Product principles

1. **Self-hosted and private by default.** All data lives in the user's own Postgres instance and file volume, deployed via Docker Compose on their machine or VPS. Nothing leaves the stack except calls to job feeds and the LLM provider.
2. **Deterministic code owns decisions.** Filtering, scoring breakdowns, form validation, state transitions, and submission rules are deterministic and auditable. AI assists with language interpretation and generation only.
3. **AI never invents candidate facts.** Every generated answer must be grounded in the verified Candidate Fact Bank, cite the facts it used, and be blocked when no supporting fact exists. Sensitive answers (work authorization, demographics, salary, availability, criminal history, legal attestations) are never AI-inferred.
4. **Every AI feature has a deterministic floor.** The application remains fully functional when the LLM is unavailable: keyword scoring stands without re-rank, replies match by headers without classification, answers can be written manually without generation.
5. **Review-first, gated mutations.** No email is sent and no form is submitted without a preview, an explicit per-application confirmation bound to the previewed payload, and server-side safety gates. Uncertain outcomes are never retried automatically.
6. **Public repo, fictional data.** The repository and hosted demo use a fictional persona ("Alex Demo"). The demo sandbox cannot reach any real external target.
7. **Restricted-platform automation is out of scope.** LinkedIn Easy Apply, Indeed Apply, Glassdoor, CAPTCHA bypass, anti-bot circumvention, and unattended account automation are permanently excluded from this project.

## 2. Architecture overview

- **Stack:** Next.js (App Router) + TypeScript monorepo (pnpm + Turborepo). Postgres via Drizzle ORM. pg-boss for background jobs (no Redis). Playwright for form automation. OpenRouter for LLM access.
- **Apps:** `apps/web` (UI + server actions), `apps/worker` (long-running job consumers: ingestion, IMAP sync, classification, auto-apply, demo reset), `apps/demo-ats` (a small fictional ATS serving Greenhouse-style and Lever-style application forms; the e2e test target and the hosted demo's only auto-apply destination).
- **Packages:** `contracts` (shared Zod schemas/types), `core` (pure domain logic: state machines, scoring, gates, grounding validation — no IO), `db`, `ai`, `ingest`, `email`, `autoapply`, `config`.
- **Deployment:** `docker compose up` runs web, worker, postgres, and Mailpit. A demo compose file adds `demo-ats`, forces sandbox safe mode, and schedules periodic resets.
- **Files:** CV PDFs, submission screenshots, and message bodies are stored on a Docker volume; the database stores metadata and SHA-256 hashes.

Details: `docs/architecture.md`. Delivery order: `docs/roadmap.md`.

## 3. Workspaces and demo mode

- Every domain row belongs to a `workspace`. A workspace has `kind: personal | sandbox`.
- The hosted demo serves only a sandbox workspace, seeded with the fictional persona, realistic jobs, applications in various states, and pre-recorded AI outputs. A worker job resets the sandbox every 6 hours.
- Sandbox safety is enforced at the adapter layer (not the UI): submission adapters throw a `Blocked` error for sandbox workspaces unless the target is the built-in safe destination (Mailpit for email, `demo-ats` origin for auto-apply).
- Demo instances run the AI layer in replay mode (pre-recorded fixtures) so the demo never depends on LLM availability or spends tokens; a visitor can still trigger "generation" and watch it stream.
- The demo is read-mostly: mutation endpoints are rate-limited, and personal-workspace features (credential setup) are disabled in sandbox.

## 4. Core workflow

1. Ingest and normalize job listings from supported public feeds and ATS boards, plus user-added URLs.
2. Deduplicate, score deterministically against the candidate profile, and optionally LLM re-rank the top N.
3. Promote a job to an application; research and decide pursue/skip.
4. Prepare materials: select a CV variant, draft grounded answers and cover letter with cited facts.
5. Apply by email or through a supported company career site, via the gated submission protocol.
6. Record the attempt, evidence, correspondence, and status changes; follow up on schedule.
7. Review funnel analytics (per source, channel, CV variant, and score band) to steer future effort. Analytics never modify candidate facts.

## 5. Job discovery

### 5.1 Sources

Keyless public feeds and endpoints only, fetched politely (honest User-Agent, per-source rate limits, conditional requests where supported):

- Remotive, RemoteOK, Arbeitnow, We Work Remotely, The Muse (public APIs/feeds).
- Public Greenhouse (`boards-api.greenhouse.io`) and Lever (`api.lever.co/v0/postings`) boards for companies on a user-maintained watchlist.
- Hacker News "Who is hiring" threads (stretch goal — noisiest source).
- Manual URL/paste capture for anything else.

Scraping sites that prohibit it, and any credentialed job-board access, are out of scope.

### 5.2 Normalization and deduplication

- Each fetch normalizes listings into the canonical `Job` shape (company, title, location, remote mode, salary text, description, URL, source, external id).
- Dedup key 1: `(workspace, source, external_id)` — same listing re-fetched updates `last_seen_at`.
- Dedup key 2: content hash over normalized company + title + description prefix — catches the same role cross-posted on multiple boards; duplicates link to the first-seen job.
- A job absent from its source for a configurable window (default 21 days) is marked expired; expiry suggests `EXPIRED` for applications still in `DISCOVERED`/`SHORTLISTED`.
- Every ingest run records counts and errors (`IngestRun`) and is visible in a pipeline-health panel.

### 5.3 Scoring

- **Deterministic score (always on):** configurable profile of role keywords, stack keywords, boost terms, exclude terms, and remote requirements produces a numeric score with a persisted per-term breakdown shown in the UI.
- **LLM re-rank (optional layer):** the top N (default 25) unscreened jobs are sent to the `fast` model tier, which returns `{score 0–100, rationale, redFlags[]}` per job. Re-rank annotates and reorders; it never deletes or hides jobs. If the LLM is unavailable, the keyword order stands.

## 6. Application tracking

### 6.1 States

`DISCOVERED → SHORTLISTED → PREPARING → READY_FOR_REVIEW → SUBMITTED → ACKNOWLEDGED → INTERVIEW → OFFER`

Terminal/side states: `REJECTED`, `WITHDRAWN`, `EXPIRED`.

### 6.2 Transition rules

| From | To | Trigger | Guard |
|---|---|---|---|
| DISCOVERED | SHORTLISTED | user | — |
| SHORTLISTED | PREPARING | user | — |
| PREPARING | READY_FOR_REVIEW | user/system | materials exist for chosen channel |
| READY_FOR_REVIEW | SUBMITTED | attempt | a confirmed `ApplicationAttempt` exists — user cannot set SUBMITTED directly |
| SUBMITTED | ACKNOWLEDGED | classification/user | auto only when classification is `ack` with confidence ≥ 0.9 (configurable); otherwise suggested |
| SUBMITTED/ACKNOWLEDGED | INTERVIEW | user (suggested by classification) | always requires user confirmation |
| INTERVIEW | OFFER | user (suggested by classification) | always requires user confirmation |
| any active | REJECTED / WITHDRAWN | user (REJECTED suggestible by classification) | always requires user confirmation |
| DISCOVERED/SHORTLISTED | EXPIRED | system (job expiry) | suggested, user-confirmable in bulk |

- All transitions append to an immutable `ApplicationEvent` log (from, to, trigger `user|attempt|classification|system`, payload). The state column is a projection of this log.
- **Manually-logged external applications:** the user can record an application made outside Career HQ; it enters at `SUBMITTED` with an attempt of channel `external` and origin `manual` (no receipt evidence required, clearly labeled).
- Application attempts are separate from application state: a failed send or blocked submission never erases the application or prior attempts.
- Each application carries one computed **next action** (e.g. "complete research", "review draft answers", "follow up — due Aug 12") derived from its state and artifacts; open states get default follow-up offsets (SUBMITTED +7 days, configurable).

## 7. Candidate Fact Bank and grounded generation

### 7.1 Fact Bank

- `CandidateFact`: category (`identity, contact, experience, education, skill, preference, authorization, compensation, availability`), claim, optional detail and evidence URL, sensitivity (`normal | sensitive`), `verified_at`, `review_by` date, archivable.
- Facts are user-entered and user-verified. Nothing — not AI, not analytics — may create or modify facts. Facts past `review_by` are flagged stale in the UI and excluded from generation until re-verified.

### 7.2 Generation contract (normative)

1. Deterministic fact selection picks the minimal relevant fact subset for a question (category + keyword overlap). The model never receives the full bank.
2. The model must return structured output: `{answer, factIds[], confidence, unsupportedClaims[], clarificationNeeded?}`.
3. Deterministic post-validation (in `core`, never trusting model self-report): every cited factId must be in the provided subset; citations render as provenance chips in review UI.
4. If `unsupportedClaims` is non-empty, confidence is below threshold, or no supporting fact exists for a factual question, the answer is blocked with status `NEEDS_FACTS` and the UI prompts the user to add a verified fact or answer manually.
5. Questions classified sensitive (authorization, demographics, disability, criminal history, salary, availability, relocation, legal attestations — conservative keyword ruleset with LLM tie-break that can only widen, never narrow, the sensitive set) are never sent to generation; they are answered deterministically from facts/saved answers or left to the user.
6. Approved answers may be saved as reusable (`ApplicationAnswer.reusable`), retaining source fact IDs and a last-review date; reusable answers past review are flagged before reuse.
7. AI-generated text is always visibly marked as generated until the user approves it.

## 8. AI layer

- **Provider:** OpenRouter (OpenAI-compatible API), chosen for access to free and low-cost models behind one endpoint.
- **Client:** a thin `chatJson<T>` client — JSON mode, tolerant JSON extraction (cheap models often wrap JSON in prose), Zod schema validation, an `isUseful` predicate, a never-throws result object, and timeout/abort. Plus **sequential model fallback** over an ordered list with exponential backoff on 429/5xx and per-model cooldown after rate limiting. Streaming variant for long-form generation UX (final text validated server-side before persisting).
- **Model tiers as configuration data** (free offerings churn; lists live in env/db, not code):
  - `fast` — re-rank, reply classification, field interpretation, sensitivity tie-break.
  - `writing` — cover letters and narrative answers; last-resort entry may be a paid-but-cheap model.
- **Tasks:** `rerank` (§5.3), `generate` (§7.2), `classifyReply` (§9.5), `interpretField` (§10.4).
- **Record/replay:** a development flag records `(task, promptHash) → response` fixtures; CI and the hosted demo run in replay mode. Live responses may be cached by prompt hash.
- **Cost posture:** free tiers first; the system must degrade gracefully (deterministic floor, §1.4) rather than queue-block on provider failures.

## 9. Email channel

### 9.1 Purpose

Send applications from the user's own mailbox and optionally synchronize replies (acknowledgements, recruiter replies, interview invitations, rejections, offers) into the tracker.

### 9.2 Connection methods

User-provided credentials only; Career HQ never ships provider credentials:

- SMTP for outbound (including provider app passwords).
- IMAP for inbound synchronization (SMTP alone cannot track replies).
- Provider OAuth adapters (Gmail/Outlook) are a later phase.

### 9.3 Account configuration

Label, sender identity, address, display name, optional reply-to; SMTP host/port/username/TLS mode; optional IMAP host/port/username/TLS mode and monitored folders; signature and default application template. Connections are tested before enabling, with precise, secret-redacted errors. TLS is required for remote connections (a non-TLS exception exists only for explicitly configured local services such as Mailpit). Disconnect deletes the stored credential.

### 9.4 Application flow

1. Draft: recipient (from listing or user), subject, body (generated or manual per §7.2), selected CV variant and optional attachments.
2. Preview and submit via the gated submission protocol (§11).
3. On SMTP acceptance: store Message-ID, timestamps, recipients, attachment metadata (name, size, SHA-256), link to the application, transition to `SUBMITTED`.
4. On failure: retain the draft, record a redacted failure reason, mark the attempt `FAILED`.

### 9.5 Reply synchronization

- Poll only user-authorized folders.
- Match replies by `In-Reply-To` / `References` / Message-ID first, then sender-domain heuristics; semantic matching is a last resort and always produces a suggestion, not a link.
- `classifyReply` runs only on matched/shortlisted messages and returns `{classification: ack|recruiter|interview|rejection|offer|unrelated, confidence, suggestedState?, quotedEvidence}`.
- Classification suggestions land in a review queue; auto-transition rules per §6.2.
- **Retention setting:** `metadata_only` (headers + snippet, default) | `full_local` (body stored on volume) | days-limited (body purged after N days). Purge runs in the worker; deletion is verifiable in the UI.
- No automatic replies, ever.

## 10. Company-site assisted auto-apply

### 10.1 Purpose

Complete applications on supported employer career sites: parse the form, fill known fields deterministically, draft grounded answers, attach documents, validate, and submit only after gated confirmation.

### 10.2 Flow

1. Open the application URL in an isolated Playwright browser context in the worker.
2. Detect the ATS (Greenhouse, Lever) or fall back to the generic parser with lowered confidence.
3. Parse fields, labels, ARIA metadata, allowed values, validation rules, required documents, and multi-step navigation into the canonical application schema (`FormSnapshot`). DOM selectors are implementation details, never the data model.
4. Fill deterministic fields from the candidate profile and saved answer bank; use AI only for ambiguous field interpretation and free-text questions (§7.2 contract applies).
5. Validate every required field; flag unsupported, ambiguous, sensitive, or low-confidence items.
6. Present a review screen: every answer with its source (fact/saved/AI-marked/user), selected documents, unanswered or low-confidence questions, and any material difference from previously approved answers.
7. Submit via the gated submission protocol (§11). Capture the confirmation page screenshot, confirmation identifier, timestamp, and final URL as evidence.

### 10.3 Canonical schema coverage

Identity and contact; location/remote/relocation/travel; employment history and education; skills, portfolio, and profile links; work authorization and sponsorship; availability and notice period; compensation expectations; voluntary demographic questions; screening and role-specific questions; document uploads.

### 10.4 Field mapping

Labels, surrounding text, input attributes, ARIA relationships, option values, page structure, and ATS-specific adapters. `interpretField` maps ambiguous parsed fields to canonical keys with confidence; low confidence leaves the field for the user.

### 10.5 Supported sites and testing

Greenhouse and Lever adapters first; a generic parser assists on unknown sites with lowered confidence and closer review. Each adapter has saved-HTML regression fixtures and a `parser_version`. The in-repo `demo-ats` app provides Greenhouse-style and Lever-style forms as the e2e target and the hosted demo's only allowed destination.

### 10.6 Failure and recovery

- Save recovery state after each completed form step (never secrets).
- On site changes, preserve mapped answers and show the failed step and field.
- Never auto-retry a final submission with an uncertain outcome (→ `NEEDS_RECONCILE`).
- Detect duplicate applications to the same requisition; require explicit override.
- On CAPTCHA, login walls, identity verification, assessments, unsupported file controls, or legal attestations: pause and return control to the user.

## 11. Gated submission protocol (normative)

Applies to every externally-mutating channel. Three independent, server-side layers; the UI can display gate state but can never open a gate.

**Layer 1 — Server safety config.** `SUBMISSIONS_LIVE_EMAIL` and `SUBMISSIONS_LIVE_COMPANY_SITE` env flags, default **off**, read at boot; changing them requires a container restart. With a gate off, the channel works fully up to and including preview, then blocks.

**Layer 2 — Sandbox hard block.** The last check before any mutation: sandbox workspaces may only target the built-in safe destinations (§3). Enforced inside the adapters.

**Layer 3 — Per-application confirmation.**
1. *Preview:* the server builds the complete canonical payload (target, subject/answers, attachment hashes, form fingerprint), computes `payload_fingerprint = sha256(canonical JSON)`, renders the full preview, and issues a single-use confirmation token (hashed at rest, 10-minute TTL).
2. *Confirm:* the user retypes the exact target (recipient address or company domain). The server verifies: token valid, unconsumed, unexpired; retyped target matches; **the fingerprint recomputes identically** — any edit after preview invalidates the confirmation; the channel gate is on; the workspace is not blocked; no confirmed attempt already exists; no other attempt is in flight.
3. *Execute:* transactionally write the attempt as `SUBMITTING` with a pending receipt **before** the mutation; perform exactly one mutation (one send, one final click); on hard evidence (accepted Message-ID / confirmation page) write the confirmed receipt and transition to `SUBMITTED`; on failure before mutation → `FAILED` with a redacted reason; on uncertainty after mutation → `NEEDS_RECONCILE`, surfaced prominently, resolved only by a human (optionally aided by read-only mailbox/page re-inspection).

Duplicate protection is a database constraint: at most one confirmed attempt per application; overriding (e.g. re-applying after a failed process) requires an explicit user action recorded in the event log.

## 12. Data model

Core entities (all workspace-scoped; full DDL in `docs/architecture.md`):

- `Workspace` — kind `personal | sandbox`.
- `Company`, `Job`, `IngestRun` — discovery (§5).
- `Application`, `ApplicationEvent`, `ApplicationAttempt`, `AttemptConfirmation` — tracking and submission (§6, §11).
- `CandidateFact`, `ApplicationAnswer`, `GeneratedDocument` — grounding and materials (§7).
- `CvVariant` — label, format `designed | ats`, file path, SHA-256. The two-format strategy is first-class: a designed PDF for humans and a single-column ATS-safe PDF for parsers, selected per application.
- `EmailConnection`, `EmailMessage`, `Credential` — email channel (§9, §13).
- `FormSnapshot` — auto-apply (§10): ATS type, URL, parser version, canonical fields, form fingerprint, step, non-secret recovery state.

## 13. Security and credentials

- **Threat model:** single-owner instance; protect secrets at rest against database exfiltration and in logs/errors against accidental leak. An attacker with full host access is out of scope (they own the master key).
- Mailbox and provider credentials are encrypted with libsodium secretbox using a `CAREERHQ_MASTER_KEY` environment secret; the database stores ciphertext only. Plaintext never appears in logs, error messages, API responses, or client-side code. This replaces v0.2's "OS credential vault", which does not exist for a containerized web deployment.
- Redaction middleware strips secrets, auth headers, and unnecessary personal data from diagnostics.
- All mutations are same-origin POST server actions; the confirm endpoint is rate-limited.
- Disconnect and credential-deletion actions are always available; deletion removes the ciphertext row.

## 14. Non-functional requirements

- **Single-owner:** one personal workspace per deployment; no multi-tenant auth system. A VPS-hosted personal instance is protected by a single owner login (password or passkey) plus the usual reverse-proxy TLS; the demo compose instead exposes only the sandbox workspace with no login.
- **Backup:** state = the Postgres volume + the file volume; the README documents a `pg_dump` + volume backup/restore procedure.
- **Observability:** structured logs; ingest-run health panel; worker job failures visible in the UI.
- **Resilience:** the app starts and functions with no LLM key configured (deterministic floor everywhere).

## 15. Analytics

Funnel and response-rate analytics over the event log: applications by state, response rate per channel, per CV variant, per source, and per score band; median time-to-response. Analytics are read-only projections — they inform the user and never feed back into facts or automated decisions.

## 16. Testing and quality

- Unit tests (Vitest) for: state-machine transition/guard tables, scoring breakdowns, fingerprint stability and tamper detection, gate-evaluation matrix, JSON-extraction and fallback-chain behavior (mocked 429 sequences), grounding post-validation (fabricated fact IDs, sensitive-question blocks), form normalization from saved ATS HTML fixtures, email threading.
- Integration tests against ephemeral Postgres (testcontainers) and Mailpit.
- A small number of meaningful Playwright e2e tests: tracker flow, gated email send verified in Mailpit, full auto-apply against `demo-ats`, and a negative test (edited payload → fingerprint mismatch → blocked).
- CI (GitHub Actions): lint, typecheck, dependency-boundary check (dependency-cruiser), unit + integration on PR; e2e + Docker image builds on main.

## 17. Portfolio deliverables (in scope)

- README with architecture and gated-submission sequence diagrams (mermaid), screenshot gallery, and a 2–3 minute demo video.
- ADRs for the significant decisions: Postgres+pg-boss, gated-mutation protocol, OpenRouter sequential fallback, grounding contract and sensitive-answer policy, credential encryption vs OS keyring, scraping/ToS boundaries, canonical form schema.
- One-command local quickstart (`docker compose up` + seed) and a public hosted demo URL.
- Fictional persona seed data; zero real personal data anywhere in repo or history.

## 18. Delivery phases

Six phases, each independently shippable and demoable (full detail in `docs/roadmap.md`):

- **P1** Foundation: scaffold, tracker with state machine and event log, Fact Bank, CV variants, seed, CI.
- **P2** Discovery: feed ingestion, dedup, deterministic scoring, LLM re-rank, discovery inbox.
- **P3** AI materials: grounded generation with provenance, answer bank, replay layer.
- **P4** Email channel: credentials, gates go live, SMTP send with receipts, IMAP sync, reply classification.
- **P5** Auto-apply: canonical form schema, `demo-ats`, Greenhouse + Lever adapters, review screen, gated submit.
- **P6** Hosted demo and portfolio polish: sandbox deployment, resets, docs, video.

## 19. Out of scope

- Restricted job-board automation (LinkedIn, Indeed, Glassdoor), CAPTCHA/anti-bot circumvention, unattended account automation — permanently, not "later".
- Multi-tenant SaaS features: billing, teams, per-user plans.
- Automatic outbound replies to recruiters.
- Machine learning on outcomes beyond the read-only analytics of §15.
- Gmail/Outlook OAuth adapters are deferred beyond P6 (SMTP/IMAP with app passwords covers them meanwhile).
