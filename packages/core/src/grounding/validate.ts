import type { GenerationResult } from "@careerhq/contracts";

export const MIN_GENERATION_CONFIDENCE = 0.6;

export type GenerationValidation =
  | { ok: true }
  | { ok: false; status: "needs_facts"; reasons: string[] };

export function validateGeneration(
  result: GenerationResult,
  providedFactIds: readonly string[],
): GenerationValidation {
  const reasons: string[] = [];
  const providedFactIdSet = new Set(providedFactIds);

  // Check 1: cited factId not in provided subset
  for (const factId of result.factIds) {
    if (!providedFactIdSet.has(factId)) {
      reasons.push(`cites unknown fact ${factId}`);
    }
  }

  // Check 2: factIds empty
  if (result.factIds.length === 0) {
    reasons.push("no supporting facts cited");
  }

  // Check 3: unsupportedClaims non-empty
  if (result.unsupportedClaims.length > 0) {
    reasons.push(`model reported unsupported claims: ${result.unsupportedClaims.join(", ")}`);
  }

  // Check 4: confidence < MIN_GENERATION_CONFIDENCE
  if (result.confidence < MIN_GENERATION_CONFIDENCE) {
    reasons.push(`confidence ${result.confidence} below threshold ${MIN_GENERATION_CONFIDENCE}`);
  }

  // Check 5: clarificationNeeded present
  if (result.clarificationNeeded) {
    reasons.push(`model requests clarification: ${result.clarificationNeeded}`);
  }

  if (reasons.length > 0) {
    return { ok: false, status: "needs_facts", reasons };
  }

  return { ok: true };
}
