import { beforeEach, describe, expect, it } from "vitest";
import type { ScoringProfile } from "@careerhq/contracts";
import { DEFAULT_SCORING_PROFILE } from "@careerhq/contracts";
import { clearCooldowns } from "../client/fallback.js";
import { buildRerankPrompt, rerankJobs, type RerankJobInput } from "./rerank.js";

const profile: ScoringProfile = {
  ...DEFAULT_SCORING_PROFILE,
  roles: ["Backend Engineer", "Platform Engineer"],
  stack: ["TypeScript", "Postgres"],
  boost: ["remote-first", "async culture"],
};

const jobs: RerankJobInput[] = [
  {
    id: "job-1",
    title: "Senior Backend Engineer",
    companyName: "Acme Corp",
    location: "Remote (US)",
    remoteMode: "remote",
    keywordScore: 8,
    descriptionSnippet: "Build and scale our TypeScript services on Postgres.",
  },
  {
    id: "job-2",
    title: "Platform Engineer",
    companyName: "Globex",
    location: "Berlin, Germany",
    remoteMode: "hybrid",
    keywordScore: 5,
    descriptionSnippet: "Own our internal developer platform.",
  },
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

describe("buildRerankPrompt", () => {
  it("system prompt explains the ranking-for-fit purpose, the exact JSON shape, and the scoring rules", () => {
    const { system } = buildRerankPrompt(jobs, profile);

    expect(system).toMatch(/rank/i);
    expect(system).toMatch(/fit/i);
    expect(system).toMatch(/candidate profile/i);

    expect(system).toMatch(/ONLY/);
    expect(system).toContain('{"results":[{"jobId","score","rationale","redFlags"}]}');

    expect(system).toMatch(/0.*100/);
    expect(system).toMatch(/one entry per (input )?job/i);
    expect(system).toMatch(/verbatim/i);
    expect(system).toMatch(/25 words/i);

    expect(system).toMatch(/redFlags/);
    expect(system).toMatch(/equity-only pay/i);
    expect(system).toMatch(/agency spam/i);
    expect(system).toMatch(/mismatched seniority/i);
  });

  it("user prompt contains the profile roles/stack/boost lists and a numbered job list with all fields", () => {
    const { user } = buildRerankPrompt(jobs, profile);

    for (const role of profile.roles) expect(user).toContain(role);
    for (const stack of profile.stack) expect(user).toContain(stack);
    for (const boost of profile.boost) expect(user).toContain(boost);

    for (const job of jobs) {
      expect(user).toContain(job.id);
      expect(user).toContain(job.title);
      expect(user).toContain(job.companyName);
      expect(user).toContain(job.location as string);
      expect(user).toContain(job.remoteMode as string);
      expect(user).toContain(String(job.keywordScore));
      expect(user).toContain(job.descriptionSnippet);
    }

    // numbered list
    expect(user).toMatch(/1\./);
    expect(user).toMatch(/2\./);
  });

  it("contains every job id and profile role verbatim", () => {
    const { system, user } = buildRerankPrompt(jobs, profile);
    const combined = `${system}\n${user}`;
    for (const job of jobs) expect(combined).toContain(job.id);
    for (const role of profile.roles) expect(combined).toContain(role);
  });
});

describe("rerankJobs", () => {
  beforeEach(() => {
    clearCooldowns();
  });

  it("returns ok when the mocked model returns a valid result referencing input ids", async () => {
    const content = JSON.stringify({
      results: [
        { jobId: "job-1", score: 90, rationale: "Strong backend + Postgres fit.", redFlags: [] },
        { jobId: "job-2", score: 60, rationale: "Platform role, hybrid not fully remote.", redFlags: [] },
      ],
    });
    const fetchImpl = sequenceFetch([okResponse(content)]);

    const result = await rerankJobs(jobs, profile, {
      models: ["model-a"],
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.value?.results).toHaveLength(2);
  });

  it("falls through to the next model when ids are hallucinated, and ends not_useful with a single model", async () => {
    const badContent = JSON.stringify({
      results: [{ jobId: "not-a-real-id", score: 90, rationale: "n/a", redFlags: [] }],
    });
    const fetchImpl = sequenceFetch([okResponse(badContent)]);

    const result = await rerankJobs(jobs, profile, {
      models: ["only-model"],
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_useful");
  });

  it("falls through to a second model when the first returns unknown ids", async () => {
    const badContent = JSON.stringify({
      results: [{ jobId: "not-a-real-id", score: 90, rationale: "n/a", redFlags: [] }],
    });
    const goodContent = JSON.stringify({
      results: [
        { jobId: "job-1", score: 70, rationale: "ok fit", redFlags: [] },
        { jobId: "job-2", score: 40, rationale: "weaker fit", redFlags: [] },
      ],
    });
    const fetchImpl = sequenceFetch([okResponse(badContent), okResponse(goodContent)]);

    const result = await rerankJobs(jobs, profile, {
      models: ["model-a", "model-b"],
      apiKey: "k",
      fetchImpl,
      sleep: async () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.model).toBe("model-b");
  });
});
