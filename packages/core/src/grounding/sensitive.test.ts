import { describe, expect, it } from "vitest";
import { classifyQuestionSensitivity, mergeSensitivityRulings } from "./sensitive.js";

describe("sensitive-question ruleset (spec §7.2.5)", () => {
  it.each([
    ["Are you authorized to work in the US?", "authorized to work"],
    ["Do you require visa sponsorship?", "sponsorship"],
    ["What are your salary expectations?", "salary"],
    ["What is your notice period?", "notice period"],
    ["Are you willing to relocate?", "relocate"],
    ["Have you ever been convicted of a felony?", "felony"],
    ["Do you have a disability?", "disability"],
    ["I certify the above is true", "certify"],
  ])("flags %s", (q, term) => {
    const r = classifyQuestionSensitivity(q);
    expect(r.sensitive).toBe(true);
    expect(r.matchedTerms.join(" ")).toContain(term);
  });
  it.each([
    ["What's your current comp?", "comp"],
    ["Are you legally able to work in Germany?", "legally able to work"],
    ["When can you start?", "when can you start"],
    ["What are your pay requirements?", "pay"],
  ])("flags under-detected cases: %s", (q, term) => {
    const r = classifyQuestionSensitivity(q);
    expect(r.sensitive).toBe(true);
    expect(r.matchedTerms.join(" ")).toContain(term);
  });

  it("does not flag ordinary role questions", () => {
    expect(classifyQuestionSensitivity("Why do you want to work at Acme?").sensitive).toBe(false);
    expect(classifyQuestionSensitivity("Describe a TypeScript project you led.").sensitive).toBe(false);
  });

  it("does not flag over-detected non-sensitive words", () => {
    expect(classifyQuestionSensitivity("Describe your management style").sensitive).toBe(false);
    expect(classifyQuestionSensitivity("Tell me about a time you had to collaborate").sensitive).toBe(false);
    expect(classifyQuestionSensitivity("What language do you code in?").sensitive).toBe(false);
    expect(classifyQuestionSensitivity("How do you manage competing priorities?").sensitive).toBe(false);
  });

  it("merge is widen-only", () => {
    const flagged = { sensitive: true, matchedTerms: ["salary"] };
    const clean = { sensitive: false, matchedTerms: [] };
    expect(mergeSensitivityRulings(flagged, false)).toBe(true);  // LLM can never narrow
    expect(mergeSensitivityRulings(clean, true)).toBe(true);     // LLM may widen
    expect(mergeSensitivityRulings(clean, null)).toBe(false);    // LLM failure → ruleset stands
    expect(mergeSensitivityRulings(clean, false)).toBe(false);
  });
});
