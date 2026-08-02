# ADR-0002: Gated-mutation protocol

**Status:** Accepted — designed in P1, enforced from P4
**Date:** 2026-08-02
**Phase:** Designed P1 (state machine + DB constraint); layers 1–3 fully wired P4

## Context

Career HQ eventually performs real, irreversible external mutations on the user's behalf: sending an email through their own SMTP account, and submitting a job application through a company's careers site via a Playwright driver. A bug, a race condition, or a bad retry in either path does not just corrupt internal state — it sends a real email or submits a real application, an action that cannot be un-sent or un-submitted. The cost of a false positive (a mutation firing when it shouldn't) is far higher than the cost of a false negative (a mutation being blocked when it was actually fine), so the design has to bias hard toward blocking.

Spec §11 (normative) requires this to hold under concurrent requests, retried requests, and process crashes mid-send — not just "the happy path checks first." It also requires that no single layer of protection be a single point of failure: a bug in the UI, a bug in one gate check, or a disabled feature flag must not be enough, on its own, to let a mutation through.

P1 does not yet ship any live channel (no live email, no live auto-apply) — those land in P4 and P5. But the *shape* of the protocol has to be decided now, because the application and attempt state machines (`packages/core/src/state/`) are built in P1 and every later phase builds directly on top of them. Retrofitting a safety protocol onto state machines designed without it is exactly the kind of rework this project is trying to avoid.

## Decision

Adopt a three-independent-layer gated-mutation protocol (spec §11), designed and partially shipped now, fully enforced starting P4:

1. **Layer 1 — server safety config.** `SUBMISSIONS_LIVE_EMAIL` and `SUBMISSIONS_LIVE_COMPANY_SITE` env flags, read at boot, **default off**. Already shipped in P1 via `packages/config`'s zod-validated env — the flags exist and default closed before any code exists that could use them to submit anything.
2. **Layer 2 — sandbox hard block.** The last check inside the adapter itself (not the route handler, not the UI): a sandbox workspace may only ever target the built-in safe destinations (Mailpit, `demo-ats`). Lands with the real adapters in P4/P5, but the workspace-kind data model it depends on already exists.
3. **Layer 3 — per-application confirmation.** Preview builds a canonical payload, computes `payload_fingerprint = sha256(canonical JSON)`, and issues a single-use, hashed, 10-minute-TTL confirmation token. Confirming requires the user to retype the exact target; the server re-verifies the token, the retyped target, and that the fingerprint still recomputes identically (any edit after preview invalidates the confirmation). Only after all of that does the attempt move to `SUBMITTING` with a `pending_receipt` written **transactionally before** the external call — so a crash mid-send leaves a visibly unresolved attempt (`NEEDS_RECONCILE`) instead of one that silently vanishes or silently duplicates.

What already ships in P1, independent of any live channel:

- `ATTEMPT_STATUSES` in `packages/contracts` (`DRAFT → READY → PENDING_CONFIRMATION → SUBMITTING → SUBMITTED`, with `FAILED` / `BLOCKED` / `NEEDS_RECONCILE` as the non-happy-path terminal/recoverable states).
- `canAttemptTransition` in `packages/core/src/state/attempt.ts` — the guarded edge map enforcing that only `SUBMITTING` can reach `SUBMITTED`, that `NEEDS_RECONCILE` can only resolve to `SUBMITTED` or `FAILED` by a human action (never auto-retried back into `SUBMITTING`), and that no path skips `PENDING_CONFIRMATION`.
- The `attempts_one_submitted_per_application` partial unique index (`packages/db/migrations/0000_naive_sheva_callister.sql`) — a database-level backstop for spec §11's "at most one confirmed attempt per application," independent of whether the confirmation-flow application code above it is bug-free.

## Consequences

- **Positive:** because the state machine and the constraint exist from P1, no later phase can ship submission code that skips the rails — there is no `SUBMITTED` state reachable except through `SUBMITTING`, and the DB physically rejects a second submitted attempt regardless of what the calling code does. The unsafe shortcut simply isn't representable.
- **Positive:** the three layers are independently disable-able in principle (env flag, sandbox check, confirmation flow) but each is checked separately at the point of mutation, so disabling or misconfiguring one never silently weakens another — a reviewer can audit each layer in isolation.
- **Trade-off, accepted:** until P4, the UI can only ever reach `DRAFT`/`READY`/manual `SUBMITTED` (via "log external application," which never touches the attempt machine's `SUBMITTING` path) — real gated submission is unobservable in the product until P4, even though its rails are already load-bearing.
- **Risk to watch:** P4 must implement layers 1–3 exactly against this already-shipped state machine and constraint, not a reinterpretation of them; any drift between the P1 design and the P4 implementation reopens the exact gap this ADR exists to close.
