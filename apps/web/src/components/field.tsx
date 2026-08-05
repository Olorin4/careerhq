import type { JSX, ReactNode } from "react";

/** A labeled form field wrapper with an optional inline error. */
export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-sm text-ink">
      <span className="font-medium">{label}</span>
      {children}
      {error ? (
        <span className="text-xs text-bad" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}
