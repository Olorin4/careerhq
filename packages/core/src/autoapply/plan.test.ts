import { describe, expect, it } from "vitest";
import type { CanonicalForm, CanonicalFormField } from "@careerhq/contracts";
import { normalizeQuestion } from "../grounding/select-facts.js";
import {
  CONSENT_ONLY_FIELDS,
  MIN_FILL_CONFIDENCE,
  planAnswers,
  requiresUserBeforeSubmit,
  type PlanInputs,
  type ProfileValues,
  type SavedAnswerLike,
} from "./plan.js";

function field(overrides: Partial<CanonicalFormField> & { id: string }): CanonicalFormField {
  return {
    kind: "text",
    label: "",
    helpText: "",
    required: false,
    options: [],
    step: 0,
    canonicalField: "unknown",
    mappingConfidence: 0,
    sensitive: false,
    ...overrides,
  };
}

function form(fields: CanonicalFormField[]): CanonicalForm {
  return {
    atsType: "greenhouse",
    parserVersion: "test-1",
    url: "https://boards.example.com/acme/jobs/123",
    requisitionKey: "acme:123",
    title: "Senior Engineer",
    companyName: "Acme",
    totalSteps: 1,
    fields,
    blockers: [],
    parseConfidence: 0.9,
  };
}

const PROFILE: ProfileValues = {
  full_name: "Dana Rivers",
  first_name: "Dana",
  last_name: "Rivers",
  email: "dana@example.com",
  phone: "+1 555 0100",
  location: "Austin, United States",
  linkedin_url: "https://linkedin.com/in/dana",
  github_url: "https://github.com/dana",
  portfolio_url: "https://dana.dev",
  current_company: "Globex",
  current_title: "Staff Engineer",
};

function inputs(overrides: Partial<PlanInputs> & { form: CanonicalForm }): PlanInputs {
  return {
    profile: PROFILE,
    savedAnswers: [],
    resumeDocumentId: null,
    previouslyApproved: {},
    ...overrides,
  };
}

function answerFor(result: { answers: { fieldId: string }[] }, fieldId: string) {
  const found = result.answers.find((a) => a.fieldId === fieldId);
  if (!found) throw new Error(`no planned answer for ${fieldId}`);
  return found as (typeof result.answers)[number] & Record<string, unknown>;
}

const WORK_AUTH_LABEL = "Are you legally authorized to work in the United States?";

