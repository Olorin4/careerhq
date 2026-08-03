import { describe, expect, it } from "vitest";
import { redactError } from "./redact.js";

describe("redactError", () => {
  it("redacts every occurrence of a provided secret", () => {
    const err = new Error("Login failed for hunter2 using hunter2 again");
    expect(redactError(err, ["hunter2"])).toBe(
      "Login failed for [redacted] using [redacted] again",
    );
  });

  it("redacts every secret when multiple are provided", () => {
    const err = new Error("user=svc-mailer pass=hunter2");
    expect(redactError(err, ["svc-mailer", "hunter2"])).toBe(
      "user=[redacted] pass=[redacted]",
    );
  });

  it("masks AUTH LOGIN blobs even with no configured secrets", () => {
    const err = new Error(
      "535 5.7.8 authentication failed: AUTH LOGIN dXNlcm5hbWU6cGFzc3dvcmQxMjM0NTY3ODkw",
    );
    const out = redactError(err, []);
    expect(out).not.toMatch(/dXNlcm5hbWU/);
    expect(out).toBe("535 5.7.8 authentication failed: AUTH LOGIN [redacted]");
  });

  it("masks AUTH PLAIN blobs even with no configured secrets", () => {
    const err = new Error("454 4.7.0 AUTH PLAIN AGRldkBleGFtcGxlLmNvbQBzM2NyZXQxMjM0NTY=");
    const out = redactError(err, []);
    expect(out).not.toMatch(/AGRldkBleGFtcGxl/);
    expect(out).toBe("454 4.7.0 AUTH PLAIN [redacted]");
  });

  it("masks long base64-looking runs outside AUTH commands", () => {
    const blob = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5";
    const err = new Error(`unexpected server response: ${blob}`);
    const out = redactError(err, []);
    expect(out).not.toContain(blob);
    expect(out).toContain("[redacted]");
  });

  it("does not mask short base64-looking runs (< 16 chars)", () => {
    const err = new Error("code: QUJDREVGR0g=");
    expect(redactError(err, [])).toBe("code: QUJDREVGR0g=");
  });

  it("caps the redacted message at 300 characters", () => {
    const err = new Error(Array(100).fill("boom").join(" "));
    const out = redactError(err, []);
    expect(out.length).toBe(300);
  });

  it("handles non-Error string input", () => {
    expect(redactError("plain string boom", [])).toBe("plain string boom");
  });

  it("falls back to String(err) when no message is present", () => {
    const err = { code: "ECONNRESET" };
    expect(redactError(err, [])).toBe(String(err));
  });

  it("still redacts secrets found in a non-Error input", () => {
    expect(redactError("failed with secret hunter2", ["hunter2"])).toBe(
      "failed with secret [redacted]",
    );
  });
});
