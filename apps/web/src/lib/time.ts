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

export function timeAgo(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
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
