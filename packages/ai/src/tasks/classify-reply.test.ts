import { beforeEach, describe, expect, it } from "vitest";
import { clearCooldowns } from "../client/fallback.js";
import { buildClassifyPrompt, classifyReply, type ClassifyReplyInput } from "./classify-reply.js";

const message: ClassifyReplyInput = {
  subject: "Re: Application for Backend Engineer",
  snippet: "Thanks for applying — we have received your application and will be in touch.",
  companyName: "Acme Corp",
  jobTitle: "Backend Engineer",
  applicationState: "SUBMITTED",
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

describe("buildClassifyPrompt", () => {
  it("states the job-application-reply purpose and the exact JSON-only shape", () => {
    const { system } = buildClassifyPrompt(message);

    expect(system).toMatch(/job application/i);
    expect(system).toMatch(/repl(y|ies)/i);
    expect(system).toMatch(/ONLY/);
    expect(system).toContain('{"classification","confidence","suggestedState","quotedEvidence"}');
    expect(system).toMatch(/no prose/i);
  });

  it("lists every classification label and constrains suggestedState to the four reachable states", () => {
    const { system } = buildClassifyPrompt(message);

    for (const label of ["ack", "recruiter", "interview", "rejection", "offer", "unrelated"]) {
      expect(system).toContain(label);
    }
    for (const state of ["ACKNOWLEDGED", "INTERVIEW", "REJECTED", "OFFER"]) {
      expect(system).toContain(state);
    }
    // Nothing else may be suggested — the state machine has no edge for them.
    expect(system).not.toContain("SHORTLISTED");
    expect(system).not.toContain("WITHDRAWN");
  });

  it("asks for verbatim quoted evidence and a 0-1 confidence", () => {
    const { system } = buildClassifyPrompt(message);
    expect(system).toMatch(/verbatim/i);
    expect(system).toMatch(/quotedEvidence/);
    expect(system).toMatch(/0(\.0)?\s*(to|-|and)\s*1/i);
  });

  it("carries the subject, snippet, company, title and current state into the user message", () => {
    const { user } = buildClassifyPrompt(message);
    expect(user).toContain("Re: Application for Backend Engineer");
    expect(user).toContain("we have received your application");
    expect(user).toContain("Acme Corp");
    expect(user).toContain("Backend Engineer");
    expect(user).toContain("SUBMITTED");
  });
});

describe("classifyReply", () => {
  beforeEach(() => {
    clearCooldowns();
  });

  it("returns a validated classification result", async () => {
    const fetchImpl = sequenceFetch([okResponse(JSON.stringify({
      classification: "ack", confidence: 0.95, suggestedState: "ACKNOWLEDGED",
      quotedEvidence: "we have received your application",
    }))]);

    const result = await classifyReply(message, {
      models: ["fast-model"], apiKey: "k", fetchImpl, sleep: async () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({
      classification: "ack", confidence: 0.95, suggestedState: "ACKNOWLEDGED",
      quotedEvidence: "we have received your application",
    });
  });

  it("accepts a result with no suggestedState at all", async () => {
    const fetchImpl = sequenceFetch([okResponse(JSON.stringify({
      classification: "unrelated", confidence: 0.4, quotedEvidence: "newsletter",
    }))]);

    const result = await classifyReply(message, {
      models: ["fast-model"], apiKey: "k", fetchImpl, sleep: async () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.value?.suggestedState).toBeUndefined();
  });

  // The contract schema accepts every ApplicationState, so the reachable-subset
  // rule has to be enforced as a usefulness check, not by the schema.
  it("rejects a suggestedState outside the reachable subset as not useful", async () => {
    const fetchImpl = sequenceFetch([okResponse(JSON.stringify({
      classification: "ack", confidence: 0.9, suggestedState: "SHORTLISTED", quotedEvidence: "hi",
    }))]);

    const result = await classifyReply(message, {
      models: ["fast-model"], apiKey: "k", fetchImpl, sleep: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_useful");
  });

  it("rejects an unknown classification label as a schema failure", async () => {
    const fetchImpl = sequenceFetch([okResponse(JSON.stringify({
      classification: "spam", confidence: 0.9, quotedEvidence: "hi",
    }))]);

    const result = await classifyReply(message, {
      models: ["fast-model"], apiKey: "k", fetchImpl, sleep: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("schema_invalid");
  });

  it("reports the failure rather than throwing when every model fails", async () => {
    const fetchImpl = sequenceFetch([new Response("boom", { status: 500 })]);

    const result = await classifyReply(message, {
      models: ["fast-model"], apiKey: "k", fetchImpl, sleep: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.value).toBeNull();
    expect(result.attempts).toHaveLength(1);
  });
});
