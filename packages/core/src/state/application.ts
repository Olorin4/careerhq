import type { ApplicationState, TransitionTrigger } from "@careerhq/contracts";

export const AUTO_ACK_CONFIDENCE = 0.9;

export interface TransitionContext {
  hasConfirmedAttempt?: boolean;
  hasMaterials?: boolean;
  classificationConfidence?: number;
}
export type TransitionCheck = { ok: true } | { ok: false; reason: string };

type Guard = (ctx: TransitionContext) => TransitionCheck;
const ok: TransitionCheck = { ok: true };
const pass: Guard = () => ok;

const requireMaterials: Guard = (ctx) =>
  ctx.hasMaterials ? ok : { ok: false, reason: "materials must exist for the chosen channel" };
const requireConfirmedAttempt: Guard = (ctx) =>
  ctx.hasConfirmedAttempt ? ok : { ok: false, reason: "a confirmed application attempt is required" };
const requireHighConfidence: Guard = (ctx) =>
  (ctx.classificationConfidence ?? 0) >= AUTO_ACK_CONFIDENCE
    ? ok
    : { ok: false, reason: "classification confidence below auto-acknowledge threshold" };

const ACTIVE: readonly ApplicationState[] = [
  "DISCOVERED", "SHORTLISTED", "PREPARING", "READY_FOR_REVIEW",
  "SUBMITTED", "ACKNOWLEDGED", "INTERVIEW", "OFFER",
];

type Edge = { to: ApplicationState; triggers: Partial<Record<TransitionTrigger, Guard>> };
const EDGES: Partial<Record<ApplicationState, Edge[]>> = {
  DISCOVERED: [
    { to: "SHORTLISTED", triggers: { user: pass } },
    { to: "EXPIRED", triggers: { system: pass, user: pass } },
  ],
  SHORTLISTED: [
    { to: "PREPARING", triggers: { user: pass } },
    { to: "EXPIRED", triggers: { system: pass, user: pass } },
  ],
  PREPARING: [{ to: "READY_FOR_REVIEW", triggers: { user: requireMaterials, system: requireMaterials } }],
  READY_FOR_REVIEW: [{ to: "SUBMITTED", triggers: { attempt: requireConfirmedAttempt } }],
  SUBMITTED: [
    { to: "ACKNOWLEDGED", triggers: { user: pass, classification: requireHighConfidence } },
    { to: "INTERVIEW", triggers: { user: pass } },
  ],
  ACKNOWLEDGED: [{ to: "INTERVIEW", triggers: { user: pass } }],
  INTERVIEW: [{ to: "OFFER", triggers: { user: pass } }],
};

function edgesFor(from: ApplicationState): Edge[] {
  const base = EDGES[from] ?? [];
  if (!ACTIVE.includes(from)) return base;
  return [
    ...base,
    { to: "REJECTED", triggers: { user: pass } },
    { to: "WITHDRAWN", triggers: { user: pass } },
  ];
}

export function canTransition(
  from: ApplicationState,
  to: ApplicationState,
  trigger: TransitionTrigger,
  ctx: TransitionContext = {},
): TransitionCheck {
  const edge = edgesFor(from).find((e) => e.to === to);
  if (!edge) return { ok: false, reason: `no transition ${from} → ${to}` };
  const guard = edge.triggers[trigger];
  if (!guard) return { ok: false, reason: `trigger '${trigger}' may not perform ${from} → ${to}` };
  return guard(ctx);
}

export function legalTargets(from: ApplicationState, trigger: TransitionTrigger): ApplicationState[] {
  return edgesFor(from)
    .filter((e) => e.triggers[trigger] !== undefined)
    .map((e) => e.to);
}
