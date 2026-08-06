import type { JSX, ReactNode } from "react";

/**
 * The panel for an action whose outcome we could not confirm — a submit
 * that may or may not have gone through. Deliberately NOT `ok` (we don't
 * know it succeeded) and NOT `bad` (we don't know it failed): a hatched
 * `--warn` / `--warn-soft` stripe plus an explicit "Outcome unknown" label,
 * so it reads as "you need to go check" rather than either verdict.
 */
export function ReconcilePanel({
  reason,
  children,
  testId,
}: {
  reason: string;
  children?: ReactNode;
  testId?: string;
}): JSX.Element {
  return (
    <div className="flex gap-3 rounded-lg bg-surface p-4 shadow-card" data-testid={testId}>
      <div
        aria-hidden="true"
        className="w-1.5 shrink-0 rounded-full"
        style={{
          backgroundImage:
            "repeating-linear-gradient(135deg, var(--warn) 0px, var(--warn) 4px, var(--warn-soft) 4px, var(--warn-soft) 8px)",
        }}
      />
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-wide text-warn">Outcome unknown</span>
        <p className="text-sm text-ink">{reason}</p>
        {children}
      </div>
    </div>
  );
}
