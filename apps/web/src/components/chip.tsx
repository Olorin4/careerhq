import type { JSX, ReactNode } from "react";

/** A small provenance chip — where a fact, claim or draft came from. */
export function Chip({
  children,
  testId,
  title,
}: {
  children: ReactNode;
  testId?: string;
  title?: string;
}): JSX.Element {
  return (
    <span
      className="inline-flex items-center rounded-full border border-line bg-canvas px-2 py-0.5 text-xs text-muted"
      data-testid={testId}
      title={title}
    >
      {children}
    </span>
  );
}
