import { describe, expect, it } from "vitest";
import { canAttemptTransition } from "./attempt.js";

describe("attempt lifecycle (architecture §3)", () => {
  it("follows DRAFT → READY → PENDING_CONFIRMATION → SUBMITTING → SUBMITTED", () => {
    expect(canAttemptTransition("DRAFT", "READY").ok).toBe(true);
    expect(canAttemptTransition("READY", "PENDING_CONFIRMATION").ok).toBe(true);
    expect(canAttemptTransition("PENDING_CONFIRMATION", "SUBMITTING").ok).toBe(true);
    expect(canAttemptTransition("SUBMITTING", "SUBMITTED").ok).toBe(true);
  });
  it("SUBMITTING may end FAILED, BLOCKED is pre-mutation only, NEEDS_RECONCILE post-mutation", () => {
    expect(canAttemptTransition("SUBMITTING", "FAILED").ok).toBe(true);
    expect(canAttemptTransition("SUBMITTING", "NEEDS_RECONCILE").ok).toBe(true);
    expect(canAttemptTransition("PENDING_CONFIRMATION", "BLOCKED").ok).toBe(true);
    expect(canAttemptTransition("SUBMITTED", "FAILED").ok).toBe(false);
  });
  it("NEEDS_RECONCILE resolves only to SUBMITTED or FAILED (human decision)", () => {
    expect(canAttemptTransition("NEEDS_RECONCILE", "SUBMITTED").ok).toBe(true);
    expect(canAttemptTransition("NEEDS_RECONCILE", "FAILED").ok).toBe(true);
    expect(canAttemptTransition("NEEDS_RECONCILE", "SUBMITTING").ok).toBe(false);
  });
  it("cannot skip the confirmation step", () => {
    expect(canAttemptTransition("READY", "SUBMITTING").ok).toBe(false);
    expect(canAttemptTransition("DRAFT", "SUBMITTED").ok).toBe(false);
  });
});
