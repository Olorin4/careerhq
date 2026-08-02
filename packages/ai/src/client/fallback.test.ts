import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { chatJsonWithFallback, clearCooldowns } from "./fallback.js";

const schema = z.object({ answer: z.string() });

const okResponse = (content: unknown, status = 200): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });

const statusResponse = (status: number): Response => new Response("nope", { status });

/** Builds a fetchImpl that returns one Response per call, in order, keyed by model via call count. */
const sequenceFetch = (responses: Response[]): typeof fetch => {
  let i = 0;
  return (async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return r;
  }) as unknown as typeof fetch;
};

const base = { system: "s", user: "u", schema };

describe("chatJsonWithFallback", () => {
  beforeEach(() => {
    clearCooldowns();
  });

  it("falls back from a 429 on model A to a 200 on model B", async () => {
    const fetchImpl = sequenceFetch([statusResponse(429), okResponse('{"answer":"hi"}')]);
    const result = await chatJsonWithFallback(base, {
      models: ["a", "b"],
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.model).toBe("b");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ model: "a", error: "http_429", status: 429 });
    expect(result.attempts[1]).toMatchObject({ model: "b", error: null, status: 200 });
  });

  it("skips a model still cooling down after a 429, recording skippedCooldown", async () => {
    let now = 1_000_000;
    const nowFn = () => now;

    // First call: model "a" hits 429 and enters cooldown.
    const firstFetch = sequenceFetch([statusResponse(429), okResponse('{"answer":"hi"}')]);
    const first = await chatJsonWithFallback(base, {
      models: ["a", "b"],
      apiKey: "k",
      fetchImpl: firstFetch,
      sleep: async () => {},
      now: nowFn,
    });
    expect(first.ok).toBe(true);
    expect(first.model).toBe("b");

    // Immediately after (same module state), model "a" is still cooling down.
    now += 1_000; // well within the 5-minute default cooldown
    const secondFetch = sequenceFetch([okResponse('{"answer":"hi2"}')]);
    const second = await chatJsonWithFallback(base, {
      models: ["a", "b"],
      apiKey: "k",
      fetchImpl: secondFetch,
      sleep: async () => {},
      now: nowFn,
    });
    expect(second.ok).toBe(true);
    expect(second.model).toBe("b");
    expect(second.attempts[0]).toMatchObject({ model: "a", skippedCooldown: true });
    expect(second.attempts[1]).toMatchObject({ model: "b", error: null });
  });

  it("clearCooldowns resets state so a previously-cooling model is tried again", async () => {
    let now = 2_000_000;
    const nowFn = () => now;

    const firstFetch = sequenceFetch([statusResponse(429), okResponse('{"answer":"hi"}')]);
    await chatJsonWithFallback(base, {
      models: ["a", "b"],
      apiKey: "k",
      fetchImpl: firstFetch,
      sleep: async () => {},
      now: nowFn,
    });

    clearCooldowns();
    now += 1_000;

    const secondFetch = sequenceFetch([okResponse('{"answer":"hi2"}')]);
    const second = await chatJsonWithFallback(base, {
      models: ["a", "b"],
      apiKey: "k",
      fetchImpl: secondFetch,
      sleep: async () => {},
      now: nowFn,
    });
    expect(second.attempts[0]).toMatchObject({ model: "a", error: null });
    expect(second.attempts[0]?.skippedCooldown).toBeFalsy();
  });

  it("returns all_models_cooling_down when every model is cooling", async () => {
    let now = 3_000_000;
    const nowFn = () => now;

    const firstFetch = sequenceFetch([statusResponse(429), statusResponse(429)]);
    const first = await chatJsonWithFallback(base, {
      models: ["a", "b"],
      apiKey: "k",
      fetchImpl: firstFetch,
      sleep: async () => {},
      now: nowFn,
    });
    expect(first.ok).toBe(false);

    now += 1_000;
    const secondFetch = sequenceFetch([okResponse('{"answer":"unused"}')]);
    const second = await chatJsonWithFallback(base, {
      models: ["a", "b"],
      apiKey: "k",
      fetchImpl: secondFetch,
      sleep: async () => {},
      now: nowFn,
    });
    expect(second.ok).toBe(false);
    expect(second.error).toBe("all_models_cooling_down");
    expect(second.attempts).toHaveLength(2);
    expect(second.attempts[0]).toMatchObject({ model: "a", skippedCooldown: true });
    expect(second.attempts[1]).toMatchObject({ model: "b", skippedCooldown: true });
  });

  it("continues past schema_invalid to a valid model", async () => {
    const fetchImpl = sequenceFetch([
      okResponse('{"wrong":"shape"}'),
      okResponse('{"answer":"hi"}'),
    ]);
    const result = await chatJsonWithFallback(base, {
      models: ["a", "b"],
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.model).toBe("b");
    expect(result.attempts[0]).toMatchObject({ model: "a", error: "schema_invalid" });
  });

  it("returns the last result with full attempts when the whole list is exhausted without success", async () => {
    const fetchImpl = sequenceFetch([
      okResponse('{"wrong":"shape"}'),
      statusResponse(500),
    ]);
    const result = await chatJsonWithFallback(base, {
      models: ["a", "b"],
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.model).toBe("b");
    expect(result.error).toBe("http_500");
    expect(result.attempts).toHaveLength(2);
  });

  it("calls sleep with a positive backoff before retrying after a retryable failure", async () => {
    const sleeps: number[] = [];
    const fetchImpl = sequenceFetch([statusResponse(500), okResponse('{"answer":"hi"}')]);
    await chatJsonWithFallback(base, {
      models: ["a", "b"],
      apiKey: "k",
      fetchImpl,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
  });

  it("does not sleep before the first model", async () => {
    const sleeps: number[] = [];
    const fetchImpl = sequenceFetch([okResponse('{"answer":"hi"}')]);
    await chatJsonWithFallback(base, {
      models: ["a", "b"],
      apiKey: "k",
      fetchImpl,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toHaveLength(0);
  });
});
