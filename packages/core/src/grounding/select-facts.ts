import { FACT_CATEGORIES, type FactCategory, type Sensitivity } from "@careerhq/contracts";

export interface FactForSelection {
  id: string;
  category: FactCategory;
  claim: string;
  detail: string | null;
  sensitivity: Sensitivity;
  stale: boolean;
}

export interface SelectionContext {
  question?: string;
  jobTitle: string;
  jobDescription?: string | null;
}

export const MAX_GENERATION_FACTS = 12;

export function normalizeQuestion(question: string): string {
  // lowercase, strip punctuation, collapse whitespace
  return question
    .toLowerCase()
    .replace(/[^\w\s]/g, "") // strip punctuation
    .trim()
    .replace(/\s+/g, " "); // collapse whitespace
}

function extractWords(text: string | null | undefined): Set<string> {
  if (!text) return new Set();
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, "") // strip punctuation
    .split(/\s+/)
    .filter((word) => word.length >= 4); // only words with length >= 4
  return new Set(words);
}

function scoreFactRelevance(fact: FactForSelection, context: SelectionContext): number {
  // Get baseline score for experience and skill categories
  const baseline = fact.category === "experience" || fact.category === "skill" ? 1 : 0;

  // Build the corpus from claim + detail
  const factWords = extractWords(`${fact.claim} ${fact.detail ?? ""}`);

  // Build the context corpus from question + jobTitle + jobDescription
  const contextWords = extractWords(`${context.question ?? ""} ${context.jobTitle} ${context.jobDescription ?? ""}`);

  // Count distinct shared words
  const sharedWords = Array.from(factWords).filter((word) => contextWords.has(word)).length;

  return sharedWords + baseline;
}

export function selectFactsForGeneration(
  facts: FactForSelection[],
  context: SelectionContext,
  opts?: { maxFacts?: number },
): FactForSelection[] {
  const maxFacts = opts?.maxFacts ?? MAX_GENERATION_FACTS;

  // Step 1: Hard-exclude sensitive and stale facts
  const filtered = facts.filter((fact) => fact.sensitivity !== "sensitive" && !fact.stale);

  // Step 2: Score each fact
  const scored = filtered.map((fact) => ({
    fact,
    score: scoreFactRelevance(fact, context),
  }));

  // Step 3: Drop facts with score 0 and no baseline (experience/skill categories)
  const viable = scored.filter((item) => {
    const hasBaseline = item.fact.category === "experience" || item.fact.category === "skill";
    return item.score > 0 || hasBaseline;
  });

  // Step 4: Sort by score DESC, then category order (FACT_CATEGORIES array order), then claim ASC
  const getCategoryIndex = (cat: FactCategory): number => {
    const idx = FACT_CATEGORIES.indexOf(cat);
    return idx === -1 ? FACT_CATEGORIES.length : idx;
  };

  const sorted = viable.sort((a, b) => {
    // Score DESC
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    // Category order (FACT_CATEGORIES array order)
    const catIndexA = getCategoryIndex(a.fact.category);
    const catIndexB = getCategoryIndex(b.fact.category);
    if (catIndexA !== catIndexB) {
      return catIndexA - catIndexB;
    }
    // Claim ASC. Locale pinned to "en": tie order feeds prompts feeds replay
    // hashes, so host-locale collation must not vary generation output
    // across machines.
    return a.fact.claim.localeCompare(b.fact.claim, "en");
  });

  // Step 5: Take top maxFacts
  return sorted.slice(0, maxFacts).map((item) => item.fact);
}
