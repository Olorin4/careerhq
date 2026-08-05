import type { JSX, ReactNode } from "react";

/** The generic surface primitive — a bordered, shadowed panel on `--surface`. */
export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  const classes = ["rounded-lg border border-line bg-surface p-4 shadow-card", className]
    .filter(Boolean)
    .join(" ");
  return <div className={classes}>{children}</div>;
}
