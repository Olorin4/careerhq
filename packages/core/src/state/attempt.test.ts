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
  it("pauses into BLOCKED from any pre-submission status, and never leaves it", () => {
    // Auto-apply meets its blockers (captcha, sign-in wall, assessment) while
    // reading the page, before a draft is ever previewed.
    expect(canAttemptTransition("DRAFT", "BLOCKED").ok).toBe(true);
    expect(canAttemptTransition("READY", "BLOCKED").ok).toBe(true);
    // Nothing was submitted, so there is nothing to reconcile or fail: a retry
    // is a new attempt.
    expect(canAttemptTransition("BLOCKED", "DRAFT").ok).toBe(false);
    expect(canAttemptTransition("BLOCKED", "READY").ok).toBe(false);
    expect(canAttemptTransition("BLOCKED", "SUBMITTING").ok).toBe(false);
    // The mutation is already in flight past this point — pausing is no longer
    // an option, only SUBMITTED/FAILED/NEEDS_RECONCILE are.
    expect(canAttemptTransition("SUBMITTING", "BLOCKED").ok).toBe(false);
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