describe("planAnswers — rule 1: sensitive fields", () => {
  it("never auto-fills a sensitive select even when a plausible profile value exists", () => {
    const result = planAnswers(
      inputs({
        form: form([
          field({
            id: "f_workauth",
            kind: "select",
            label: WORK_AUTH_LABEL,
            required: true,
            canonicalField: "work_authorization",
            mappingConfidence: 0.9,
            options: [
              { value: "yes", label: "Yes" },
              { value: "no", label: "No" },
            ],
          }),
        ]),
      }),
    );

    const answer = answerFor(result, "f_workauth");
    expect(answer.needsUser).toBe(true);
    expect(answer.source).toBe("user");
    expect(answer.source).not.toBe("ai");
    expect(answer.value).toBe("");
    expect(answer.confidence).toBe(0);
  });

  it("fills a sensitive field from an exact saved answer instead of asking the user", () => {
    const saved: SavedAnswerLike = {
      questionNorm: "are you legally authorized to work in the united states",
      answer: "Yes",
      sourceFactIds: ["fact_workauth"],
      staleForReuse: false,
    };
    const result = planAnswers(
      inputs({
        form: form([
          field({
            id: "f_workauth",
            kind: "select",
            label: WORK_AUTH_LABEL,
            canonicalField: "work_authorization",
            mappingConfidence: 0.9,
          }),
        ]),
        savedAnswers: [saved],
      }),
    );

    const answer = answerFor(result, "f_workauth");
    expect(answer.source).toBe("saved_answer");
    expect(answer.needsUser).toBe(false);
    expect(answer.value).toBe("Yes");
    expect(answer.sourceFactIds).toEqual(["fact_workauth"]);
    expect(result.unresolved).toEqual([]);
  });

  it("treats a sensitive label identically whether or not the adapter mapped a canonicalField", () => {
    // CARRIED NOTE: the Greenhouse adapter now maps work_authorization at 0.9; behaviour must be
    // identical to the pre-mapping "unknown" case — the label ruleset alone is enough.
    const mapped = planAnswers(
      inputs({
        form: form([
          field({
            id: "f_workauth",
            kind: "select",
            label: WORK_AUTH_LABEL,
            canonicalField: "work_authorization",
            mappingConfidence: 0.9,
          }),
        ]),
      }),
    );
    const unmapped = planAnswers(
      inputs({
        form: form([
          field({
            id: "f_workauth",
            kind: "select",
            label: WORK_AUTH_LABEL,
            canonicalField: "unknown",
            mappingConfidence: 0,
          }),
        ]),
      }),
    );

    for (const result of [mapped, unmapped]) {
      const answer = answerFor(result, "f_workauth");
      expect(answer.needsUser).toBe(true);
      expect(answer.source).toBe("user");
      expect(answer.source).not.toBe("ai");
      expect(answer.confidence).toBe(0);
      expect(answer.value).toBe("");
    }
    expect(answerFor(mapped, "f_workauth")).toEqual(answerFor(unmapped, "f_workauth"));
  });

  it("never emits source ai for any sensitive canonical field", () => {
    const sensitiveFields: CanonicalFormField[] = [
      field({ id: "f_visa", label: "Will you require sponsorship?", canonicalField: "visa_sponsorship" }),
      field({ id: "f_salary", label: "Desired base?", canonicalField: "desired_salary" }),
      field({ id: "f_demo", label: "Optional survey", canonicalField: "demographics" }),
      field({ id: "f_crim", label: "Any prior records?", canonicalField: "criminal_history" }),
      field({ id: "f_legal", label: "Confirm the statements below", canonicalField: "legal_attestation" }),
      field({ id: "f_notice", label: "How long until you could join?", canonicalField: "notice_period" }),
      field({ id: "f_avail", label: "Earliest join window", canonicalField: "availability" }),
      field({ id: "f_reloc", label: "Would you move for the role?", canonicalField: "relocation" }),
    ];
    const result = planAnswers(inputs({ form: form(sensitiveFields) }));

    expect(result.answers).toHaveLength(sensitiveFields.length);
    for (const answer of result.answers) {
      expect(answer.source).toBe("user");
      expect(answer.needsUser).toBe(true);
      expect(answer.confidence).toBe(0);
    }
  });
});

describe("planAnswers — rule 1a: consent-only fields are never reused across applications", () => {
  it("never reuses a saved answer for a legal attestation — consent must be fresh", () => {
    const label = "I certify that the information provided is accurate";
    const result = planAnswers(
      inputs({
        form: form([
          field({
            id: "ack",
            kind: "checkbox",
            required: true,
            label,
            canonicalField: "legal_attestation",
            mappingConfidence: 0.9,
          }),
        ]),
        savedAnswers: [
          {
            questionNorm: normalizeQuestion(label),
            answer: "true",
            sourceFactIds: [],
            staleForReuse: false,
          },
        ],
      }),
    );

    const answer = answerFor(result, "ack");
    expect(answer.source).toBe("user");
    expect(answer.needsUser).toBe(true);
    expect(answer.value).toBe("");
  });

  it("never reuses a saved answer for criminal history", () => {
    const label = "Have you ever been convicted of a felony?";
    const result = planAnswers(
      inputs({
        form: form([
          field({
            id: "ch",
            kind: "select",
            required: true,
            label,
            canonicalField: "criminal_history",
            mappingConfidence: 0.9,
          }),
        ]),
        savedAnswers: [
          {
            questionNorm: normalizeQuestion(label),
            answer: "No",
            sourceFactIds: [],
            staleForReuse: false,
          },
        ],
      }),
    );

    const answer = answerFor(result, "ch");
    expect(answer.source).toBe("user");
    expect(answer.needsUser).toBe(true);
  });

  it("still reuses a saved answer for other sensitive fields (e.g. notice period)", () => {
    const label = "What is your notice period?";
    const result = planAnswers(
      inputs({
        form: form([
          field({
            id: "np",
            kind: "text",
            required: true,
            label,
            canonicalField: "notice_period",
            mappingConfidence: 0.9,
          }),
        ]),
        savedAnswers: [
          {
            questionNorm: normalizeQuestion(label),
            answer: "Two weeks",
            sourceFactIds: [],
            staleForReuse: false,
          },
        ],
      }),
    );

    const answer = answerFor(result, "np");
    expect(answer.source).toBe("saved_answer");
    expect(answer.needsUser).toBe(false);
  });

  it("names exactly the two consent-only canonical fields", () => {
    expect([...CONSENT_ONLY_FIELDS].sort()).toEqual(["criminal_history", "legal_attestation"]);
  });
});

