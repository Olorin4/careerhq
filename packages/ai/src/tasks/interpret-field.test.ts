import { beforeEach, describe, expect, it } from "vitest";
import { CANONICAL_FIELDS } from "@careerhq/contracts";
import { clearCooldowns } from "../client/fallback.js";
import { buildInterpretPrompt, interpretField, type InterpretFieldInput } from "./interpret-field.js";

const input: InterpretFieldInput = {
  label: "Legal Authorization",
  nearbyText: "I certify that I am authorized to work in the United States",
  kind: "checkbox",
  options: [],
  jobTitle: "Software Engineer",
  companyName: "Acme Corp",
};

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

describe("buildInterpretPrompt", () => {
  it("lists every canonical field value exactly", () => {
    const { system } = buildInterpretPrompt(input);

    for (const field of CANONICAL_FIELDS) {
      expect(system).toContain(field);
    }
  });

  it("includes the sensitive-caution sentence", () => {
    const { system } = buildInterpretPrompt(input);

    expect(system).toMatch(/never guess/i);
    expect(system).toMatch(/work_authorization/i);
    expect(system).toMatch(/visa_sponsorship/i);
    expect(system).toMatch(/desired_salary/i);
    expect(system).toMatch(/demographics/i);
    expect(system).toMatch(/criminal_history/i);
    expect(system).toMatch(/legal_attestation/i);
    expect(system).toMatch(/unambiguous/i);
  });

  it("instructs mapping to exactly one canonical field", () => {
    const { system } = buildInterpretPrompt(input);

    expect(system).toMatch(/exactly one/i);
    expect(system).toMatch(/map/i);
  });

  it("instructs saying unknown when unsure", () => {
    const { system } = buildInterpretPrompt(input);

    expect(system).toMatch(/unknown/i);
    expect(system).toMatch(/unsure/i);
  });

  it("carries the input into the user message", () => {
    const { user } = buildInterpretPrompt(input);

    expect(user).toContain("Legal Authorization");
    expect(user).toContain("I certify that I am authorized");
    expect(user).toContain("Software Engineer");
    expect(user).toContain("Acme Corp");
    expect(user).toContain("checkbox");
  });

  it("returns a JSON shape with canonicalField and confidence", () => {
    const { system } = buildInterpretPrompt(input);

    expect(system).toMatch(/canonicalField/);
    expect(system).toMatch(/confidence/);
  });
});

describe("interpretField", () => {
  beforeEach(() => {
    clearCooldowns();
  });

  it("returns ok when model provides a valid canonicalField and confidence", async () => {
    const fetchImpl = sequenceFetch([okResponse(JSON.stringify({
      canonicalField: "work_authorization",
      confidence: 0.95,
    }))]);

    const result = await interpretField(input, {
      models: ["fast-model"],
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({
      canonicalField: "work_authorization",
      confidence: 0.95,
    });
  });

  it("rejects a sensitive canonicalField with confidence < 0.8 as not useful", async () => {
    const fetchImpl = sequenceFetch([okResponse(JSON.stringify({
      canonicalField: "desired_salary",
      confidence: 0.5,
    }))]);

    const result = await interpretField(input, {
      models: ["fast-model"],
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_useful");
  });

  it("accepts a sensitive canonicalField with confidence >= 0.8", async () => {
    const fetchImpl = sequenceFetch([okResponse(JSON.stringify({
      canonicalField: "work_authorization",
      confidence: 0.8,
    }))]);

    const result = await interpretField(input, {
      models: ["fast-model"],
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.value?.canonicalField).toBe("work_authorization");
  });

  it("accepts unknown at any confidence level", async () => {
    const fetchImpl = sequenceFetch([okResponse(JSON.stringify({
      canonicalField: "unknown",
      confidence: 0.5,
    }))]);

    const result = await interpretField(input, {
      models: ["fast-model"],
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.value?.canonicalField).toBe("unknown");
  });

  it("rejects an invalid canonicalField as schema failure", async () => {
    const fetchImpl = sequenceFetch([okResponse(JSON.stringify({
      canonicalField: "invalid_field",
      confidence: 0.9,
    }))]);

    const result = await interpretField(input, {
      models: ["fast-model"],
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("schema_invalid");
  });

  it("rejects confidence outside 0-1 range as schema failure", async () => {
    const fetchImpl = sequenceFetch([okResponse(JSON.stringify({
      canonicalField: "email",
      confidence: 1.5,
    }))]);

    const result = await interpretField(input, {
      models: ["fast-model"],
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("schema_invalid");
  });

  it("reports the failure rather than throwing when every model fails", async () => {
    const fetchImpl = sequenceFetch([new Response("boom", { status: 500 })]);

    const result = await interpretField(input, {
      models: ["fast-model"],
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.value).toBeNull();
    expect(result.attempts).toHaveLength(1);
  });
});
