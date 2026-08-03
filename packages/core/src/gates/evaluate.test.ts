import { describe, expect, it } from "vitest";
import type { GateCheckInput } from "./evaluate.js";
import { evaluateSubmissionGates } from "./evaluate.js";
import { hashConfirmationToken } from "./token.js";

const NOW = new Date("2026-08-03T12:00:00.000Z");
const PRESENTED_TOKEN = "the-presented-token";
const TOKEN_HASH = hashConfirmationToken(PRESENTED_TOKEN);
const FINGERPRINT = "fingerprint-of-current-draft";
const TARGET = "hr@acme.example";

function baseInput(overrides: Partial<GateCheckInput> = {}): GateCheckInput {
  return {
    envGateOpen: true,
    workspaceKind: "personal",
    sandboxTargetAllowed: true,
    tokenRecord: {
      tokenHash: TOKEN_HASH,
      payloadFingerprint: FINGERPRINT,
      expiresAt: new Date(NOW.getTime() + 60_000),
      consumedAt: null,
    },
    presentedToken: PRESENTED_TOKEN,
    now: NOW,
    currentFingerprint: FINGERPRINT,
    retypedTarget: TARGET,
    expectedTarget: TARGET,
    hasConfirmedAttempt: false,
    attemptInFlight: false,
    ...overrides,
  };
}

type Row = { name: string; overrides: Partial<GateCheckInput>; expected: string | null };

const MATRIX: Row[] = [
  {
    name: "all green → allowed",
    overrides: {},
    expected: null,
  },
  {
    name: "duplicate_submission beats attempt_in_flight and gate_closed (highest precedence)",
    overrides: { hasConfirmedAttempt: true, attemptInFlight: true, envGateOpen: false },
    expected: "duplicate_submission",
  },
  {
    name: "attempt_in_flight beats gate_closed",
    overrides: { attemptInFlight: true, envGateOpen: false },
    expected: "attempt_in_flight",
  },
  {
    name: "gate_closed beats sandbox_blocked",
    overrides: { envGateOpen: false, workspaceKind: "sandbox", sandboxTargetAllowed: false },
    expected: "gate_closed",
  },
  {
    name: "sandbox_blocked only fires for sandbox kind with disallowed target",
    overrides: { workspaceKind: "sandbox", sandboxTargetAllowed: false },
    expected: "sandbox_blocked",
  },
  {
    name: "personal workspace ignores sandboxTargetAllowed=false entirely",
    overrides: { workspaceKind: "personal", sandboxTargetAllowed: false },
    expected: null,
  },
  {
    name: "sandbox workspace with allowed target proceeds past sandbox check",
    overrides: { workspaceKind: "sandbox", sandboxTargetAllowed: true },
    expected: null,
  },
  {
    name: "token_missing when no token record exists",
    overrides: { tokenRecord: null },
    expected: "token_missing",
  },
  {
    name: "token_consumed beats token_expired (both true simultaneously)",
    overrides: {
      tokenRecord: {
        tokenHash: TOKEN_HASH,
        payloadFingerprint: FINGERPRINT,
        expiresAt: new Date(NOW.getTime() - 1),
        consumedAt: new Date(NOW.getTime() - 1000),
      },
    },
    expected: "token_consumed",
  },
  {
    name: "token_expired beats token_invalid (expired + wrong presented token simultaneously)",
    overrides: {
      tokenRecord: {
        tokenHash: TOKEN_HASH,
        payloadFingerprint: FINGERPRINT,
        expiresAt: new Date(NOW.getTime() - 1),
        consumedAt: null,
      },
      presentedToken: "wrong-token",
    },
    expected: "token_expired",
  },
  {
    name: "token_invalid on wrong presented token (unexpired, unconsumed)",
    overrides: { presentedToken: "wrong-token" },
    expected: "token_invalid",
  },
  {
    name: "fingerprint_mismatch beats target_mismatch (both wrong simultaneously)",
    overrides: { currentFingerprint: "a-different-fingerprint", retypedTarget: "someone-else@acme.example" },
    expected: "fingerprint_mismatch",
  },
  {
    name: "target_mismatch when only the retyped target is wrong",
    overrides: { retypedTarget: "someone-else@acme.example" },
    expected: "target_mismatch",
  },
  {
    name: "target compare trims whitespace and ignores case",
    overrides: { retypedTarget: "HR@Acme.example ", expectedTarget: "hr@acme.example" },
    expected: null,
  },
];

describe("evaluateSubmissionGates matrix (spec §11, normative check order)", () => {
  it.each(MATRIX)("$name", ({ overrides, expected }) => {
    const decision = evaluateSubmissionGates(baseInput(overrides));
    if (expected === null) {
      expect(decision).toEqual({ allowed: true });
    } else {
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.code).toBe(expected);
        expect(typeof decision.reason).toBe("string");
        expect(decision.reason.length).toBeGreaterThan(0);
      }
    }
  });
});
