import { z } from "zod";
import { chatJsonWithFallback, type FallbackOptions } from "../client/fallback.js";

const sensitiveResultSchema = z.object({ sensitive: z.boolean() });
type SensitiveResult = z.infer<typeof sensitiveResultSchema>;

const SYSTEM_PROMPT = `You classify whether answering a candidate's question would require personal, legal, compensation, availability, or demographic information (for example: salary history, visa/work-authorization status, disability, age, race, religion, pregnancy, family plans, criminal history, or notice-period negotiations).

You must return ONLY JSON matching this exact shape, with no prose, no markdown fences, and no extra keys:
{"sensitive":true or false}`;

/**
 * Fast-tier LLM tie-break for whether a question is sensitive. Returns null
 * on any failure so the caller's rule-based classification stands — this is
 * a widen-only floor, never a way to loosen an already-sensitive verdict.
 */
export async function classifySensitiveLlm(
  question: string,
  opts: FallbackOptions,
): Promise<boolean | null> {
  const result = await chatJsonWithFallback<SensitiveResult>(
    {
      system: SYSTEM_PROMPT,
      user: question,
      schema: sensitiveResultSchema,
    },
    opts,
  );

  return result.ok && result.value ? result.value.sensitive : null;
}
