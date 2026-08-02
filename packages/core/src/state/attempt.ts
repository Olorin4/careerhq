import type { AttemptStatus } from "@careerhq/contracts";
import type { TransitionCheck } from "./application.js";

const ATTEMPT_EDGES: Partial<Record<AttemptStatus, AttemptStatus[]>> = {
  DRAFT: ["READY"],
  READY: ["PENDING_CONFIRMATION", "DRAFT"],
  PENDING_CONFIRMATION: ["SUBMITTING", "BLOCKED", "READY"],
  SUBMITTING: ["SUBMITTED", "FAILED", "NEEDS_RECONCILE"],
  NEEDS_RECONCILE: ["SUBMITTED", "FAILED"],
};

export function canAttemptTransition(from: AttemptStatus, to: AttemptStatus): TransitionCheck {
  return (ATTEMPT_EDGES[from] ?? []).includes(to)
    ? { ok: true }
    : { ok: false, reason: `no attempt transition ${from} → ${to}` };
}
