# ADR-0006: Keyless-only core discovery; scraping isolated to an opt-in connector

**Status:** Accepted
**Date:** 2026-08-02
**Phase:** P2 (core boundary); P7 (isolated connector, not yet built)

## Context

Job discovery (spec §5) is the feature most tempted to reach for scraping: the highest-traffic job boards — LinkedIn, Indeed, Glassdoor, Google Jobs, ZipRecruiter — have no public, keyless API, and a predecessor project's ingestion scripts (`career/scripts/discover/`) covered them by scraping. Reusing that approach directly in Career HQ's core pipeline would be the path of least resistance to a richer inbox.

It is also the wrong call for this project, for reasons the spec treats as normative rather than incidental (§19, out of scope): scraping sites that prohibit it risks IP and account blocks, and is a ToS violation that a self-hosted, source-available portfolio project should not embed in its default, always-on ingestion path — not "later," permanently. A reviewer cloning this repo and running `docker compose up` must never be one config flag away from unknowingly scraping a site on their own IP.

At the same time, spec §5.3 does not forbid these boards outright — it carves out a narrow, deliberately isolated, opt-in path for them, because excluding real value entirely would be its own kind of loss for a discovery feature. The question this ADR answers is not "scrape or don't," but **where the boundary sits** and what has to be true on both sides of it.

## Decision

Core discovery ingestion (`packages/ingest`, everything scheduled by `apps/worker`'s `discovery.ingest` queue, on by default in every deployment including the hosted demo) uses **only keyless public APIs/feeds and public ATS board endpoints** — nothing that requires scraping a site that prohibits it, and nothing gated behind a login or a paid credential (spec §5.1):

- Remotive, RemoteOK, Arbeitnow, We Work Remotely, The Muse — public APIs/feeds, no key.
- Public ATS board endpoints for companies on the user's own watchlist — Greenhouse (`boards-api.greenhouse.io`), Lever (`api.lever.co/v0/postings`), Ashby (`api.ashbyhq.com/posting-api/job-board`) — `packages/ingest/src/fetchers/ats-boards.ts`'s `makeAtsBoardsFetcher`. These are published, intentionally public JSON endpoints (the companies chose to expose them for their own careers pages), not scraped HTML.
- Every fetcher sends an honest, identifying User-Agent (`INGEST_USER_AGENT` in `packages/ingest/src/net.ts`) and a bounded timeout (`packages/ingest/src/net.ts`'s `request`) — polite-client behavior, not evasion.
- Hacker News "Who is hiring" and bring-your-own-key sources (Adzuna, Reed.co.uk, USAJobs) are in the spec (§5.1) as stretch/optional — deferred past P2, but when they land they follow the same rule: keyless-first, and a BYO-key source runs only when the user supplies their own key, never by default.

**LinkedIn, Indeed, Glassdoor, Google Jobs, and ZipRecruiter exist only in the isolated, opt-in restricted connector described in spec §5.3 (`services/restricted-ingest`, phase P7) — never in `packages/ingest`, never in the default Compose stack, and never in the hosted demo.** That connector's isolation is itself a set of decisions this ADR treats as load-bearing, not incidental:

- **Separate service, separate container, separate Compose profile.** It talks to the worker only over the internal network through a narrow JSON contract (bounded search matrix in, normalized listings out); no credentials pass through it.
- **Explicit three-part consent gate**, all required: the operator deployed the `restricted` profile; `RESTRICTED_SOURCES_ENABLED=true` is set; the user completed an in-app consent flow (risk disclosure, typed acknowledgment phrase, timestamped/versioned, revocable). The UI hides restricted sources entirely until consent exists — there is no way to stumble into it.
- **Mandatory proxy pool** — the connector refuses to run from the host IP — plus per-board circuit breakers and bounded runs (max searches, per-run timeout, result caps).
- **Sandbox workspaces can never enable, configure, or reach it**, at all — the hosted/sandbox demo (P6) is architecturally incapable of running it, not merely configured not to.
- Restricted-board **application** automation (Easy Apply, Indeed Apply, etc.), CAPTCHA/anti-bot circumvention, and unattended account automation are permanently out of scope (spec §19) regardless of connector consent — consent covers discovery only; applying still routes the user out to the board manually.

## Consequences

- **Positive:** the default product — everything a reviewer sees running `docker compose up`, and everything in the hosted demo — never touches a site that prohibits scraping. There is no core-path code that could regress into doing so; the restricted connector isn't merely disabled by default, it doesn't exist in the default dependency graph at all.
- **Positive:** the highest-value, highest-risk sources aren't lost — they're available to a user who explicitly opts in, understands the risk (ToS violation, IP/account blocking, sole responsibility — disclosed and acknowledged, not buried), and accepts it for themselves, isolated enough that its risk cannot leak into the portfolio-facing product.
- **Trade-off, accepted:** the P2 core inbox is smaller than it could be — no LinkedIn/Indeed volume — in exchange for the core product being unconditionally safe to demo and unconditionally safe to clone and run. For a portfolio project, that trade favors the side that keeps the repo demo-safe.
- **Risk to watch:** P7 must implement every safeguard above exactly as specified — a proxy pool that isn't actually mandatory, a consent flow that can be bypassed, or a sandbox path that can reach the connector would reopen the exact hazard this ADR isolates. Any change to the connector's isolation design updates this ADR, not a reinterpretation of it (see `docs/roadmap.md`'s P7 entry: "ADR-0006 updated with the isolation/consent design").
- **Scoring is uniform regardless of source** (spec §5.4): when the restricted connector eventually ships, its listings get the same dedup and keyword/LLM scoring as every keyless source — provenance is a label in the UI, not a different code path.
