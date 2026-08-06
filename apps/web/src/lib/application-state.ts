import type { ApplicationState, ApprovalState, AttemptStatus } from "@careerhq/contracts";
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
 * READY_FOR_REVIEW. REJECTED/EXPIRED are refusals (bad); WITHDRAWN is the
 * applicant's own reversible choice, not a failure, so it stays neutral
 * rather than bad.
 *
 * The canonical copy: `/overview` (`overview/page.tsx`) and the applications
 * board (`applications/board.tsx`) both import this rather than keeping their
 * own tables, so the mapping can't drift between the two places that render
 * it (see Task 6's `OFFER` fix, made once here instead of twice).
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
  EXPIRED: "bad",
};

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
