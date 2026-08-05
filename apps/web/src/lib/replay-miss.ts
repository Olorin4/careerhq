/**
 * Human copy for the one internal token a hosted-demo visitor can reach.
 *
 * The demo deploys `AI_MODE=replay` with no `OPENROUTER_API_KEY`, so every AI
 * answer comes out of a committed fixture keyed by a hash of the prompt. A
 * prompt with no fixture ends as `{ status: "failed", error: "replay_miss" }`,
 * and Task 12 found the consequence: the materials panel rendered
 * "Generation failed: replay_miss" verbatim, which reads as a crash rather than
 * as the deliberate limit it is.
 *
 * The token itself is deliberately unchanged — it is what the server logs, what
 * `withReplay` returns and what the tests assert on. Only the *rendering*
 * changes, and only when this deployment is a replay-backed demo: a self-hoster
 * with a real key never reaches this path, and one running replay deliberately
 * is better served by the token.
 */

/** `withReplay`'s "no fixture matched this prompt" error. */
export const REPLAY_MISS = "replay_miss";

/**
 * The application the recorded walkthrough is built around (the README and
 * `docs/runbook-demo.md` both name it), so a miss can point somewhere that
 * definitely works instead of leaving the visitor guessing.
 */
const WALKTHROUGH_APPLICATION = "Wexford Health · Founding Engineer";

const SHARED_PREAMBLE =
  "This hosted demo has no AI key: it answers from AI output recorded ahead of time, " +
  "and makes no live model calls.";

/**
 * `document` covers the materials panel (cover letter, email body), where every
 * seeded application is recorded — so a miss there means the request is not one
 * of the seeded ones. `question` covers the Q&A panel, where the question is
 * free text and only the walkthrough's own screening question is recorded.
 */
export function replayMissMessage(kind: "document" | "question"): string {
  if (kind === "question") {
    return (
      `${SHARED_PREAMBLE} Only the walkthrough's own screening question is recorded — ` +
      `ask “Why do you want to work here?” on the ${WALKTHROUGH_APPLICATION} application ` +
      "to see a grounded answer, or run CareerHQ yourself with an OpenRouter key to ask anything."
    );
  }
  return (
    `${SHARED_PREAMBLE} Every application seeded into this demo has a recorded cover letter ` +
    `and email body, but this one is not among them — try the ${WALKTHROUGH_APPLICATION} ` +
    "application, or run CareerHQ yourself with an OpenRouter key to generate freely."
  );
}
