/**
 * Renders a timestamp the same way on the server and in the browser.
 *
 * `Date#toLocaleString()` reads the *host's* locale and time zone. In a client
 * component that means the Node process which server-renders the HTML formats
 * it one way (the container's ICU default — `en-US`, whatever `TZ` says) and
 * the visitor's browser formats the very same `Date` another way when it
 * hydrates. React sees two different text nodes and reports a hydration
 * mismatch — the minified error #418 the P6 live audit found on
 * `/applications/[id]`, reproduced there with a browser on `en-GB` /
 * `America/New_York`.
 *
 * `toISOString` is the fix rather than a pinned `Intl.DateTimeFormat`: it is
 * defined by the language to be UTC and locale-free, so it cannot diverge even
 * on a host with a different ICU build. The trailing `UTC` is not decoration —
 * without it the reader has no way to know which zone the number is in.
 */
export function formatTimestamp(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The date-only half of {@link formatTimestamp}, and UTC for the same reason. */
export function formatDate(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toISOString().slice(0, 10);
}

/**
 * A relative age, in the coarsest bucket that fits. Locale- and zone-free by
 * construction — it is arithmetic on two epoch millisecond values and never
 * consults the host's calendar — so unlike {@link formatTimestamp} its hazard
 * was never *where* it renders but *when*.
 *
 * `now` is REQUIRED, and that is the fix. It used to default to `new Date()`,
 * which meant the caller did not pass a time and therefore did not pass the
 * SAME time twice: `ConnectionsTable` is a client component rendered from a
 * server page, so React renders it once in the Node process and again in the
 * browser when it hydrates. Two `new Date()` calls, milliseconds to seconds
 * apart, straddling a bucket edge — "1h ago" server-side, "2h ago" in the
 * browser — is hydration error #418 all over again, the same class as the bug
 * `b9a7364` fixed and arrived at by a different route. Never observed, because
 * the window is one bucket edge wide and the data is a mailbox health check;
 * the point is that nothing prevented it.
 *
 * A default value cannot be made safe here — whatever it computes, it computes
 * twice. So the bucket is decided ONCE, by the server component that owns the
 * render, and travels to the browser as a serialized prop (`apps/web/src/app/
 * (dashboard)/settings/email/page.tsx`), which is the same shape `email-panel`'s
 * `ExpiryCountdown` already uses for its `now`.
 *
 * Milliseconds rather than a `Date` for exactly that reason: a number crosses
 * the server/client boundary as itself, and a caller cannot accidentally hand
 * this a value the two sides disagree about.
 */
export function timeAgo(date: Date, nowMs: number): string {
  const diffMs = nowMs - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);

  if (diffSeconds < 60) {
    return "just now";
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
