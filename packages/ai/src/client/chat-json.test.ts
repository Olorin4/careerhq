import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chatJson, extractJsonObject } from "./chat-json.js";

const schema = z.object({ answer: z.string() });

const okFetch = (content: unknown): typeof fetch =>
  (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

const base = { system: "s", user: "u", schema, model: "m", apiKey: "k" };

describe("chatJson", () => {
  it("parses a plain JSON string content", async () => {
    const r = await chatJson({ ...base, fetchImpl: okFetch('{"answer":"hi"}') });
    expect(r.ok).toBe(true);
    expect(r.value?.answer).toBe("hi");
  });

  it("parses prose-wrapped and fenced JSON", async () => {
    const r = await chatJson({
      ...base,
      fetchImpl: okFetch('Sure! ```json\n{"answer":"hi"}\n``` hope that helps'),
    });
    expect(r.ok).toBe(true);
  });

  it("parses an object content directly (no string encoding)", async () => {
    const r = await chatJson({ ...base, fetchImpl: okFetch({ answer: "hi" }) });
    expect(r.ok).toBe(true);
    expect(r.value?.answer).toBe("hi");
  });

  it("returns http_429 with status on rate limit, never throwing", async () => {
    const r = await chatJson({
      ...base,
      fetchImpl: (async () => new Response("slow down", { status: 429 })) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(r.error).toBe("http_429");
  });

  it("schema mismatch → schema_invalid", async () => {
    const r = await chatJson({ ...base, fetchImpl: okFetch('{"wrong":"shape"}') });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("schema_invalid");
  });

  it("isUseful=false → not_useful", async () => {
    const r = await chatJson({
      ...base,
      isUseful: () => false,
      fetchImpl: okFetch('{"answer":"hi"}'),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not_useful");
  });

  it("timeout aborts and reports", async () => {
    const never: typeof fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () =>
          rej(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;
    const r = await chatJson({ ...base, timeoutMs: 20, fetchImpl: never });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("timeout");
  });

  it("no JSON in content → no_json", async () => {
    const r = await chatJson({ ...base, fetchImpl: okFetch("no json here") });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("no_json");
  });

  it("non-JSON 200 response body → no_json with status preserved (not indistinguishable from a network failure)", async () => {
    const r = await chatJson({
      ...base,
      fetchImpl: (async () =>
        new Response("not json at all", { status: 200 })) as unknown as typeof fetch,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(200);
    expect(r.error).toBe("no_json");
  });

  it("sends the expected headers and body shape, using default url and timeout", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const spyFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"answer":"hi"}' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const r = await chatJson({ ...base, fetchImpl: spyFetch });

    expect(r.ok).toBe(true);
    expect(capturedUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer k");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["HTTP-Referer"]).toBe("https://careerhq.nickkalas.dev");
    expect(headers["X-Title"]).toBe("CareerHQ");

    const body = JSON.parse(capturedInit?.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      response_format: { type: string };
      temperature: number;
    };
    expect(body.model).toBe("m");
    expect(body.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ]);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.temperature).toBe(0);
  });

  it("reports latencyMs and model on success", async () => {
    const r = await chatJson({ ...base, fetchImpl: okFetch('{"answer":"hi"}') });
    expect(r.model).toBe("m");
    expect(typeof r.latencyMs).toBe("number");
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.status).toBe(200);
  });

  it("respects a custom url", async () => {
    let capturedUrl: string | undefined;
    const spyFetch: typeof fetch = (async (input: unknown) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"answer":"hi"}' } }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await chatJson({ ...base, url: "https://example.test/v1/chat", fetchImpl: spyFetch });
    expect(capturedUrl).toBe("https://example.test/v1/chat");
  });

  it("returns ok:false with a message error when fetch rejects for a non-abort reason", async () => {
    const boom: typeof fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const r = await chatJson({ ...base, fetchImpl: boom });
    expect(r.ok).toBe(false);
    expect(r.status).toBeNull();
    expect(r.error).toBe("network down");
  });
});

describe("extractJsonObject", () => {
  it("returns null for no JSON", () => {
    expect(extractJsonObject("no json here")).toBeNull();
  });

  it("parses a plain JSON string", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips fences and prose around JSON", () => {
    expect(extractJsonObject('Sure! ```json\n{"a":1}\n``` hope that helps')).toEqual({ a: 1 });
  });

  it("returns null for malformed JSON", () => {
    expect(extractJsonObject("{not valid json}")).toBeNull();
  });
});
