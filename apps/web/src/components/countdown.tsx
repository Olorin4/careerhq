"use client";

import { useEffect, useState, type JSX } from "react";

/** `62_000` ms → `"1:02"`; anything at or under zero is `"expired"`. */
function formatRemaining(remainingMs: number): string {
  if (remainingMs <= 0) return "expired";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** A live mm:ss countdown to `expiresAt`, ticking once a second until expired. */
export function Countdown({ expiresAt }: { expiresAt: string }): JSX.Element {
  const target = new Date(expiresAt).getTime();
  const [remaining, setRemaining] = useState(() => target - Date.now());

  useEffect(() => {
    const id = setInterval(() => setRemaining(target - Date.now()), 1000);
    return () => clearInterval(id);
  }, [target]);

  const expired = remaining <= 0;
  return <span className={expired ? "font-medium text-bad" : "text-ink"}>{formatRemaining(remaining)}</span>;
}
