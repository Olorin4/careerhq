# ADR-0003: OpenRouter, a ported chat-json pattern, and sequential (not raced) model fallback

**Status:** Accepted
**Date:** 2026-08-02
**Phase:** P2

## Context

Career HQ's AI layer (spec §8) needs one thing above all else: it must never become a hard dependency. The product's cost posture is free-tier-first (a self-hosted, single-owner app has no budget for per-call spend), and every task that touches the model — `rerank` in P2, later `generate`, `classifyReply`, `interpretField` — has to degrade to a deterministic fallback rather than block the pipeline when the model is unavailable, rate-limited, or simply not configured (spec §1.4's deterministic floor).

Free-tier LLM offerings on any single provider churn constantly — a model that's free and fast this month may be gone or throttled next month — so betting on one model, or even one provider's naming scheme, is a maintenance trap. **OpenRouter** was chosen as the one integration point specifically because it fronts many providers' models (including several free tiers) behind a single OpenAI-compatible endpoint: one client, one auth scheme, and a model-selection problem that can be solved with configuration instead of code changes.

Two problems remain even with OpenRouter picked: (1) cheap/free models are inconsistent about following JSON-mode instructions — some wrap valid JSON in markdown fences or a sentence of prose, some occasionally return a schema-shaped-but-empty response — so a client that trusts the raw response is not safe to build on; and (2) any single free model can rate-limit at any moment, so a task that only ever tries one model has no real fallback story at all.

Both problems already have a proven solution: `chat-json.service.ts` in a predecessor project, kelevoTMS (`apps/backend/src/features/ai/llm/chat-json.service.ts`). That service's core request/response contract — JSON mode with `temperature: 0`, tolerant extraction of a JSON object from a possibly-prose-wrapped response, Zod schema validation, an `isUseful` predicate so a valid-but-empty result still counts as a failure, and a discriminated result object instead of thrown exceptions — solves problem (1) directly and was carried over rather than re-invented. Credit: this project's `chatJson` (`packages/ai/src/client/chat-json.ts`) ports that pattern.

kelevoTMS's answer to problem (2), however, was a **parallel two-lane race router**: fire the same prompt at two models concurrently and take whichever responds first (with the second in-flight call typically still billed or still consuming rate-limit budget). That was the right call there — it was optimizing for interactive latency against paid, high-throughput endpoints where token cost was a rounding error next to user-perceived speed.

## Decision

Port `chatJson`'s request/response contract from kelevoTMS as-is (`packages/ai/src/client/chat-json.ts`); **do not** port its parallel race router. Use **sequential model fallback** instead (`packages/ai/src/client/fallback.ts`, `chatJsonWithFallback`): try an ordered list of models one at a time, backing off exponentially between attempts, and only move to the next model on a genuine failure (HTTP error, timeout, invalid/unusable JSON) — not on latency.

Reasoning for the trade-off:

- Racing two models roughly **doubles token/request consumption for every call**, whether or not the loser's response would have been useful. Against Career HQ's free-tier-first posture, that is the wrong trade: free tiers are rate-limited by request count or token budget, not by latency SLA, so racing burns through that budget twice as fast for a latency win nobody is paying to protect (background ingestion re-rank and reply classification are not interactive, sub-second paths).
- A model that returns `http_429` is put into a per-model **cooldown** (default 5 minutes, `cooldownUntil` map in `fallback.ts`) so the same rate-limited model isn't retried on the very next job in the same run — subsequent calls skip straight past it to the next model in the list until the cooldown expires.
- Other failure modes (5xx, timeout, `no_json`, `schema_invalid`, `not_useful`) move to the next model **without** a cooldown, since those aren't necessarily rate-limit signals and the model may well succeed on the next distinct prompt.
- If every model in the list is cooling down, or the list is exhausted without a usable result, the caller gets a structured failure (`all_models_cooling_down`, or the last attempt's error) with a full `attempts[]` trail — never a thrown exception — and the deterministic floor stands: keyword order is used, `rerank` reports `skipped_no_key`/`failed` rather than blocking the inbox.
- Model lists (`AI_FAST_MODELS`, and later a `writing` tier) are **env configuration, not code**, precisely because free-model availability on OpenRouter churns — swapping a retired free model for a new one is a redeploy of config, not a code change or a release.

## Consequences

- **Positive:** every AI call site gets the same never-throws, tolerant contract for free, without re-deriving it — the `chatJson` request/response shape, the tolerant JSON extraction, and the `isUseful` gate are inherited wholesale from a pattern already proven in production.
- **Positive:** sequential fallback with per-model cooldown roughly halves token spend versus racing, at the cost of higher tail latency on the (rare) case where the first model is genuinely down — an acceptable trade for background jobs, and one that matters for a project explicitly betting on free tiers.
- **Trade-off, accepted:** sequential fallback is slower than racing when the primary model is healthy but slow — there is no mechanism here to bound worst-case latency the way a race does. Not a binding constraint for `rerank` (a scheduled worker job, not a user-blocking request); would need revisiting if a future interactive/streaming task (`generate`) needed a hard latency ceiling.
- **Risk to watch:** the cooldown map is module-level, in-process state (`packages/ai/src/client/fallback.ts`) — it resets on worker restart and is not shared across multiple worker instances. Fine for the single-worker-process deployment target; would need externalizing (e.g. into Postgres, alongside everything else per ADR-0001) if the worker were ever horizontally scaled.
- **Follow-on:** the same `chatJsonWithFallback` machinery is reused unchanged by every later AI task (`generate`, `classifyReply`, `interpretField`) — this ADR's decision is made once, for the client layer, not re-litigated per task.
