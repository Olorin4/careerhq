import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCooldowns } from "../client/fallback.js";
import { buildGeneratePrompt, generateGrounded, type GenerateInput } from "./generate.js";

const job = {
  title: "Senior Backend Engineer",
  companyName: "Acme Corp",
  descriptionSnippet: "Build and scale our TypeScript services on Postgres.",
};

const facts = [
  { id: "fact-1", claim: "Led migration to Postgres", detail: "Reduced query latency by 40%." },
  { id: "fact-2", claim: "5 years of TypeScript experience", detail: null },
];

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

describe("buildGeneratePrompt", () => {
  it("system prompt requires exclusive grounding in the numbered facts and bars invention", () => {
    const input: GenerateInput = { kind: "cover_letter", job, facts };
    const { system } = buildGeneratePrompt(input);

    expect(system).toMatch(/grounded/i);
    expect(system).toMatch(/EXCLUSIVELY/);
    expect(system).toMatch(/numbered facts/i);
    expect(system).toMatch(/must not invent/i);
    expect(system).toMatch(/employers/i);
    expect(system).toMatch(/projects/i);
    expect(system).toMatch(/metrics/i);
    expect(system).toMatch(/dates/i);
    expect(system).toMatch(/qualifications/i);
  });

  it("system prompt demands ONLY the exact JSON shape", () => {
    const input: GenerateInput = { kind: "cover_letter", job, facts };
    const { system } = buildGeneratePrompt(input);

    expect(system).toMatch(/ONLY/);
    expect(system).toContain(
      '{"answer","factIds","confidence","unsupportedClaims","clarificationNeeded"}',
    );
  });

  it("system prompt requires factIds to list every fact actually used", () => {
    const input: GenerateInput = { kind: "cover_letter", job, facts };
    const { system } = buildGeneratePrompt(input);

    expect(system).toMatch(/factIds/);
    expect(system).toMatch(/every fact.*used|used.*every fact/is);
  });

  it("system prompt requires unsupported claims discipline", () => {
    const input: GenerateInput = { kind: "cover_letter", job, facts };
    const { system } = buildGeneratePrompt(input);

    expect(system).toMatch(/unsupportedClaims/);
    expect(system).toMatch(/not backed by a provided fact/i);
  });

  it("system prompt instructs low confidence and clarificationNeeded instead of inventing when facts are insufficient", () => {
    const input: GenerateInput = { kind: "cover_letter", job, facts };
    const { system } = buildGeneratePrompt(input);

    expect(system).toMatch(/insufficient/i);
    expect(system).toMatch(/low confidence/i);
    expect(system).toMatch(/clarificationNeeded/);
    expect(system).toMatch(/rather than invent/i);
  });

  it("cover_letter kind instruction requires 3 short paragraphs, professional tone, and bars the [Hiring Manager] placeholder", () => {
    const input: GenerateInput = { kind: "cover_letter", job, facts };
    const { system } = buildGeneratePrompt(input);

    expect(system).toMatch(/3 short paragraphs/i);
    expect(system).toMatch(/professional/i);
    expect(system).toContain("[Hiring Manager]");
    expect(system).toMatch(/unless a name is known/i);
  });

  it("email_body kind instruction requires <=150 words and directness", () => {
    const input: GenerateInput = { kind: "email_body", job, facts };
    const { system } = buildGeneratePrompt(input);

    expect(system).toMatch(/150 words/);
    expect(system).toMatch(/direct/i);
  });

  it("question kind instruction requires answering the question directly", () => {
    const input: GenerateInput = {
      kind: "question",
      question: "What is your notice period?",
      job,
      facts,
    };
    const { system } = buildGeneratePrompt(input);

    expect(system).toMatch(/answer the question directly/i);
  });

  it("user prompt contains job title/company/snippet, the question when present, and the numbered fact list", () => {
    const input: GenerateInput = {
      kind: "question",
      question: "What is your notice period?",
      job,
      facts,
    };
    const { user } = buildGeneratePrompt(input);

    expect(user).toContain(job.title);
    expect(user).toContain(job.companyName);
    expect(user).toContain(job.descriptionSnippet);
    expect(user).toContain("What is your notice period?");

    for (const fact of facts) {
      expect(user).toContain(`[${fact.id}]`);
      expect(user).toContain(fact.claim);
    }
    expect(user).toContain(facts[0]!.detail as string);
  });

  it("user prompt omits the question line when no question is present", () => {
    const input: GenerateInput = { kind: "email_body", job, facts };
    const { user } = buildGeneratePrompt(input);

    expect(user).not.toContain("Question:");
  });
});

describe("generateGrounded", () => {
  beforeEach(() => {
    clearCooldowns();
  });

  it("returns ok when the mocked model returns valid grounded JSON referencing only input fact ids", async () => {
    const content = JSON.stringify({
      answer: "I led our migration to Postgres and bring 5 years of TypeScript experience.",
      factIds: ["fact-1", "fact-2"],
      confidence: 0.9,
      unsupportedClaims: [],
    });
    const fetchImpl = sequenceFetch([okResponse(content)]);

    const result = await generateGrounded(
      { kind: "cover_letter", job, facts },
      { models: ["model-a"], apiKey: "k", fetchImpl, sleep: async () => {} },
    );

    expect(result.ok).toBe(true);
    expect(result.value?.factIds).toEqual(["fact-1", "fact-2"]);
  });

  it("is not_useful when factIds reference an id outside the input fact set, with a single model configured", async () => {
    const badContent = JSON.stringify({
      answer: "I have 10 years of experience at a company not in the facts.",
      factIds: ["fact-1", "not-a-real-fact"],
      confidence: 0.9,
      unsupportedClaims: [],
    });
    const fetchImpl = sequenceFetch([okResponse(badContent)]);

    const result = await generateGrounded(
      { kind: "cover_letter", job, facts },
      { models: ["only-model"], apiKey: "k", fetchImpl, sleep: async () => {} },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_useful");
  });

  it("returns no_facts_provided immediately, without invoking fetch, when facts is empty", async () => {
    const fetchImpl = vi.fn();

    const result = await generateGrounded(
      { kind: "cover_letter", job, facts: [] },
      { models: ["model-a"], apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    );

    expect(result).toEqual({
      ok: false,
      error: "no_facts_provided",
      value: null,
      model: "",
      latencyMs: 0,
      status: null,
      attempts: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