describe("planAnswers — rule 2: file fields", () => {
  it("plans the resume file from the document id", () => {
    const result = planAnswers(
      inputs({
        form: form([
          field({ id: "f_resume", kind: "file", label: "Resume", required: true, canonicalField: "resume_file", mappingConfidence: 1 }),
        ]),
        resumeDocumentId: "cv_variant_42",
      }),
    );

    const answer = answerFor(result, "f_resume");
    expect(answer.source).toBe("document");
    expect(answer.value).toBe("cv_variant_42");
    expect(answer.confidence).toBe(1);
    expect(answer.needsUser).toBe(false);
  });

  it("asks the user when no resume document is available", () => {
    const result = planAnswers(
      inputs({
        form: form([
          field({ id: "f_resume", kind: "file", label: "Resume", required: true, canonicalField: "resume_file", mappingConfidence: 1 }),
        ]),
        resumeDocumentId: null,
      }),
    );

    const answer = answerFor(result, "f_resume");
    expect(answer.needsUser).toBe(true);
    expect(answer.source).toBe("user");
    expect(answer.value).toBe("");
  });
});

describe("planAnswers — rule 3: profile-mapped fields", () => {
  it("fills a confidently mapped profile field", () => {
    const result = planAnswers(
      inputs({
        form: form([
          field({ id: "f_email", kind: "email", label: "Email", required: true, canonicalField: "email", mappingConfidence: 0.95 }),
        ]),
      }),
    );

    const answer = answerFor(result, "f_email");
    expect(answer.source).toBe("profile");
    expect(answer.value).toBe("dana@example.com");
    expect(answer.confidence).toBe(0.95);
    expect(answer.needsUser).toBe(false);
  });

  it("flags a low-confidence (0.5) profile mapping for the user", () => {
    const result = planAnswers(
      inputs({
        form: form([
          field({ id: "f_loc", label: "Where are you based?", canonicalField: "location", mappingConfidence: 0.5 }),
        ]),
      }),
    );

    const answer = answerFor(result, "f_loc");
    expect(answer.source).toBe("profile");
    expect(answer.value).toBe("Austin, United States");
    expect(answer.confidence).toBe(0.5);
    expect(answer.confidence).toBeLessThan(MIN_FILL_CONFIDENCE);
    expect(answer.needsUser).toBe(true);
  });

  it("falls through to the user when the profile has no value for the mapping", () => {
    const result = planAnswers(
      inputs({
        form: form([
          field({ id: "f_gh", kind: "url", label: "GitHub", canonicalField: "github_url", mappingConfidence: 0.9 }),
        ]),
        profile: { email: "dana@example.com" },
      }),
    );

    const answer = answerFor(result, "f_gh");
    expect(answer.source).toBe("user");
    expect(answer.needsUser).toBe(true);
    expect(result.unresolved).toEqual(["f_gh"]);
  });
});

