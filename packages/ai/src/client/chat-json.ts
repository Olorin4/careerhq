import type { z } from "zod";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface ChatJsonRequest<T> {
  system: string;
  user: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  model: string;
  apiKey: string;
  url?: string;
  timeoutMs?: number;
  isUseful?: (value: T) => boolean;
  fetchImpl?: typeof fetch;
}

export interface ChatJsonResult<T> {
  ok: boolean;
  value: T | null;
  model: string;
  latencyMs: number;
  status: number | null;
  error: string | null;
}

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: unknown } | null } | null> | null;
};

/**
 * Tolerant extraction of a JSON object from LLM output. Handles a raw object,
 * a JSON string, or prose/fenced text wrapping a JSON object. Returns null if
 * no valid JSON object can be recovered.
 */
export function extractJsonObject(text: string): unknown | null {
  const withoutFences = text.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
  const firstBrace = withoutFences.indexOf("{");
  const lastBrace = withoutFences.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) return null;
  const candidate = withoutFences.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

function extractContentValue(content: unknown): unknown | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "object") return content;
  if (typeof content !== "string") return null;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return extractJsonObject(content);
  }
}

export interface ContentValidationResult<T> {
  ok: boolean;
  value: T | null;
  error: "no_json" | "schema_invalid" | "not_useful" | null;
}

/**
 * Schema-validates an already-extracted JSON value and applies the optional
 * usefulness check. Shared by `chatJson` (which extracts from a raw message
 * `content` field that may already be an object) and `validateContent` below.
 */
export function validateJson<T>(
  json: unknown,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  isUseful?: (value: T) => boolean,
): ContentValidationResult<T> {
  if (json === null || json === undefined) {
    return { ok: false, value: null, error: "no_json" };
  }

  const validated = schema.safeParse(json);
  if (!validated.success) {
    return { ok: false, value: null, error: "schema_invalid" };
  }

  const value = validated.data;
  const usable = isUseful ? isUseful(value) : true;
  return { ok: usable, value, error: usable ? null : "not_useful" };
}

/**
 * Shared final-validation pipeline used by both the non-streaming
 * (`chatJson`) and streaming (`streamChatJson`) clients: tolerant JSON
 * extraction from raw LLM text, then `validateJson`. Kept here so both
 * callers share one error taxonomy.
 */
export function validateContent<T>(
  text: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  isUseful?: (value: T) => boolean,
): ContentValidationResult<T> {
  return validateJson(extractJsonObject(text), schema, isUseful);
}

/**
 * One round-trip to the OpenRouter (OpenAI-compatible) chat completions
 * endpoint in JSON mode. Never throws — every failure path (timeout, HTTP
 * error, missing/invalid JSON, schema mismatch, or a useless-but-valid
 * result) is reported via the returned result object's `error` field.
 */
export async function chatJson<T>(req: ChatJsonRequest<T>): Promise<ChatJsonResult<T>> {
  const {
    system,
    user,
    schema,
    model,
    apiKey,
    url = OPENROUTER_URL,
    timeoutMs = 30_000,
    isUseful,
    fetchImpl = fetch,
  } = req;

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/careerhq",
      "X-Title": "CareerHQ",
    };

    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return {
        ok: false,
        value: null,
        model,
        latencyMs,
        status: response.status,
        error: `http_${response.status}`,
      };
    }

    let payload: ChatCompletionResponse;
    try {
      payload = (await response.json()) as ChatCompletionResponse;
    } catch {
      return {
        ok: false,
        value: null,
        model,
        latencyMs,
        status: response.status,
        error: "no_json",
      };
    }

    const rawContent = payload?.choices?.[0]?.message?.content;
    const json = extractContentValue(rawContent);
    const validation = validateJson(json, schema, isUseful);
    return {
      ok: validation.ok,
      value: validation.value,
      model,
      latencyMs,
      status: response.status,
      error: validation.error,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const err = error as { name?: string; message?: string };
    const aborted = err?.name === "AbortError";
    return {
      ok: false,
      value: null,
      model,
      latencyMs,
      status: null,
      error: aborted ? "timeout" : err?.message || "unknown_error",
    };
  } finally {
    clearTimeout(timer);
  }
}
