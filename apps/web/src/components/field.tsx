import type { JSX, ReactNode } from "react";

/**
 * The token-styled look for a native `<input>`/`<select>`/`<textarea>`.
 * Task 3 shipped `Field` as a label+error wrapper but never a class for the
 * control it wraps, so every bare control on every page fell through to
 * unstyled browser chrome sitting inside an otherwise fully restyled `Card`.
 * Found converting `/facts` (Task 5 step 1) and pushed down here — the
 * seven systematic pages and any later one all need the same thing, so it
 * belongs in the component layer, not repeated as a page-level class.
 * Checkboxes are the deliberate exception: forcing this onto `type=checkbox`
 * would draw a text-input box around a tickbox, so callers compose their own
 * `flex items-center gap-2` row for those instead (see e.g. `profile-form.tsx`).
 */
export const CONTROL_CLASSES =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink " +
  "disabled:cursor-not-allowed disabled:opacity-50";

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
