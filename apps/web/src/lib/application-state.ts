import type { ApplicationState } from "@careerhq/contracts";
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
