import { describe, expect, it } from "vitest";
import { normalizeQuestion, selectFactsForGeneration, type FactForSelection } from "./select-facts.js";

const fact = (over: Partial<FactForSelection>): FactForSelection => ({
  id: over.id ?? "f1", category: over.category ?? "skill", claim: over.claim ?? "TypeScript",
  detail: over.detail ?? null, sensitivity: over.sensitivity ?? "normal", stale: over.stale ?? false,
});
const ctx = { jobTitle: "Senior TypeScript Engineer", jobDescription: "Node, Postgres, logistics platform" };

describe("selectFactsForGeneration (spec §7.2.1)", () => {
  it("hard-excludes sensitive and stale facts regardless of relevance", () => {
    const facts = [
      fact({ id: "s", claim: "TypeScript expert", sensitivity: "sensitive" }),
      fact({ id: "t", claim: "TypeScript expert", stale: true }),
      fact({ id: "ok", claim: "TypeScript expert" }),
    ];
    const out = selectFactsForGeneration(facts, ctx);
    expect(out.map((f) => f.id)).toEqual(["ok"]);
  });
  it("ranks by term overlap with the context", () => {
    const facts = [
      fact({ id: "lo", category: "preference", claim: "Enjoys hiking" }),
      fact({ id: "hi", category: "preference", claim: "Built logistics platform with Postgres" }),
    ];
    const out = selectFactsForGeneration(facts, ctx);
    expect(out[0]?.id).toBe("hi");
    expect(out.find((f) => f.id === "lo")).toBeUndefined(); // zero overlap, no baseline → dropped
  });
  it("experience and skill facts survive with zero overlap (baseline)", () => {
    const out = selectFactsForGeneration([fact({ id: "e", category: "experience", claim: "Led a team of four" })], ctx);
    expect(out.map((f) => f.id)).toEqual(["e"]);
  });
  it("caps at maxFacts deterministically", () => {
    const many = Array.from({ length: 20 }, (_, i) => fact({ id: `f${i}`, claim: `TypeScript item ${i}` }));
    const a = selectFactsForGeneration(many, ctx);
    const b = selectFactsForGeneration([...many].reverse(), ctx);
    expect(a).toHaveLength(12);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id)); // input order must not matter
  });
});
describe("normalizeQuestion", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeQuestion("  Why   do you want THIS job?! ")).toBe("why do you want this job");
  });
});
