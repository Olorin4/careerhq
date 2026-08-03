import { createHash, randomBytes } from "node:crypto";

/** Confirmation tokens are valid for 10 minutes (spec §11). */
export const CONFIRMATION_TTL_MS = 10 * 60_000;

/** A fresh single-use confirmation token: 32 random bytes, hex-encoded (64 chars). */
export function generateConfirmationToken(): string {
  return randomBytes(32).toString("hex");
}

/** sha256 hex digest of a confirmation token — only the hash is persisted, never the token. */
export function hashConfirmationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
