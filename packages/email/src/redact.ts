const MAX_LENGTH = 300;
const AUTH_BLOB_PATTERN = /(AUTH (?:PLAIN|LOGIN)) \S+/g;
const BASE64_RUN_PATTERN = /[A-Za-z0-9+/]{16,}={0,2}/g;

function extractRawMessage(err: unknown): string {
  const message =
    err !== null && typeof err === "object" && "message" in err
      ? (err as { message?: unknown }).message
      : undefined;
  return String(message ?? err);
}

/**
 * Renders an SMTP-adapter error as a bounded, secret-free string safe to
 * store or log. Every entry in `secrets` (SMTP passwords, auth tokens, etc.)
 * is scrubbed, plus two structural heuristics: AUTH PLAIN/LOGIN command
 * blobs (raw base64 credentials nodemailer echoes back in server responses)
 * and any other long base64-looking run, since such runs are the most
 * likely place a credential leaks even when it isn't a known secret.
 */
export function redactError(err: unknown, secrets: string[]): string {
  let message = extractRawMessage(err);

  for (const secret of secrets) {
    if (secret.length === 0) continue;
    message = message.split(secret).join("[redacted]");
  }

  message = message.replace(AUTH_BLOB_PATTERN, "$1 [redacted]");
  message = message.replace(BASE64_RUN_PATTERN, "[redacted]");

  return message.slice(0, MAX_LENGTH);
}
