import type {
  ApplicationState, ApprovalState, AttemptStatus, ReplyClassification,
} from "@careerhq/contracts";
import type { BadgeTone } from "../components/badge.js";

/**
 * Colour per funnel stage, following the design spec's own vocabulary table
 * (`docs/superpowers/specs/2026-08-05-ui-design-system-design.md`): who acts
 * next, not how the stage "feels". DISCOVERED needs nobody yet (neutral);
 * SHORTLISTED/PREPARING are the pipeline working automatically (info);
 * READY_FOR_REVIEW is one stage that is, by name, waiting on the applicant
 * (warn — the spec's own "needs you" reading); SUBMITTED/ACKNOWLEDGED/
 * INTERVIEW are confirmed progress with the applicant's part done and
 * nothing outstanding from them right now (ok, matching the spec's own
 * "SUBMITTED … confirmed receipt" example). OFFER is deliberately NOT
 * grouped with those three: it is the funnel's single highest-stakes
 * instance of the applicant needing to act (accept, negotiate or decline),
 * so `ok` — "done, nothing further needed" — would tell them the opposite
 * of the truth on the row that matters most. It gets the same `warn` as
 * READY_FOR_REVIEW. REJECTED is a refusal (bad). EXPIRED and WITHDRAWN are
 * both neutral rather than bad: WITHDRAWN is the applicant's own reversible
 * choice, not a failure, and EXPIRED is the posting's window closing on its
 * own — nobody refused anything.
 *
 * The canonical copy: `/overview` (`overview/page.tsx`), the applications
 * board (`applications/board.tsx`), the detail page's status card and — via
 * {@link classificationTone} — `/inbox`'s reply badges all import this rather
 * than keeping their own tables, so the mapping can't drift between the
 * places that render it. It did drift once: Task 6's `OFFER: ok → warn` fix
 * was made here, while `/inbox` kept a hand-written copy that still read
 * `ok`, so the same event was green in the mail queue and amber on the board
 * (final branch review, Finding 3). `classificationTone` below is now derived
 * from this table rather than restating it, and `application-state.test.ts`
 * asserts the two agree.
 */
export const STATE_TONE: Record<ApplicationState, BadgeTone> = {
  DISCOVERED: "neutral",
  SHORTLISTED: "info",
  PREPARING: "info",
  READY_FOR_REVIEW: "warn",
  SUBMITTED: "ok",
  ACKNOWLEDGED: "ok",
  INTERVIEW: "ok",
  OFFER: "warn",
  REJECTED: "bad",
  WITHDRAWN: "neutral",
  EXPIRED: "neutral",
};

/**
 * The funnel stage a classified reply is evidence of, for the classifications
 * that name one. `ack` and `recruiter` are contact without a stage change and
 * `unrelated` is not evidence of anything, so they map to nothing and read
 * `neutral`.
 */
const CLASSIFICATION_STATE: Partial<Record<ReplyClassification, ApplicationState>> = {
  interview: "INTERVIEW",
  offer: "OFFER",
  rejection: "REJECTED",
};

/**
 * Colour for a reply-classification badge on `/inbox` (`inbox/suggestions.tsx`).
 *
 * Derived from {@link STATE_TONE} rather than restated as its own table, which
 * is the whole point: an `offer` reply in the mail queue and the `OFFER` row it
 * moves on the board are the same event, and they were reading opposite
 * answers to "who acts next" — green "nothing further needed" here, amber
 * "needs you" there — because one table was corrected and its copy was not.
 * Deriving makes the two impossible to disagree; a classification with no
 * corresponding stage stays `neutral`.
 */
export function classificationTone(classification: ReplyClassification): BadgeTone {
  const state = CLASSIFICATION_STATE[classification];
  return state ? STATE_TONE[state] : "neutral";
}

/**
 * Colour per generated-document/answer approval state, shared by
 * `[id]/materials.tsx` and `[id]/qa.tsx` (both use the same `approval_state`
 * enum — see `packages/db/src/schema/index.ts`, one Postgres enum for both
 * tables). `draft` is neutral rather than `warn` on its own: a manually
 * written draft that is merely unreviewed is not yet anyone's problem to fix,
 * only AI origin *combined with* draft gets the page's dedicated
 * "AI-generated — not yet approved" `warn` badge (see `badge-ai-draft` in
 * `materials.tsx`, and its Q&A-panel counterpart in `qa.tsx`).
 */
export const APPROVAL_TONE: Record<ApprovalState, BadgeTone> = {
  draft: "neutral",
  approved: "ok",
  rejected: "bad",
};

/**
 * Colour per submission-attempt status (`ATTEMPT_STATUSES` in
 * `@careerhq/contracts`), shared by `[id]/site-panel.tsx` and
 * `[id]/email-panel.tsx` — both drive the same attempt lifecycle through two
 * different channels and previously kept two byte-identical copies of this
 * mapping. `READY`/`SUBMITTING` are the pipeline working (info, matching the
 * spec's own SUBMITTING example); `PENDING_CONFIRMATION` is the one status
 * the *live* `Countdown` renders instead of a badge, but it still needs a
 * tone for the attempt-history list once the token itself is gone from
 * memory (a reload) — `warn`, because a countdown mid-flight is, by
 * definition, still waiting on the user. `BLOCKED` is a pause the user must
 * clear (login wall, duplicate requisition, …), not a failure, so it is also
 * `warn` rather than `bad`. `NEEDS_RECONCILE` is rendered through the
 * dedicated `ReconcilePanel` wherever it appears in full, never through this
 * map alone — the `warn` value here only colours the compact inline status
 * badge that sits beside that panel.
 */
export const ATTEMPT_TONE: Record<AttemptStatus, BadgeTone> = {
  DRAFT: "neutral",
  READY: "info",
  PENDING_CONFIRMATION: "warn",
  SUBMITTING: "info",
  SUBMITTED: "ok",
  FAILED: "bad",
  BLOCKED: "warn",
  NEEDS_RECONCILE: "warn",
};
