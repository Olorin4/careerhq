import {
  classifyReplyResultSchema, type ApplicationState, type ClassifyReplyResult,
} from "@careerhq/contracts";
import { chatJsonWithFallback, type FallbackOptions, type FallbackResult } from "../client/fallback.js";

export interface ClassifyReplyInput {
  subject: string;
  /** The message's leading text, already trimmed by the caller (<=300 chars). */
  snippet: string;
  companyName: string;
  jobTitle: string;
  /** The application's current state, so the model can judge what a reply would mean. */
  applicationState: string;
}

/**
 * The only states a reply may propose. The contract schema accepts every
 * `ApplicationState` (it is the shared enum), so this narrower rule — the
 * states the machine can actually reach off the back of a classification — is
 * enforced as a usefulness check on the result instead.
 */
const SUGGESTABLE_STATES: readonly ApplicationState[] = [
  "ACKNOWLEDGED", "INTERVIEW", "REJECTED", "OFFER",
];

const SYSTEM_PROMPT = `You classify a single reply email received in response to a job application.

You must return ONLY JSON matching this exact shape, with no prose, no markdown fences, and no extra keys:
{"classification","confidence","suggestedState","quotedEvidence"}

Rules:
- "classification" is exactly one of: ack, recruiter, interview, rejection, offer, unrelated.
  - ack: an automated or human acknowledgement that the application was received, with no decision yet.
  - recruiter: a human recruiter writing about this application without scheduling or deciding anything.
  - interview: an invitation to interview, screen, or schedule a call.
  - rejection: the application was declined.
  - offer: an offer of employment.
  - unrelated: anything that is not a reply about this application (newsletters, spam, bounces).
- "confidence" is a number from 0 to 1 expressing how sure you are of the classification.
- "suggestedState" is the application state this reply implies, and may ONLY be one of:
  ACKNOWLEDGED, INTERVIEW, REJECTED, OFFER. Omit the key entirely when the reply implies no change.
- "quotedEvidence" is a short verbatim phrase copied exactly from the message that justifies the
  classification. Never paraphrase, summarise, or invent it; use an empty string if the message has none.`;

export function buildClassifyPrompt(msg: ClassifyReplyInput): { system: string; user: string } {
  const user = [
    `Company: ${msg.companyName}`,
    `Role applied for: ${msg.jobTitle}`,
    `Current application state: ${msg.applicationState}`,
    "",
    `Reply subject: ${msg.subject}`,
    "Reply body:",
    msg.snippet,
  ].join("\n");

  return { system: SYSTEM_PROMPT, user };
}

/**
 * Fast-tier classification of an inbound reply, falling back across models.
 * Never throws: every failure — including a model that proposes a state the
 * application machine cannot reach — comes back as a not-ok result, and the
 * caller stores the message unclassified.
 */
export async function classifyReply(
  msg: ClassifyReplyInput,
  opts: FallbackOptions,
): Promise<FallbackResult<ClassifyReplyResult>> {
  const { system, user } = buildClassifyPrompt(msg);

  return chatJsonWithFallback<ClassifyReplyResult>(
    {
      system,
      user,
      schema: classifyReplyResultSchema,
      isUseful: (value) =>
        value.suggestedState === undefined || SUGGESTABLE_STATES.includes(value.suggestedState),
    },
    opts,
  );
}
