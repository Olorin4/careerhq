import { describe, expect, it } from "vitest";
import { MIN_GENERATION_CONFIDENCE, validateGeneration } from "./validate.js";

const base = { answer: "I built X", factIds: ["a"], confidence: 0.9, unsupportedClaims: [] as string[] };

describe("validateGeneration (spec §7.2.3-4)", () => {
  it("passes a fully grounded result", () => {
    expect(validateGeneration(base, ["a", "b"])).toEqual({ ok: true });
  });
  it("rejects citations outside the provided subset (never trusts the model)", () => {
    const v = validateGeneration({ ...base, factIds: ["a", "z"] }, ["a"]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reasons.join(" ")).toContain("unknown fact z");
  });
  it("rejects zero citations", () => {
    const v = validateGeneration({ ...base, factIds: [] }, ["a"]);
    expect(v.ok).toBe(false);
  });
  it("rejects unsupported claims and low confidence, collecting ALL reasons", () => {
    const v = validateGeneration(
      { ...base, unsupportedClaims: ["invented award"], confidence: 0.3 }, ["a"],
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reasons).toHaveLength(2);
      expect(v.status).toBe("needs_facts");
    }
  });
  it("rejects when clarification is requested", () => {
    const v = validateGeneration({ ...base, clarificationNeeded: "which project?" }, ["a"]);
    expect(v.ok).toBe(false);
  });
  it("threshold is exactly 0.6 inclusive", () => {
    expect(validateGeneration({ ...base, confidence: MIN_GENERATION_CONFIDENCE }, ["a"]).ok).toBe(true);
    expect(validateGeneration({ ...base, confidence: 0.59 }, ["a"]).ok).toBe(false);
  });
});
