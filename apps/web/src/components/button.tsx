import type { ButtonHTMLAttributes, JSX } from "react";

/**
 * Colour on a `Button` means who acts next and how reversible it is, not how
 * important the button looks. `irreversible` is reserved for controls that
 * touch the outside world and cannot be undone — "Confirm and submit",
 * "Send", "Delete" — and MUST be visually distinct from `primary` so a user
 * can see the difference before reading the label.
 */
export type ButtonTone = "default" | "primary" | "irreversible" | "ghost";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium " +
  "transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";

const TONE_CLASSES: Record<ButtonTone, string> = {
  default: "border border-line bg-surface text-ink",
  primary: "bg-ink text-white",
  irreversible: "bg-irreversible text-white",
  ghost: "text-muted",
};

export function Button({
  tone = "default",
  className,
  ...rest
}: { tone?: ButtonTone } & ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  const classes = [BASE, TONE_CLASSES[tone], className].filter(Boolean).join(" ");
  return <button className={classes} {...rest} />;
}
