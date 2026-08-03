export interface SensitivityRuling {
  sensitive: boolean;
  matchedTerms: string[];
}

// Term with metadata for matching strategy
interface SensitiveTerm {
  term: string;
  // isSingleWord: true means use word-boundary matching; false = substring matching
  isSingleWord: boolean;
}

// Flattened keyword ruleset from spec §7.2.5 categories
// Single-word terms use word-boundary matching (\b); multi-word phrases use substring matching
const SENSITIVE_TERMS: SensitiveTerm[] = [
  // work authorization
  { term: "authorized to work", isSingleWord: false },
  { term: "work authorization", isSingleWord: false },
  { term: "visa", isSingleWord: true },
  { term: "sponsorship", isSingleWord: true },
  { term: "citizen", isSingleWord: true },
  { term: "citizenship", isSingleWord: true },
  { term: "right to work", isSingleWord: false },
  { term: "legally able to work", isSingleWord: false },
  { term: "eligible to work", isSingleWord: false },
  { term: "legally work", isSingleWord: false },
  // disability
  { term: "disability", isSingleWord: true },
  { term: "disabled", isSingleWord: true },
  { term: "accommodation", isSingleWord: true },
  // demographics
  { term: "gender", isSingleWord: true },
  { term: "race", isSingleWord: true },
  { term: "ethnicity", isSingleWord: true },
  { term: "veteran", isSingleWord: true },
  { term: "sexual orientation", isSingleWord: false },
  { term: "pronouns", isSingleWord: true },
  { term: "date of birth", isSingleWord: false },
  { term: "your age", isSingleWord: false },
  { term: "how old", isSingleWord: false },
  // criminal
  { term: "criminal", isSingleWord: true },
  { term: "felony", isSingleWord: true },
  { term: "convicted", isSingleWord: true },
  { term: "background check", isSingleWord: false },
  // compensation
  { term: "salary", isSingleWord: true },
  { term: "compensation", isSingleWord: true },
  { term: "pay expectation", isSingleWord: false },
  { term: "pay rate", isSingleWord: false },
  { term: "hourly rate", isSingleWord: false },
  { term: "day rate", isSingleWord: false },
  { term: "desired pay", isSingleWord: false },
  { term: "comp", isSingleWord: true },
  { term: "pay", isSingleWord: true },
  // availability
  { term: "notice period", isSingleWord: false },
  { term: "start date", isSingleWord: false },
  { term: "availability", isSingleWord: true },
  { term: "available to start", isSingleWord: false },
  { term: "when can you start", isSingleWord: false },
  { term: "earliest start", isSingleWord: false },
  // relocation
  { term: "relocate", isSingleWord: true },
  { term: "relocation", isSingleWord: true },
  { term: "willing to move", isSingleWord: false },
  // attestations
  { term: "certify", isSingleWord: true },
  { term: "attest", isSingleWord: true },
  { term: "acknowledge", isSingleWord: true },
  { term: "agree to the terms", isSingleWord: false },
  { term: "legal name", isSingleWord: false },
  { term: "signature", isSingleWord: true },
];

export function classifyQuestionSensitivity(question: string): SensitivityRuling {
  const lowerQuestion = question.toLowerCase();
  const matchedTerms: string[] = [];

  for (const { term, isSingleWord } of SENSITIVE_TERMS) {
    let matches = false;
    if (isSingleWord) {
      // Word-boundary matching for single words
      const regex = new RegExp(`\\b${term}\\b`);
      matches = regex.test(lowerQuestion);
    } else {
      // Substring matching for multi-word phrases
      matches = lowerQuestion.includes(term);
    }

    if (matches) {
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
