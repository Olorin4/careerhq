import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCORING_PROFILE, normalizedJobSchema, rerankResultSchema, scoringProfileSchema,
} from "./index.js";

describe("discovery contracts", () => {
  it("normalizedJob requires source/externalId/url/title/companyName and defaults remoteMode", () => {
    const parsed = normalizedJobSchema.parse({
      source: "remotive", externalId: "123", url: "https://x.example/job",
      title: "Engineer", companyName: "Acme",
    });
    expect(parsed.remoteMode).toBe("unknown");
    expect(normalizedJobSchema.safeParse({ source: "remotive" }).success).toBe(false);
  });
  it("scoring profile defaults match spec §5.4", () => {
    expect(DEFAULT_SCORING_PROFILE.topNForLlm).toBe(25);
    expect(DEFAULT_SCORING_PROFILE.requireRemote).toBe(true);
    expect(DEFAULT_SCORING_PROFILE.minRoleHits).toBe(1);
  });
  it("rerank result bounds scores to 0-100", () => {
    expect(rerankResultSchema.safeParse({
      results: [{ jobId: "a", score: 101, rationale: "x" }],
    }).success).toBe(false);
    const ok = rerankResultSchema.parse({ results: [{ jobId: "a", score: 88, rationale: "fit" }] });
    expect(ok.results[0]?.redFlags).toEqual([]);
  });
  it("profile arrays default empty", () => {
    expect(scoringProfileSchema.parse({}).roles).toEqual([]);
  });
});
