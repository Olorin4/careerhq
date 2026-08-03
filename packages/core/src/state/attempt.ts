import type { AttemptStatus } from "@careerhq/contracts";
import type { TransitionCheck } from "./application.js";

/**
 * BLOCKED is reachable from every pre-submission status, not only from
 * PENDING_CONFIRMATION: the company-site channel discovers its blockers
 * (captcha, sign-in wall, assessment, unsupported upload control) the moment
 * it first reads the page — long before any preview exists. BLOCKED means
 * "paused, over to you", so it is deliberately terminal: the user resolves the
 * page themselves, and a retry starts a fresh attempt rather than reanimating
 * this one.
 */
const ATTEMPT_EDGES: Partial<Record<AttemptStatus, AttemptStatus[]>> = {
  DRAFT: ["READY", "BLOCKED"],
  READY: ["PENDING_CONFIRMATION", "DRAFT", "BLOCKED"],
  PENDING_CONFIRMATION: ["SUBMITTING", "BLOCKED", "READY"],
  SUBMITTING: ["SUBMITTED", "FAILED", "NEEDS_RECONCILE"],
  NEEDS_RECONCILE: ["SUBMITTED", "FAILED"],
};

export function canAttemptTransition(from: AttemptStatus, to: AttemptStatus): TransitionCheck {
  return (ATTEMPT_EDGES[from] ?? []).includes(to)
    ? { ok: true }
    : { ok: false, reason: `no attempt transition ${from} → ${to}` };
}
