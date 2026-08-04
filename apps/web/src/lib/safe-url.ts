/** The only two protocols a stored/user-supplied URL may render as a clickable `href`. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * The only place a stored URL becomes an `href`. Every value that ends up in
 * an anchor tag — a job posting URL, an evidence link, a site-submission
 * final URL — came from either the database or a live third-party page, so
 * it must be treated as untrusted input. `javascript:`, `data:`, `vbscript:`,
 * `file:`, `blob:`, a relative path, or anything that fails to parse as an
 * absolute URL all come back `null`; callers must render those as plain text
 * rather than an anchor.
 */
export function safeExternalHref(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  return ALLOWED_PROTOCOLS.has(parsed.protocol) ? raw : null;
}
