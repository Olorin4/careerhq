export interface SensitivityRuling {
  sensitive: boolean;
  matchedTerms: string[];
}

// Flattened keyword ruleset from spec §7.2.5 categories
// All terms are matched case-insensitively via substring matching
const SENSITIVE_TERMS = [
  // work authorization
  "authorized to work",
  "work authorization",
  "visa",
  "sponsorship",
  "citizen",
  "citizenship",
  "right to work",
  // disability
  "disability",
  "disabled",
  "accommodation",
  // demographics
  "gender",
  "race",
  "ethnicity",
  "veteran",
  "sexual orientation",
  "pronouns",
  "date of birth",
  "age",
  // criminal
  "criminal",
  "felony",
  "convicted",
  "background check",
  // compensation
  "salary",
  "compensation",
  "pay expectation",
  "rate",
  "desired pay",
  // availability
  "notice period",
  "start date",
  "availability",
  "available to start",
  // relocation
  "relocate",
  "relocation",
  "willing to move",
  // attestations
  "certify",
  "attest",
  "acknowledge",
  "agree to the terms",
  "legal name",
  "signature",
];

export function classifyQuestionSensitivity(question: string): SensitivityRuling {
  const lowerQuestion = question.toLowerCase();
  const matchedTerms: string[] = [];

  for (const term of SENSITIVE_TERMS) {
    if (lowerQuestion.includes(term)) {
      matchedTerms.push(term);
    }
  }

  return {
    sensitive: matchedTerms.length > 0,
    matchedTerms,
  };
}

export function mergeSensitivityRulings(
  ruleset: SensitivityRuling,
  llmSaysSensitive: boolean | null
): boolean {
  // Widen-only merge:
  // - If ruleset says sensitive, always return true (LLM can never narrow)
  // - If ruleset says not sensitive but LLM says sensitive, return true (LLM may widen)
  // - If LLM says null or false, ruleset stands
  if (ruleset.sensitive) {
    return true;
  }
  if (llmSaysSensitive === true) {
    return true;
  }
  return false;
}