describe("planAnswers — rule 4: saved answers", () => {
  it("reuses an exact saved answer for a screening question", () => {
    const result = planAnswers(
      inputs({
        form: form([
          field({
            id: "f_why",
            kind: "textarea",
            label: "Why do you want to work at Acme?",
            canonicalField: "screening_question",
            mappingConfidence: 0.8,
          }),
        ]),
        savedAnswers: [
          {
            questionNorm: "why do you want to work at acme",
            answer: "Because of the platform work.",
            sourceFactIds: ["fact_a", "fact_b"],
            staleForReuse: false,
          },
        ],
      }),
    );

    const answer = answerFor(result, "f_why");
    expect(answer.source).toBe("saved_answer");
    expect(answer.confidence).toBe(0.9);
    expect(answer.needsUser).toBe(false);
    expect(answer.value).toBe("Because of the platform work.");
    expect(answer.sourceFactIds).toEqual(["fact_a", "fact_b"]);
    expect(result.unresolved).toEqual([]);
  });

  it("flags a stale saved answer for review with a note", () => {
    const result = planAnswers(
      inputs({
        form: form([
          field({
            id: "f_why",
            kind: "textarea",
            label: "Why do you want to work at Acme?",
            canonicalField: "screening_question",
            mappingConfidence: 0.8,
          }),
        ]),
        savedAnswers: [
          {
            questionNorm: "why do you want to work at acme",
            answer: "Because of the platform work.",
            sourceFactIds: ["fact_a"],
            staleForReuse: true,
          },
        ],
      }),
    );

    const answer = answerFor(result, "f_why");
    expect(answer.source).toBe("saved_answer");
    expect(answer.needsUser).toBe(true);
    expect(answer.note).toBe("saved answer past review date");
    expect(answer.value).toBe("Because of the platform work.");
  });

  it("marks differsFromApproved when the planned value differs from the previously approved one", () => {
    const formFields = form([
      field({
        id: "f_why",
        kind: "textarea",
        label: "Why do you want to work at Acme?",
        canonicalField: "screening_question",
        mappingConfidence: 0.8,
      }),
    ]);
    const savedAnswers: SavedAnswerLike[] = [
      {
        questionNorm: "why do you want to work at acme",
        answer: "Because of the platform work.",
        sourceFactIds: [],
        staleForReuse: false,
      },
    ];

    const differs = planAnswers(
      inputs({
        form: formFields,
        savedAnswers,
        previouslyApproved: { "why do you want to work at acme": "An older approved answer." },
      }),
    );
    expect(answerFor(differs, "f_why").differsFromApproved).toBe(true);

    const same = planAnswers(
      inputs({
        form: formFields,
        savedAnswers,
        previouslyApproved: { "why do you want to work at acme": "Because of the platform work." },
      }),
    );
    expect(answerFor(same, "f_why").differsFromApproved).toBe(false);
  });
});

describe("planAnswers — rule 5: fallback", () => {
  it("lists an unmapped custom textarea as unresolved and needing the user", () => {
    const result = planAnswers(
      inputs({
        form: form([
          field({
            id: "f_custom",
            kind: "textarea",
            label: "Describe a system you designed end to end.",
            canonicalField: "unknown",
            mappingConfidence: 0,
          }),
        ]),
      }),
    );

    const answer = answerFor(result, "f_custom");
    expect(answer.needsUser).toBe(true);
    expect(answer.source).toBe("user");
    expect(answer.confidence).toBe(0);
    expect(answer.value).toBe("");
    expect(result.unresolved).toEqual(["f_custom"]);
  });

  it("never lists a sensitive field as unresolved (no AI drafting candidate)", () => {
    const result = planAnswers(
      inputs({
        form: form([
          field({ id: "f_salary", kind: "text", label: "What are your salary expectations?" }),
          field({ id: "f_custom", kind: "textarea", label: "Describe a system you designed." }),
        ]),
      }),
    );

    expect(result.unresolved).toEqual(["f_custom"]);
  });
});

