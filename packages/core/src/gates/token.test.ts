import { describe, expect, it } from "vitest";
import { CONFIRMATION_TTL_MS, generateConfirmationToken, hashConfirmationToken } from "./token.js";

describe("CONFIRMATION_TTL_MS (spec §11)", () => {
  it("is 10 minutes in milliseconds", () => {
    expect(CONFIRMATION_TTL_MS).toBe(600_000);
  });
});

describe("generateConfirmationToken", () => {
  it("returns a 64-char hex string (32 random bytes)", () => {
    const token = generateConfirmationToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is different on each call", () => {
    expect(generateConfirmationToken()).not.toBe(generateConfirmationToken());
  });
});

describe("hashConfirmationToken", () => {
  it("is a deterministic sha256 hex digest", () => {
    const token = generateConfirmationToken();
    expect(hashConfirmationToken(token)).toBe(hashConfirmationToken(token));
    expect(hashConfirmationToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs from the token itself", () => {
    const token = generateConfirmationToken();
    expect(hashConfirmationToken(token)).not.toBe(token);
  });

  it("differs for different tokens", () => {
    expect(hashConfirmationToken("token-a")).not.toBe(hashConfirmationToken("token-b"));
  });
});
