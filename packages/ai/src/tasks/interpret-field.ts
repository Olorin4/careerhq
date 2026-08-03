import {
  CANONICAL_FIELDS,
  interpretFieldResultSchema,
  type CanonicalField,
  type FieldKind,
  type InterpretFieldResult,
} from "@careerhq/contracts";
import { chatJsonWithFallback, type FallbackOptions, type FallbackResult } from "../client/fallback.js";

export interface InterpretFieldInput {
  label: string;
  nearbyText: string;
  kind: FieldKind;
  options: Array<{ value: string; label: string }>;
  jobTitle: string;
  companyName: string;
}

/**
 * Sensitive canonical fields that should not be guessed unless the label
 * unambiguously indicates them.
 */
const SENSITIVE_FIELDS: readonly CanonicalField[] = [
  "work_authorization",
  "visa_sponsorship",
  "desired_salary",
  "demographics",
  "criminal_history",
  "legal_attestation",
];

function isSensitive(field: CanonicalField): boolean {
  return SENSITIVE_FIELDS.includes(field);
}

const SYSTEM_PROMPT = `You interpret form fields and map them to canonical field categories.

You must return ONLY JSON matching this exact shape, with no prose, no markdown fences, and no extra keys:
{"canonicalField","confidence"}

Canonical fields are exactly one of:
${CANONICAL_FIELDS.map((f) => `- ${f}`).join("\n")}

Rules:
- Map the described form field to exactly one canonical field above.
- "confidence" is a number from 0 to 1 expressing how sure you are of the mapping.
- Answer "unknown" when you cannot confidently map the field to a canonical category.
- IMPORTANT: NEVER guess a sensitive category unless the field label unambiguously indicates it. Sensitive categories are: work_authorization, visa_sponsorship, desired_salary, demographics, criminal_history, legal_attestation. Default to "unknown" if unsure.`;

export function buildInterpretPrompt(input: InterpretFieldInput): { system: string; user: string } {
  const optionsText = input.options.length > 0
    ? `\nOptions: ${input.options.map((o) => `"${o.value}" (${o.label})`).join(", ")}`
    : "";

  const user = [
    `Company: ${input.companyName}`,
    `Job Title: ${input.jobTitle}`,
    "",
    `Field Type: ${input.kind}`,
    `Field Label: ${input.label}`,
    `Nearby Text: ${input.nearbyText}${optionsText}`,
  ].join("\n");

  return { system: SYSTEM_PROMPT, user };
}

/**
 * Fast-tier interpretation of a form field to a canonical field category.
 * Rejects low-confidence guesses for sensitive fields.
 * Never throws: every failure comes back as a not-ok result.
 */
export async function interpretField(
  input: InterpretFieldInput,
  opts: FallbackOptions,
): Promise<FallbackResult<InterpretFieldResult>> {
  const { system, user } = buildInterpretPrompt(input);

  return chatJsonWithFallback<InterpretFieldResult>(
    {
      system,
      user,
      schema: interpretFieldResultSchema,
      isUseful: (value) => {
        // Accept any non-sensitive field
        if (!isSensitive(value.canonicalField)) {
          return true;
        }

        // Accept "unknown" at any confidence
        if (value.canonicalField === "unknown") {
          return true;
        }

        // For sensitive fields, require confidence >= 0.8
        return value.confidence >= 0.8;
      },
    },
    opts,
  );
}
