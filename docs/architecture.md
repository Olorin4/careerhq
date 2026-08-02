# Career HQ — Architecture

Companion to [`career-hq-product-spec.md`](../career-hq-product-spec.md) (v0.3). The spec says *what*; this document says *how and where*.

## 1. System overview

```mermaid
flowchart LR
    subgraph compose["Docker Compose"]
        web["apps/web\nNext.js App Router"]
        worker["apps/worker\npg-boss consumers"]
        pg[("Postgres")]
        mailpit["Mailpit\n(dev/demo SMTP sink)"]
        demoats["apps/demo-ats\n(demo compose only)"]
        restricted["services/restricted-ingest\n(opt-in profile only)"]
        vol[/"file volume\nCVs, screenshots, bodies"/]
    end
    feeds["Job feeds\nRemotive, RemoteOK, Arbeitnow, WWR,\nTheMuse, GH/Lever/Ashby boards,\noptional BYO-key: Adzuna/Reed/USAJobs"]
    or["OpenRouter"]
    smtp["User SMTP/IMAP\n(personal mode, gated)"]
    sites["Company career sites\n(personal mode, gated)"]

    web <--> pg
    worker <--> pg
    web --> vol
    worker --> vol
    worker --> feeds
    web --> or
    worker --> or
    worker -->|"live gate"| smtp
    worker -->|"live gate"| sites
    worker -->|"sandbox"| mailpit
    worker -->|"sandbox"| demoats
    worker <-->|"consent gate"| restricted
    restricted -->|"proxy pool only"| boards["Restricted boards\nLinkedIn, Indeed, Glassdoor,\nGoogle Jobs, ZipRecruiter"]
```

- `apps/web` — UI, server actions, route handlers. Enqueues work; never performs external mutations itself except LLM calls for interactive generation.
- `apps/worker` — long-lived Node process consuming pg-boss queues: `ingest`, `rerank`, `imap-sync`, `classify`, `autoapply`, `demo-reset`. Runs Playwright (image based on `mcr.microsoft.com/playwright`).
- `apps/demo-ats` — small Hono/Express server with a fictional company careers page: one Greenhouse-style multi-step form and one Lever-style single-page form. Serves two purposes: Playwright e2e target in CI, and the only allowed auto-apply destination for the hosted demo.
- `services/restricted-ingest` — optional Python service wrapping JobSpy for restricted-board discovery (LinkedIn, Indeed, Glassdoor, Google Jobs, ZipRecruiter). Own container under a dedicated Compose profile, absent from the default stack and the demo. Narrow JSON contract (bounded search matrix in, normalized listings out); mandatory user-supplied proxy pool, per-board circuit breakers, bounded runs. The worker calls it only when the spec §5.3 consent gate is fully satisfied (profile deployed + env flag + recorded in-app consent). Discovery only — no credentials, no applying.
- Postgres is the single store for structured data; large artifacts live on the file volume with hashes in the DB. pg-boss uses the same Postgres — no Redis, keeping the default stack at four services.

## 2. Monorepo layout

pnpm workspaces + Turborepo. Import boundaries enforced by dependency-cruiser in CI.

```
careerHQ-app/
├── apps/
│   ├── web/                      # Next.js 15; src/app/(dashboard)/{jobs,applications,facts,email,settings}
│   ├── worker/                   # src/jobs/{ingest,rerank,imap-sync,classify,autoapply,demo-reset}.ts
│   └── demo-ats/
├── packages/
│   ├── contracts/                # Zod schemas + shared types; zero runtime deps
│   ├── core/                     # pure domain logic — no IO, no db imports
│   │   └── src/{state,scoring,gates,grounding,fingerprint}/
│   ├── db/                       # Drizzle schema, migrations, repositories, seed
│   ├── ai/                       # OpenRouter client, fallback, tasks, replay fixtures
│   ├── ingest/                   # fetchers + normalizer + dedupe
│   ├── email/                    # SMTP send (nodemailer), IMAP sync (imapflow), threading
│   ├── autoapply/                # canonical form schema, ATS adapters, Playwright driver
│   └── config/                   # zod-parsed env, safety-gate resolution, model tiers
├── infra/
│   ├── docker-compose.yml        # web, worker, postgres, mailpit
│   ├── docker-compose.demo.yml   # + demo-ats, sandbox env, reset schedule
│   └── Dockerfile.{web,worker}
├── services/
│   └── restricted-ingest/        # optional JobSpy connector; own profile, never in demo
├── docs/{adr,architecture.md,roadmap.md}
└── .github/workflows/ci.yml
```

