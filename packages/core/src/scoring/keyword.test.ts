import { describe, expect, it } from "vitest";
import { DEFAULT_SCORING_PROFILE } from "@careerhq/contracts";
import { scoreJob, SCORE_WEIGHTS } from "./keyword.js";

const profile = {
  ...DEFAULT_SCORING_PROFILE,
  roles: ["full-stack", "founding engineer"],
  stack: ["typescript", "node"],
  boost: ["logistics"],
  exclude: ["security clearance"],
};

describe("keyword scorer (spec §5.4)", () => {
  it("scores role in title with multiplier, stack and boost in description", () => {
    const s = scoreJob(
      { title: "Full-Stack Engineer", descriptionMd: "TypeScript, Node, logistics domain", remoteMode: "remote" },
      profile,
    );
    expect(s.excluded).toBe(false);
    expect(s.score).toBe(
      SCORE_WEIGHTS.role * SCORE_WEIGHTS.roleTitleMultiplier + SCORE_WEIGHTS.stack * 2 + SCORE_WEIGHTS.boost,
    );
    expect(s.breakdown.find((b) => b.term === "full-stack")?.inTitle).toBe(true);
    expect(s.meetsMinimums).toBe(true);
  });
  it("a term counts once even when it appears many times", () => {
    const s = scoreJob(
      { title: "Engineer", descriptionMd: "node node node typescript", remoteMode: "remote" },
      profile,
    );
    expect(s.breakdown.filter((b) => b.kind === "stack")).toHaveLength(2);
    expect(s.score).toBe(SCORE_WEIGHTS.stack * 2);
  });
  it("exclude term zeroes the score and records the reason", () => {
    const s = scoreJob(
      { title: "Full-Stack Engineer", descriptionMd: "Requires security clearance", remoteMode: "remote" },
      profile,
    );
    expect(s.excluded).toBe(true);
    expect(s.excludedBy).toEqual(["security clearance"]);
    expect(s.score).toBe(0);
  });
  it("remote filtering: onsite always filtered; unknown filtered only when includeUnknownRemote=false", () => {
    expect(scoreJob({ title: "Full-Stack", remoteMode: "onsite" }, profile).remoteFiltered).toBe(true);
    expect(scoreJob({ title: "Full-Stack", remoteMode: "unknown" }, profile).remoteFiltered).toBe(false);
    expect(scoreJob({ title: "Full-Stack", remoteMode: "unknown" },
      { ...profile, includeUnknownRemote: false }).remoteFiltered).toBe(true);
    expect(scoreJob({ title: "Full-Stack", remoteMode: "onsite" },
      { ...profile, requireRemote: false }).remoteFiltered).toBe(false);
  });
  it("meetsMinimums false when role hits below minimum", () => {
    const s = scoreJob({ title: "Backend dev", descriptionMd: "typescript", remoteMode: "remote" }, profile);
    expect(s.meetsMinimums).toBe(false);
  });
  it("matching is case-insensitive", () => {
    const s = scoreJob({ title: "FOUNDING ENGINEER", remoteMode: "remote" }, profile);
    expect(s.breakdown.some((b) => b.term === "founding engineer")).toBe(true);
  });
});
