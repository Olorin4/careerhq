import { chatJson, type ChatJsonRequest, type ChatJsonResult } from "./chat-json.js";

export interface FallbackAttempt {
  model: string;
  error: string | null;
  status: number | null;
  skippedCooldown?: boolean;
}

export interface FallbackOptions {
  models: string[];
  apiKey: string;
  url?: string;
  timeoutMs?: number;
  /** Cooldown applied to a model after it returns http_429. Default 5 minutes. */
  cooldownMs?: number;
  /** Backoff before trying model i>0 after a retryable failure: base * 2^i + jitter(0..100). Default 300. */
  backoffBaseMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Clock injection for cooldown tests. Default Date.now. */
  now?: () => number;
}

export type FallbackResult<T> = ChatJsonResult<T> & { attempts: FallbackAttempt[] };

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Module-level cooldown map keyed by model name, storing the timestamp it cools down until. */
const cooldownUntil = new Map<string, number>();

/** Test hook: resets all module-level cooldown state. */
export function clearCooldowns(): void {
  cooldownUntil.clear();
}

function isCooling(model: string, nowMs: number): boolean {
  const until = cooldownUntil.get(model);
  return until !== undefined && nowMs < until;
}

/**
 * Tries `models` in order via `chatJson`, skipping any model still cooling
 * down from a prior 429. Returns on the first ok result; a 429 puts that
 * model into cooldown and moves on; other failures (5xx, timeout, no_json,
 * schema_invalid, not_useful) move on without a cooldown. An empty `models`
 * list returns `{ ok: false, error: "no_models_configured" }`; if every model
 * is cooling down, returns `{ ok: false, error: "all_models_cooling_down" }`
 * with attempts recording the skips. If the list is exhausted without an ok
 * result, returns the last attempted result with the full attempts array.
 */
export async function chatJsonWithFallback<T>(
  req: Omit<ChatJsonRequest<T>, "model" | "apiKey" | "url" | "timeoutMs" | "fetchImpl">,
  opts: FallbackOptions,
): Promise<FallbackResult<T>> {
  const {
    models,
    apiKey,
    url,
    timeoutMs,
    cooldownMs = 5 * 60_000,
    backoffBaseMs = 300,
    fetchImpl,
    sleep = defaultSleep,
    now = Date.now,
  } = opts;

  const attempts: FallbackAttempt[] = [];

  if (models.length === 0) {
    // Distinct from all_models_cooling_down: nothing was ever configured to
    // try, so there is no 429 to wait out.
    return {
      ok: false, value: null, model: "", latencyMs: 0, status: null,
      error: "no_models_configured", attempts,
    };
  }

  let lastResult: ChatJsonResult<T> | null = null;
  let triedAny = false;

  for (const [i, model] of models.entries()) {
    const nowMs = now();

    if (isCooling(model, nowMs)) {
      attempts.push({ model, error: "cooldown", status: null, skippedCooldown: true });
      continue;
    }

    if (triedAny) {
      const jitter = Math.random() * 100;
      await sleep(backoffBaseMs * 2 ** i + jitter);
    }
    triedAny = true;

    const result = await chatJson<T>({ ...req, model, apiKey, url, timeoutMs, fetchImpl });
    lastResult = result;
    attempts.push({ model, error: result.error, status: result.status });

    if (result.ok) {
      return { ...result, attempts };
    }

    if (result.error === "http_429") {
      cooldownUntil.set(model, nowMs + cooldownMs);
    }
    // http_5xx / timeout / schema_invalid / not_useful / no_json: continue without cooldown.
  }

  if (!lastResult) {
    // Every model was skipped for cooldown; none was ever tried.
    return {
      ok: false,
      value: null,
      model: models[models.length - 1] ?? "",
      latencyMs: 0,
      status: null,
      error: "all_models_cooling_down",
      attempts,
    };
  }

  return { ...lastResult, attempts };
}