describe("requiresUserBeforeSubmit", () => {
  it("lists required fields with an empty answer", () => {
    const target = form([
      field({ id: "f_email", kind: "email", label: "Email", required: true, canonicalField: "email", mappingConfidence: 0.95 }),
      field({ id: "f_resume", kind: "file", label: "Resume", required: true, canonicalField: "resume_file", mappingConfidence: 1 }),
    ]);
    const result = planAnswers(inputs({ form: target, resumeDocumentId: null }));

    expect(requiresUserBeforeSubmit(result.answers, target)).toEqual(["f_resume"]);
  });

  it("returns [] for a fully planned form", () => {
    const target = form([
      field({ id: "f_name", label: "Full name", required: true, canonicalField: "full_name", mappingConfidence: 0.95 }),
      field({ id: "f_email", kind: "email", label: "Email", required: true, canonicalField: "email", mappingConfidence: 0.95 }),
      field({ id: "f_resume", kind: "file", label: "Resume", required: true, canonicalField: "resume_file", mappingConfidence: 1 }),
    ]);
    const result = planAnswers(inputs({ form: target, resumeDocumentId: "cv_variant_42" }));

    expect(requiresUserBeforeSubmit(result.answers, target)).toEqual([]);
  });

  it("blocks on any field still needing the user", () => {
    const target = form([
      field({ id: "f_workauth", kind: "select", label: WORK_AUTH_LABEL, canonicalField: "work_authorization", mappingConfidence: 0.9 }),
    ]);
    const result = planAnswers(inputs({ form: target }));

    expect(requiresUserBeforeSubmit(result.answers, target)).toEqual(["f_workauth"]);
  });

  it("blocks a sensitive field that somehow carries an ai answer (belt-and-braces invariant)", () => {
    const target = form([
      field({ id: "f_salary", kind: "text", label: "What are your salary expectations?" }),
    ]);
    const smuggled = [
      {
        fieldId: "f_salary",
        value: "$180,000",
        source: "ai" as const,
        sourceFactIds: [],
        confidence: 0.99,
        needsUser: false,
        differsFromApproved: false,
        note: "",
      },
    ];

    expect(requiresUserBeforeSubmit(smuggled, target)).toEqual(["f_salary"]);
  });

  it("blocks a required field that has no planned answer at all", () => {
    const target = form([field({ id: "f_email", kind: "email", label: "Email", required: true })]);

    expect(requiresUserBeforeSubmit([], target)).toEqual(["f_email"]);
  });

  it("never blocks on a hidden input — CSRF/utm/tracking fields are not user-answerable", () => {
    const target = form([
      field({ id: "f_email", kind: "email", label: "Email", required: true, canonicalField: "email", mappingConfidence: 0.95 }),
      // Exactly what a real ATS page carries: a required CSRF token and a
      // tracking parameter, neither of which any human can be asked to fill.
      field({ id: "f_csrf", kind: "hidden", label: "authenticity_token", required: true }),
      field({ id: "f_utm", kind: "hidden", label: "utm_source" }),
    ]);
    const result = planAnswers(inputs({ form: target }));

    // The planner still hands them back flagged (rule 5 fallthrough) …
    expect(answerFor(result, "f_csrf").needsUser).toBe(true);
    expect(answerFor(result, "f_utm").needsUser).toBe(true);
    // … but the submit gate ignores them, or Preview could never be enabled on
    // any real form.
    expect(requiresUserBeforeSubmit(result.answers, target)).toEqual([]);
  });

  it("still blocks a hidden field's visible neighbours", () => {
    const target = form([
      field({ id: "f_csrf", kind: "hidden", label: "authenticity_token", required: true }),
      field({ id: "f_notes", kind: "textarea", label: "Anything else?", required: true }),
    ]);
    const result = planAnswers(inputs({ form: target }));

    expect(requiresUserBeforeSubmit(result.answers, target)).toEqual(["f_notes"]);
  });
});
