import type { JSX } from "react";

/** The shared "nothing here yet" placeholder for empty lists. */
export function EmptyState({ title, hint }: { title: string; hint?: string }): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-line bg-canvas px-4 py-8 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
