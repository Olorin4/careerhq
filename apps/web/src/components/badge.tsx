import type { JSX, ReactNode } from "react";

/**
 * `Badge` tones follow the same rule as `Button` tones: colour means state,
 * not severity. `info` = in progress, `warn` = the user must act, `ok` =
 * done/verified, `bad` = failed/refused, `neutral` = nothing needed.
 */
export type BadgeTone = "neutral" | "info" | "warn" | "ok" | "bad";

const BASE = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "border border-line bg-canvas text-muted",
  info: "bg-info-soft text-info",
  warn: "bg-warn-soft text-warn",
  ok: "bg-ok-soft text-ok",
  bad: "bg-bad-soft text-bad",
};

export function Badge({
  tone,
  children,
  testId,
}: {
  tone: BadgeTone;
  children: ReactNode;
  testId?: string;
}): JSX.Element {
  return (
    <span className={`${BASE} ${TONE_CLASSES[tone]}`} data-testid={testId}>
      {children}
    </span>
  );
}
