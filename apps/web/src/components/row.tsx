import type { JSX, ReactNode } from "react";

const CLASSES =
  "flex items-center justify-between gap-3 border-b border-line px-3 py-3 text-ink no-underline last:border-b-0";

/** The list-row primitive the fact, answer, CV and inbox lists are built from. */
export function Row({
  children,
  href,
  testId,
}: {
  children: ReactNode;
  href?: string;
  testId?: string;
}): JSX.Element {
  if (href) {
    return (
      <a href={href} className={CLASSES} data-testid={testId}>
        {children}
      </a>
    );
  }
  return (
    <div className={CLASSES} data-testid={testId}>
      {children}
    </div>
  );
}
