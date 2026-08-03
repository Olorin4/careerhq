import { createHash } from "node:crypto";

export interface EmailSubmissionPayload {
  applicationId: string;
  connectionId: string;
  to: string;
  subject: string;
  body: string;
  attachments: Array<{ filename: string; sha256: string }>;
}

function encode(value: unknown, seen: WeakSet<object>): string {
  if (value === undefined) throw new TypeError("canonicalJson: undefined is not a valid value");
  if (typeof value === "function") throw new TypeError("canonicalJson: functions are not valid values");
  if (typeof value === "symbol") throw new TypeError("canonicalJson: symbols are not valid values");
  if (value === null || typeof value !== "object") return JSON.stringify(value);

  if (seen.has(value)) throw new TypeError("canonicalJson: cyclic object detected");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => encode(item, seen)).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key], seen)}`,
    );
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * Deterministic JSON serialization: object keys are sorted recursively, array order is
 * preserved, and primitives are stringified as-is. Throws TypeError on `undefined`,
 * functions, symbols, or cyclic references — none of which have a canonical representation.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new WeakSet<object>());
}

/** sha256 hex digest of the canonical JSON representation of `value` (spec §11). */
export function payloadFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
