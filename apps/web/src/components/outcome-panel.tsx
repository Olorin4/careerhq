import type { JSX, ReactNode } from "react";

/**
 * A definite-outcome panel: the submission channel knows what happened, and
 * it was one of ok/warn/bad — unlike `ReconcilePanel`, which is reserved for
 * the one case where the outcome is genuinely unknown. A solid left-border
 * stripe (vs. `ReconcilePanel`'s hatched one) is deliberate: it must not be
 * visually confusable with "we don't know", which is a stronger and rarer
 * claim than any of these three.
 *
 * Shared by `[id]/site-panel.tsx` and `[id]/email-panel.tsx` — both drive the
 * same prepare/preview/confirm outcome shape through two different channels
 * and previously kept two near-identical sets of outcome-box CSS.
 */
export function OutcomePanel({
  tone,
  testId,
  children,
}: {
  tone: "ok" | "warn" | "bad";
  testId?: string;
  children: ReactNode;
}): JSX.Element {
  const toneClasses: Record<"ok" | "warn" | "bad", string> = {
    ok: "border-ok bg-ok-soft",
    warn: "border-warn bg-warn-soft",
    bad: "border-bad bg-bad-soft",
  };
  return (
    <div className={`flex flex-col gap-2 rounded-md border-l-4 p-3 text-sm text-ink ${toneClasses[tone]}`} data-testid={testId}>
      {children}
    </div>
  );
}
