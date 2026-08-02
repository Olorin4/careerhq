# ADR-0001: Postgres + pg-boss over SQLite/Redis

**Status:** Accepted
**Date:** 2026-08-02
**Phase:** P1

## Context

Career HQ needs a single store for structured domain data (workspaces, jobs, applications, attempts, facts, credentials) plus a background job system for ingestion polling, IMAP sync, AI generation, and — later — Playwright-driven auto-apply. Two independent writers exist from the start: `apps/web` (server actions, request-scoped) and `apps/worker` (a long-lived pg-boss consumer process), and both need to read and write the same application/attempt rows without corrupting each other's work.

The domain model also carries non-trivial semi-structured data that does not fit a rigid column set: per-source keyword-score breakdowns, gate/receipt payloads on application attempts, canonical form snapshots for ATS adapters, and ingest-run error summaries. And the gated-submission protocol (spec §11, see ADR-0002) requires an atomic, durable guarantee: at most one *confirmed* submission attempt per application, enforced even under concurrent or retried requests — not just "the application code checked before writing."

The realistic deployment target is a single-owner, self-hosted instance (a VPS or a laptop via Docker Compose), so operational simplicity matters as much as correctness. Every additional service in the default stack is something the owner has to run, back up, and reason about.

## Decision

Use **Postgres** as the single datastore for all structured data, with `jsonb` columns for the semi-structured payloads (score breakdowns, pending/confirmed receipts, form snapshots, ingest-run summaries) rather than a second schemaless store. Use **pg-boss** for the job queue, running on the *same* Postgres instance rather than standing up Redis (or another broker) alongside it.

Concretely:

- SQLite is ruled out because it serializes writers at the file level; two concurrent processes (`web` and `worker`) doing read-modify-write cycles on the same application/attempt rows is the normal case here, not an edge case, and SQLite's write-lock model fights that directly.
- The at-most-one-submitted-attempt invariant from spec §11 is enforced as a **database constraint** — a partial unique index (`attempts_one_submitted_per_application`, on `application_attempts (application_id) WHERE status = 'SUBMITTED'`) — not just application-level checks, because the failure mode (a duplicate real-world submission) is unacceptable and must hold even if the confirmation-flow code above it has a bug. This needs a real relational engine with expression/partial index support.
- pg-boss turns the job queue into "another table in the same Postgres," so `docker compose up` stays at four services (`web`, `worker`, `postgres`, `mailpit`) instead of five. Jobs and their target rows can also be updated in the same transaction where useful, sidestepping a class of dual-write consistency bugs that a separate Redis-backed queue would introduce.

## Consequences

- **Positive:** one backup target (`pg_dump` + the file volume) for the entire system; one connection story; transactional consistency between domain writes and job state; the duplicate-submission backstop is enforceable at the schema level, independent of application code correctness.
- **Positive:** simpler default Compose stack — no Redis to provision, secure, or explain in the README.
- **Trade-off, accepted:** heavier than SQLite for the pure-local, no-server use case (a single laptop process). This project is explicitly a self-hosted *service*, not a single-file desktop app, so that trade-off is the right one here.
- **Trade-off, accepted:** pg-boss is less feature-rich and less battle-tested at scale than Redis-backed queues (e.g. BullMQ). At single-owner job volumes (ingestion polling, occasional AI calls, occasional auto-apply runs) this is not a binding constraint; it would need revisiting if Career HQ were ever multi-tenant.
- Migrations, jobs, and application data now share one point of contention (the Postgres instance); acceptable for this workload, but worth remembering if job throughput ever grows enough to threaten transactional query latency.
