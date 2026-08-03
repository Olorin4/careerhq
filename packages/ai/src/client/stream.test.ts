import { describe, expect, it } from "vitest";
import { generationResultSchema } from "@careerhq/contracts";
import { extractAnswerPrefix, streamChatJson } from "./stream.js";

describe("extractAnswerPrefix", () => {
  it("returns empty before the answer value opens", () => {
    expect(extractAnswerPrefix('{"ans')).toBe("");
    expect(extractAnswerPrefix('{"answer": ')).toBe("");
  });

  it("returns the growing prefix of the answer string", () => {
    expect(extractAnswerPrefix('{"answer": "Dear')).toBe("Dear");
    expect(extractAnswerPrefix('{"answer": "Dear team, I')).toBe("Dear team, I");
  });

  it("decodes escapes and stops at the closing quote", () => {
    expect(extractAnswerPrefix('{"answer": "line1\\nline2\\" q", "factIds"')).toBe('line1\nline2" q');
  });

  it("ignores an answer-like key inside another string", () => {
    expect(extractAnswerPrefix('{"note": "the \\"answer\\" is", "answer": "real')).toBe("real");
  });

  it("returns empty for an empty string input", () => {
    expect(extractAnswerPrefix("")).toBe("");
  });

  it("handles the answer value being empty so far (just opened quote)", () => {
    expect(extractAnswerPrefix('{"answer": "')).toBe("");
  });

  it("decodes tab escapes", () => {
    expect(extractAnswerPrefix('{"answer": "a\\tb')).toBe("a\tb");
  });

  it("decodes a lone backslash escape (\\\\)", () => {
    expect(extractAnswerPrefix('{"answer": "path\\\\to\\\\file')).toBe("path\\to\\file");
  });

  it("does not choke on a trailing dangling escape backslash (partial chunk boundary)", () => {
    // The chunk ends mid-escape-sequence; we can't yet decode the trailing
    // backslash so it is safely excluded from the returned prefix.
    expect(extractAnswerPrefix('{"answer": "abc\\')).toBe("abc");
  });

  it("handles whitespace variations around the colon", () => {
    expect(extractAnswerPrefix('{"answer":"noSpace')).toBe("noSpace");
    expect(extractAnswerPrefix('{"answer"  :   "extraSpace')).toBe("extraSpace");
  });

  it("returns the full value once the closing quote is present, ignoring anything after", () => {
    expect(extractAnswerPrefix('{"answer": "complete", "factIds": []}')).toBe("complete");
  });
});

describe("streamChatJson", () => {
  it("emits growing answer deltas and validates the final JSON", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"{\\"answer\\": \\"He"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"llo\\", \\"factIds\\": [\\"a\\"], \\"confidence\\": 0.9, \\"unsupportedClaims\\": []}"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
            c.close();
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const seen: string[] = [];
    const r = await streamChatJson(
      { system: "s", user: "u", schema: generationResultSchema, model: "m", apiKey: "k", fetchImpl },
      { onAnswerDelta: (a) => seen.push(a) },
    );
    expect(r.ok).toBe(true);
    expect(seen.at(-1)).toBe("Hello");
    expect(seen.length).toBeGreaterThan(0);
  });

  it("http error → never throws, taxonomy result", async () => {
    const r = await streamChatJson(
      {
        system: "s",
        user: "u",
        schema: generationResultSchema,
        model: "m",
        apiKey: "k",
        fetchImpl: (async () => new Response("nope", { status: 429 })) as typeof fetch,
      },
      { onAnswerDelta: () => {} },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("http_429");
  });

  it("sends stream:true plus the same body/header shape as chatJson", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      capturedInit = init;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    await streamChatJson(
      { system: "s", user: "u", schema: generationResultSchema, model: "m", apiKey: "k", fetchImpl },
      { onAnswerDelta: () => {} },
    );

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer k");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(capturedInit?.body as string) as {
      model: string;
      stream: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("m");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ]);
  });

  it("no accumulated content at all → no_json", async () => {
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const r = await streamChatJson(
      { system: "s", user: "u", schema: generationResultSchema, model: "m", apiKey: "k", fetchImpl },
      { onAnswerDelta: () => {} },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no_json");
  });

  it("valid JSON but schema mismatch → schema_invalid", async () => {
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"{\\"wrong\\": \\"shape\\"}"}}]}\n\n',
              ),
            );
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const r = await streamChatJson(
      { system: "s", user: "u", schema: generationResultSchema, model: "m", apiKey: "k", fetchImpl },
      { onAnswerDelta: () => {} },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("schema_invalid");
  });

  it("isUseful:false → not_useful", async () => {
    const payload = JSON.stringify({
      answer: "hi",
      factIds: [],
      confidence: 0.9,
      unsupportedClaims: [],
    });
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: payload } }] })}\n\n`,
              ),
            );
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const r = await streamChatJson(
      {
        system: "s",
        user: "u",
        schema: generationResultSchema,
        model: "m",
        apiKey: "k",
        fetchImpl,
        isUseful: () => false,
      },
      { onAnswerDelta: () => {} },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not_useful");
  });

  it("network error (fetch rejects) → never throws", async () => {
    const boom = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const r = await streamChatJson(
      { system: "s", user: "u", schema: generationResultSchema, model: "m", apiKey: "k", fetchImpl: boom },
      { onAnswerDelta: () => {} },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("network down");
  });

  it("malformed SSE line JSON is skipped without throwing", async () => {
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("data: {not valid json}\n\n"));
            c.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"{\\"answer\\": \\"ok\\", \\"factIds\\": [], \\"confidence\\": 0.5, \\"unsupportedClaims\\": []}"}}]}\n\n',
              ),
            );
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const r = await streamChatJson(
      { system: "s", user: "u", schema: generationResultSchema, model: "m", apiKey: "k", fetchImpl },
      { onAnswerDelta: () => {} },
    );
    expect(r.ok).toBe(true);
    expect(r.value?.answer).toBe("ok");
  });

  it("onAnswerDelta is only called when the extracted prefix grows", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"{\\"answer\\": \\""}}]}\n\n', // opens value, prefix still ""
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"\\", \\"factIds\\": [], \\"confidence\\": 0.5, \\"unsupportedClaims\\": []}"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
            c.close();
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const seen: string[] = [];
    await streamChatJson(
      { system: "s", user: "u", schema: generationResultSchema, model: "m", apiKey: "k", fetchImpl },
      { onAnswerDelta: (a) => seen.push(a) },
    );
    // Should not receive a redundant "" delta once "Hi" begins; only distinct
    // growing prefixes are reported.
    expect(seen).toEqual(["Hi"]);
  });

  it("times out via AbortController when the response never resolves", async () => {
    const never = ((_: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const r = await streamChatJson(
      {
        system: "s",
        user: "u",
        schema: generationResultSchema,
        model: "m",
        apiKey: "k",
        timeoutMs: 20,
        fetchImpl: never,
      },
      { onAnswerDelta: () => {} },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("timeout");
  });
});
