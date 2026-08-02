import type { ApplicationState } from "@careerhq/contracts";

export interface NextAction { label: string; due: Date | null }

const LABELS: Partial<Record<ApplicationState, string>> = {
  DISCOVERED: "Shortlist or dismiss",
  SHORTLISTED: "Start preparing",
  PREPARING: "Complete application materials",
  READY_FOR_REVIEW: "Review and submit",
  SUBMITTED: "Follow up",
  ACKNOWLEDGED: "Follow up",
  INTERVIEW: "Prepare for interview",
  OFFER: "Evaluate offer",
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeNextAction(input: {
  state: ApplicationState;
  submittedAt?: Date | null;
  lastEventAt?: Date | null;
  followUpDays?: number;
}): NextAction | null {
  const label = LABELS[input.state];
  if (!label) return null;
  const days = input.followUpDays ?? 7;
  if (input.state === "SUBMITTED" || input.state === "ACKNOWLEDGED") {
    const base = input.state === "SUBMITTED" ? input.submittedAt : (input.lastEventAt ?? input.submittedAt);
    return { label, due: base ? new Date(base.getTime() + days * DAY_MS) : null };
  }
  return { label, due: null };
}