**Dependency rules:** `contracts` ← everything. `core` depends only on `contracts`. `ai` / `email` / `autoapply` / `ingest` depend on `contracts` + `core`. Only `web` and `worker` compose everything (and are the only importers of `db` repositories alongside the feature packages' service layers). `core` receives plain objects — it never touches the database.

## 3. Data model

All domain tables carry `workspace_id`. Naming: snake_case tables, Drizzle schema in `packages/db/src/schema/`.

```mermaid
erDiagram
    workspaces ||--o{ jobs : ""
    workspaces ||--o{ candidate_facts : ""
    companies ||--o{ jobs : ""
    jobs ||--o{ applications : ""
    applications ||--o{ application_events : ""
    applications ||--o{ application_attempts : ""
    applications ||--o{ application_answers : ""
    applications ||--o{ generated_documents : ""
    application_attempts ||--o{ attempt_confirmations : ""
    application_attempts ||--o| form_snapshots : ""
    cv_variants ||--o{ applications : ""
    email_connections ||--o{ email_messages : ""
    credentials ||--o{ email_connections : ""
    applications ||--o{ email_messages : "matched"
```

Key tables (columns abbreviated; see spec §12 for entity semantics):

| Table | Notable columns / constraints |
|---|---|
| `workspaces` | `kind: personal\|sandbox` |
| `companies` | `name, domain, ats_hint` |
| `jobs` | `source, external_id, url, title, remote_mode, description_md, content_hash, first/last_seen_at, expired_at, keyword_score, keyword_breakdown jsonb, llm_score, llm_rationale, status inbox\|promoted\|dismissed`; **unique** `(workspace_id, source, external_id)` |
| `ingest_runs` | `source, started/finished_at, fetched, new, errors jsonb` |
| `applications` | `job_id, state, channel, cv_variant_id, next_action, next_action_due` |
| `application_events` | append-only: `from_state, to_state, trigger user\|attempt\|classification\|system, actor, payload jsonb` |
| `application_attempts` | `channel email\|company_site\|external, status, target_fingerprint, payload_fingerprint, pending_receipt jsonb, confirmed_receipt jsonb, failure_reason`; **partial unique** `(application_id) WHERE status='submitted'` |
| `attempt_confirmations` | `token_hash, payload_fingerprint, expires_at, consumed_at` |
| `candidate_facts` | `category, claim, detail, evidence_url, sensitivity, verified_at, review_by, archived_at` |
| `application_answers` | `question_norm, answer, origin deterministic\|ai\|user, source_fact_ids uuid[], confidence, sensitivity, approval, reusable, canonical_field` |
| `generated_documents` | `kind cover_letter\|email_body, content_md, source_fact_ids uuid[], model, approval` |
| `cv_variants` | `label, format designed\|ats, file_path, sha256` |
| `credentials` | `kind, ciphertext bytea` (libsodium secretbox, key from `CAREERHQ_MASTER_KEY`) |
| `email_connections` | `label, from_address, smtp jsonb, imap jsonb, credential_id, health` |
| `email_messages` | `direction, message_id, in_reply_to, references_ids[], subject, snippet, body_ref, application_id, match_method headers\|sender\|semantic\|manual, classification, classification_confidence, suggested_transition, suggestion_state` |
| `form_snapshots` | `attempt_id, ats_type greenhouse\|lever\|generic, parser_version, canonical_fields jsonb, form_fingerprint, current_step, recovery_state jsonb` |

### State machines (`packages/core/src/state/`)

Pure transition maps with guards; every transition appends an `application_events` row and the `state` column is a projection. Legal transitions per spec §6.2.

Attempt lifecycle:

```
DRAFT → READY → PENDING_CONFIRMATION → SUBMITTING → SUBMITTED
                                          ├→ FAILED           (error before mutation)
                                          ├→ BLOCKED          (gate/sandbox refusal)
                                          └→ NEEDS_RECONCILE  (uncertain after mutation; human-only resolution)
```

`SUBMITTING` + `pending_receipt` are written transactionally **before** the external mutation, so a crash mid-send leaves an attempt that is visibly unresolved rather than silently lost.

## 4. Gated submission — sequence

```mermaid
sequenceDiagram
    actor U as User
    participant W as web (server action)
    participant C as core/gates
    participant A as adapter (email | autoapply)
    participant X as External target

    U->>W: Request preview
    W->>C: build canonical payload
    C-->>W: payload_fingerprint = sha256(canonical JSON)
    W->>W: insert attempt_confirmations (hashed token, 10-min TTL)
    W-->>U: full preview + confirmation prompt

    U->>W: Confirm (token + retyped exact target)
    W->>C: verify: token unused/unexpired · target matches ·<br/>fingerprint recomputes identically · env gate on ·<br/>workspace not sandbox-blocked · no confirmed/in-flight attempt
    C-->>W: pass
    W->>W: tx: attempt → SUBMITTING + pending_receipt
    W->>A: execute (exactly one mutation)
    A->>X: send / final click
    X-->>A: evidence (Message-ID / confirmation page)
    A-->>W: confirmed_receipt (+ screenshot on volume)
    W->>W: attempt → SUBMITTED · application → SUBMITTED (trigger: attempt)
    Note over W,A: failure before mutation → FAILED (redacted reason)<br/>uncertainty after mutation → NEEDS_RECONCILE, never auto-retried
```

The three layers (env gates, sandbox adapter block, confirmation binding) are independent; disabling one never weakens the others. The UI only displays gate state.

## 5. AI layer (`packages/ai`)

```
packages/ai/src/
├── client/
│   ├── chat-json.ts      # OpenAI-compatible JSON-mode call: tolerant extraction,
│   │                     #   Zod validation, isUseful predicate, never-throws result
│   ├── fallback.ts       # sequential ordered-model fallback; backoff on 429/5xx;
│   │                     #   per-model cooldown after rate limit
│   └── stream.ts         # SSE streaming for long-form generation
├── tasks/                # one module per task: prompt builder + Zod schema + isUseful + tier
│   ├── rerank.ts
│   ├── generate.ts
│   ├── classify-reply.ts
│   └── interpret-field.ts
├── replay/               # record/replay: (task, promptHash) → fixture; CI + demo mode
└── fixtures/
```

Design notes:

- `chat-json.ts` ports the proven pattern from kelevoTMS (`apps/backend/src/features/ai/llm/chat-json.service.ts`): JSON mode + `temperature: 0`, tolerant extraction for cheap models that wrap JSON in prose, schema validation, `isUseful` so a valid-but-empty result counts as failure, and a discriminated result object instead of exceptions.
- Deliberately **not** ported: kelevoTMS's parallel two-lane race router. Racing burns ~2× tokens to cut latency — the wrong trade against rate-limited free tiers. Sequential fallback with cooldown is the correct policy here (ADR-0003).
- Model tiers are configuration data (env/db), not code — free-model availability churns monthly. Two tiers: `fast` (rerank, classify, interpret, sensitivity tie-break) and `writing` (cover letters, narrative answers; optionally a cheap paid model as the last fallback entry).
- Grounding post-validation lives in `packages/core/src/grounding/`, not in `ai` — deterministic code decides whether a generation is acceptable (spec §7.2).

## 6. Workspaces, demo mode, and safety wiring

- Session middleware resolves the active workspace; the demo deployment pins it to the sandbox workspace and disables login.
- `docker-compose.demo.yml` sets `SANDBOX_FORCE_SAFE=true`, points SMTP at Mailpit, sets the auto-apply origin allowlist to the `demo-ats` service, runs `ai` in replay mode, and schedules `demo-reset` (truncate sandbox workspace + reseed) every 6 hours.
- The sandbox block is the last check inside `packages/email/src/send.ts` and `packages/autoapply/src/submit.ts` — a UI or route-handler bug cannot bypass it.
- Demo mutations are rate-limited; credential setup is disabled for sandbox workspaces.

## 7. Security

- Credentials: libsodium secretbox with `CAREERHQ_MASTER_KEY` (env). Ciphertext-only in Postgres; plaintext never serialized to the client, logged, or included in errors. Threat model and the "why not an OS keyring" rationale: ADR-0005.
- Redaction middleware on logs and error responses (secrets, auth headers, message bodies).
- All mutations are POST server actions (same-origin); confirm endpoint rate-limited; tokens stored hashed.
- Personal deployments sit behind an owner login and reverse-proxy TLS; the demo exposes only the sandbox workspace.

## 8. Testing and CI

| Layer | Tooling | Focus |
|---|---|---|
| Unit | Vitest | transition/guard tables, scoring breakdown, fingerprint tamper detection, gate matrix (sandbox × env × token × duplicate), JSON extraction + fallback (mocked 429 sequences), grounding validation, form normalization from saved ATS HTML, threading |
| Integration | Vitest + testcontainers | Drizzle repositories, Mailpit SMTP |
| E2E | Playwright | tracker flow; gated email send verified in Mailpit; full auto-apply vs `demo-ats`; negative: edited payload → fingerprint mismatch → blocked |
| CI | GitHub Actions | PR: lint, typecheck, dependency-cruiser, unit + integration, migration drift. main: + e2e (compose), image builds |

## 9. ADR index (planned)

| ADR | Decision |
|---|---|
| 0001 | Postgres + pg-boss over SQLite/Redis |
| 0002 | Gated-mutation protocol (web translation of the receipt/fingerprint design) |
| 0003 | OpenRouter sequential fallback; why not a parallel race router |
| 0004 | Grounding contract and sensitive-answer policy |
| 0005 | App-level credential encryption vs OS keyring |
| 0006 | Scraping/ToS boundaries; restricted-source connector isolation and consent lane |
| 0007 | Canonical form schema — selectors are not the data model |
