import type { ButtonHTMLAttributes, JSX } from "react";

/**
 * Colour on a `Button` means who acts next and how reversible it is, not how
 * important the button looks. `irreversible` is reserved for controls that
 * touch the outside world and cannot be undone — "Confirm and submit",
 * "Send", "Delete" — and MUST be visually distinct from `primary` so a user
 * can see the difference before reading the label.
 */
export type ButtonTone = "default" | "primary" | "irreversible" | "ghost";

/**
 * `default` is the only size every existing call site renders with (an
 * omitted `size` prop must keep producing byte-identical classes to before
 * this existed). `compact` exists for tight, repeated layouts — the
 * applications board stacks several transition buttons per card in narrow
 * columns — where the default's `px-3 py-2 text-sm` crowds.
 */
export type ButtonSize = "default" | "compact";

// `focus-visible:outline-ink` is not decorative — it's the fix for a real
// bug. `primary` and `irreversible` set `text-white`, and the browser's
// default focus outline colour is `currentColor`. Left unset, a keyboard
// user focusing "Confirm and submit" got a white ring on a light surface:
// ~1:1 contrast, invisible. `--ink` against `--canvas`/`--surface` measures
// 16.32:1 (see task-3-report.md), so pinning every tone to it — rather than
// leaving `default`/`ghost` on the (incidentally fine) browser default —
// keeps the ring visible and identical regardless of the button's own text
// colour.
const BASE =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium " +
  "transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

const SIZE_CLASSES: Record<ButtonSize, string> = {
  default: "px-3 py-2 text-sm",
  compact: "px-2 py-1 text-xs",
};

const TONE_CLASSES: Record<ButtonTone, string> = {
  default: "border border-line bg-surface text-ink",
  primary: "bg-ink text-white",
  irreversible: "bg-irreversible text-white",
  ghost: "text-muted",
};

export function Button({
  tone = "default",
  size = "default",
  className,
  ...rest
}: { tone?: ButtonTone; size?: ButtonSize } & ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  const classes = [BASE, SIZE_CLASSES[size], TONE_CLASSES[tone], className].filter(Boolean).join(" ");
  return <button className={classes} {...rest} />;
}
