import { beforeEach, describe, expect, it } from "vitest";
import { clearCooldowns } from "../client/fallback.js";
import { classifySensitiveLlm } from "./classify-sensitive.js";

const okResponse = (content: unknown, status = 200): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });

/** Builds a fetchImpl that returns one Response per call, in order. */
const sequenceFetch = (responses: Response[]): typeof fetch => {
  let i = 0;
  return (async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return r;
  }) as unknown as typeof fetch;
};

describe("classifySensitiveLlm", () => {
  beforeEach(() => {
    clearCooldowns();
  });

  it("returns true when the model classifies the question as sensitive", async () => {
    const fetchImpl = sequenceFetch([okResponse(JSON.stringify({ sensitive: true }))]);

    const result = await classifySensitiveLlm("What is your current salary?", {
      models: ["fast-model"],
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
    });

    expect(result).toBe(true);
  });

  it("returns false when the model classifies the question as not sensitive", async () => {
    const fetchImpl = sequenceFetch([okResponse(JSON.stringify({ sensitive: false }))]);

    const result = await classifySensitiveLlm("What tools have you used?", {
      models: ["fast-model"],
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
    });

    expect(result).toBe(false);
  });

  it("returns null when every model attempt fails", async () => {
    const fetchImpl = sequenceFetch([new Response("boom", { status: 500 })]);

    const result = await classifySensitiveLlm("What tools have you used?", {
      models: ["fast-model"],
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
    });

    expect(result).toBeNull();
  });
});
