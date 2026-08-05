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
 *
 * SUBMITTING → PENDING_CONFIRMATION is the one edge that walks BACKWARDS, and
 * it exists for the one case in which "in flight" turned out to be false: the
 * driver refused with a provably PRE-CLICK `DriverError` (`navigation`/`fill`),
 * so no button was ever pressed, nothing left the browser, and the attempt is
 * exactly where it was before `beginSubmission` moved it. Walking it back is
 * what lets the confirmation be handed back unspent instead of the visitor
 * losing their token to a refusal (P6 final review, BLOCKING 1).
 *
 * Its only caller is `abandonSubmission` in packages/db (`repos/attempts.ts`),
 * which un-consumes the confirmation in the same transaction; the *ambiguous*
 * post-click outcomes still have exactly the two exits they had before,
 * SUBMITTED/FAILED via NEEDS_RECONCILE. Nothing here decides which side of the
 * click a failure came from — `PRE_CLICK_DRIVER_ERROR_KINDS` in
 * apps/web/src/lib/site-submission.ts is the only place that judgement is made,
 * and it is deliberately narrow.
 */
const ATTEMPT_EDGES: Partial<Record<AttemptStatus, AttemptStatus[]>> = {
  DRAFT: ["READY", "BLOCKED"],
  READY: ["PENDING_CONFIRMATION", "DRAFT", "BLOCKED"],
  PENDING_CONFIRMATION: ["SUBMITTING", "BLOCKED", "READY"],
  SUBMITTING: ["SUBMITTED", "FAILED", "NEEDS_RECONCILE", "PENDING_CONFIRMATION"],
  NEEDS_RECONCILE: ["SUBMITTED", "FAILED"],
};

export function canAttemptTransition(from: AttemptStatus, to: AttemptStatus): TransitionCheck {
  return (ATTEMPT_EDGES[from] ?? []).includes(to)
    ? { ok: true }
    : { ok: false, reason: `no attempt transition ${from} → ${to}` };
}
