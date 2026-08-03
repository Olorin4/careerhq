import { describe, expect, it } from "vitest";
import {
  BLOCKER_KINDS, CANONICAL_FIELDS, canonicalFormFieldSchema, canonicalFormSchema, plannedAnswerSchema,
} from "./index.js";

describe("auto-apply contracts (spec §10.3)", () => {
  it("canonical field list covers every §10.3 category incl. sensitive ones", () => {
    for (const f of ["work_authorization", "visa_sponsorship", "desired_salary", "demographics", "criminal_history", "legal_attestation", "notice_period", "relocation"]) {
      expect(CANONICAL_FIELDS).toContain(f);
    }
  });
  it("form field defaults are conservative", () => {
    const f = canonicalFormFieldSchema.parse({ id: "a", kind: "text" });
    expect(f.canonicalField).toBe("unknown");
    expect(f.mappingConfidence).toBe(0);
    expect(f.sensitive).toBe(false);
    expect(f.required).toBe(false);
  });
  it("form requires url, requisitionKey, parserVersion and bounded confidence", () => {
    const base = { atsType: "greenhouse", parserVersion: "1", url: "https://x.example/a", requisitionKey: "k", fields: [], parseConfidence: 0.9 };
    expect(canonicalFormSchema.parse(base).totalSteps).toBe(1);
    expect(canonicalFormSchema.safeParse({ ...base, parseConfidence: 1.5 }).success).toBe(false);
    expect(canonicalFormSchema.safeParse({ ...base, url: "not-a-url" }).success).toBe(false);
  });
  it("planned answers default to not-needing-user and no diff", () => {
    const a = plannedAnswerSchema.parse({ fieldId: "a", value: "v", source: "fact", confidence: 0.9 });
    expect(a.needsUser).toBe(false);
    expect(a.differsFromApproved).toBe(false);
    expect(a.sourceFactIds).toEqual([]);
  });
  it("blocker kinds include every §10.6 pause reason", () => {
    expect(BLOCKER_KINDS).toEqual([
      "captcha", "login_required", "identity_verification", "assessment",
      "unsupported_file_control", "legal_attestation", "parse_failure",
    ]);
  });
});
