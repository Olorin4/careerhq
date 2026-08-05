import { OPENROUTER_APP_REFERER, OPENROUTER_APP_TITLE } from "./app-identity.js";
import { OPENROUTER_URL, validateContent, type ChatJsonRequest, type ChatJsonResult } from "./chat-json.js";

export interface StreamCallbacks {
  onAnswerDelta: (answerSoFar: string) => void;
}

type Mode = "seekKey" | "inKeyString" | "afterKey" | "seekValueQuote" | "inValue" | "done";

/**
 * Best-effort scan of a (possibly incomplete) JSON string for the top-level
 * `"answer"` key, decoding the string-value prefix accumulated so far.
 *
 * This is a small state machine that tracks whether we're inside a string
 * and whether the next character is escaped, so that an `"answer"`-looking
 * substring nested inside another string's contents (e.g.
 * `"note": "the \"answer\" is"`) is not mistaken for the real key. Only a
 * key seen while NOT inside any string counts.
 *
 * Returns "" before the answer value has started opening, the decoded
 * prefix while streaming, and the full decoded value once the closing
 * unescaped quote has been seen (any trailing text is ignored).
 */
export function extractAnswerPrefix(partialJson: string): string {
  let mode: Mode = "seekKey";
  let i = 0;
  let value = "";

  // Tracks whether we are inside *some* string literal (any key or value,
  // not just "answer") so we can skip over its contents while seeking the
  // "answer" key, without being fooled by braces/colons/quotes inside it.
  let inOtherString = false;
  let otherEscaped = false;

  // Buffer of the current candidate key's raw characters, used only while
  // mode === "inKeyString" to check whether it matches `answer`.
  let keyBuffer = "";
  const KEY = "answer";

  while (i < partialJson.length) {
    const ch = partialJson[i];

    if (mode === "seekKey") {
      if (inOtherString) {
        if (otherEscaped) {
          otherEscaped = false;
        } else if (ch === "\\") {
          otherEscaped = true;
        } else if (ch === '"') {
          inOtherString = false;
        }
        i++;
        continue;
      }
      if (ch === '"') {
        inOtherString = true;
        keyBuffer = "";
        mode = "inKeyString";
        i++;
        continue;
      }
      i++;
      continue;
    }

    if (mode === "inKeyString") {
      if (otherEscaped) {
        otherEscaped = false;
        keyBuffer += ch;
        i++;
        continue;
      }
      if (ch === "\\") {
        otherEscaped = true;
        keyBuffer += ch;
        i++;
        continue;
      }
      if (ch === '"') {
        inOtherString = false;
        mode = keyBuffer === KEY ? "afterKey" : "seekKey";
        i++;
        continue;
      }
      keyBuffer += ch;
      i++;
      continue;
    }

    if (mode === "afterKey") {
      // Skip whitespace and the colon before the value starts.
      if (ch === ":" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        i++;
        continue;
      }
      if (ch === '"') {
        mode = "inValue";
        i++;
        continue;
      }
      // Anything else here means this wasn't actually the key we wanted
      // (malformed / not-yet-a-string value); bail out with what we have.
      mode = "done";
      continue;
    }

    if (mode === "inValue") {
      if (ch === "\\") {
        // Escape sequence: need a following character to decode it. If this
        // is the last character in the buffer (chunk boundary mid-escape),
        // stop here without consuming the dangling backslash.
        const next = partialJson[i + 1];
        if (next === undefined) {
          mode = "done";
          continue;
        }
        switch (next) {
          case "n":
            value += "\n";
            break;
          case "t":
            value += "\t";
            break;
          case "r":
            value += "\r";
            break;
          case '"':
            value += '"';
            break;
          case "\\":
            value += "\\";
            break;
          case "/":
            value += "/";
            break;
          default:
            value += next;
            break;
        }
        i += 2;
        continue;
      }
      if (ch === '"') {
        mode = "done";
        i++;
        continue;
      }
      value += ch;
      i++;
      continue;
    }

    // mode === "done"
    break;
  }

  return value;
}

interface StreamChoiceDelta {
  choices?: Array<{ delta?: { content?: unknown } | null } | null> | null;
}

/**
 * Streaming variant of `chatJson`: POSTs with `stream: true`, parses the
 * SSE `data:` lines as they arrive, accumulates `choices[0].delta.content`,
 * and reports growing `"answer"` prefixes via `cb.onAnswerDelta` as UX
 * sugar. Once the stream ends, the FULL accumulated text is validated with
 * the exact same taxonomy as `chatJson` (extractJsonObject → schema →
 * isUseful) — streaming never changes correctness, only perceived latency.
 * Never throws: network errors, non-2xx responses, and malformed SSE lines
 * are all folded into the returned result's `error` field.
 */
export async function streamChatJson<T>(
  req: ChatJsonRequest<T>,
  cb: StreamCallbacks,
): Promise<ChatJsonResult<T>> {
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
      stream: true,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": OPENROUTER_APP_REFERER,
      "X-Title": OPENROUTER_APP_TITLE,
    };

    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        value: null,
        model,
        latencyMs: Date.now() - startedAt,
        status: response.status,
        error: `http_${response.status}`,
      };
    }

    let accumulated = "";
    let lastPrefix = "";

    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        // Keep the last (possibly incomplete) line in the buffer for the
        // next chunk.
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith("data: ") && !line.startsWith("data:")) continue;
          const payloadText = line.startsWith("data: ") ? line.slice(6) : line.slice(5).trim();
          if (payloadText === "[DONE]") continue;

          try {
            const parsed = JSON.parse(payloadText) as StreamChoiceDelta;
            const delta = parsed?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length > 0) {
              accumulated += delta;
              const prefix = extractAnswerPrefix(accumulated);
              if (prefix.length > lastPrefix.length) {
                lastPrefix = prefix;
                cb.onAnswerDelta(prefix);
              }
            }
          } catch {
            // Malformed SSE payload — skip this line, never throw.
          }
        }
      }
    }

    const latencyMs = Date.now() - startedAt;
    const validation = validateContent(accumulated, schema, isUseful);
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
