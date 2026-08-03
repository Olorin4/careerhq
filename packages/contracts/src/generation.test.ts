import { describe, expect, it } from "vitest";
import {
  APPROVAL_STATES, DOCUMENT_KINDS, generationResultSchema,
} from "./index.js";

describe("generation contracts (spec §7.2)", () => {
  it("generation result requires answer and bounds confidence to 0..1", () => {
    expect(generationResultSchema.safeParse({ answer: "", confidence: 0.9 }).success).toBe(false);
    expect(generationResultSchema.safeParse({ answer: "x", confidence: 1.2 }).success).toBe(false);
    const ok = generationResultSchema.parse({ answer: "x", confidence: 0.8 });
    expect(ok.factIds).toEqual([]);
    expect(ok.unsupportedClaims).toEqual([]);
  });
  it("document kinds and approval states are exact", () => {
    expect(DOCUMENT_KINDS).toEqual(["cover_letter", "email_body"]);
    expect(APPROVAL_STATES).toEqual(["draft", "approved", "rejected"]);
  });
});
