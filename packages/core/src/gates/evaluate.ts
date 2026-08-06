import type { WorkspaceKind } from "@careerhq/contracts";
import { hashConfirmationToken } from "./token.js";

/**
 * Which channel this submission would go out on. The gate matrix is shared by
 * both, but the env gate is not: email is gated by `SUBMISSIONS_LIVE_EMAIL`
 * and the company-site channel by `SUBMISSIONS_LIVE_COMPANY_SITE`. Without
 * this the shared `gate_closed` refusal named the email variable on both
 * paths, which told a site-channel operator to change a setting that has no
 * effect on the refusal they are looking at.
 */
export type SubmissionChannel = "email" | "company_site";

/** The env var each channel's gate actually reads — quoted in the refusal. */
const ENV_GATE_BY_CHANNEL: Record<SubmissionChannel, string> = {
  email: "SUBMISSIONS_LIVE_EMAIL",
  company_site: "SUBMISSIONS_LIVE_COMPANY_SITE",
};

/** How each channel's refusal describes what it would have done. */
const ACTION_BY_CHANNEL: Record<SubmissionChannel, string> = {
  email: "live email submission",
  company_site: "live company-site submission",
};

export interface GateCheckInput {
  envGateOpen: boolean;
  /** Decides which env var the `gate_closed` refusal names. */
  channel: SubmissionChannel;
  workspaceKind: WorkspaceKind;
  /** caller computes: target host is the allowed sandbox host */
  sandboxTargetAllowed: boolean;
  tokenRecord: { tokenHash: string; payloadFingerprint: string; expiresAt: Date; consumedAt: Date | null } | null;
  presentedToken: string;
  now: Date;
  /** recomputed by the caller from the CURRENT draft */
  currentFingerprint: string;
  retypedTarget: string;
  /** compared case-insensitively, trimmed */
  expectedTarget: string;
  hasConfirmedAttempt: boolean;
  /** another attempt in SUBMITTING/NEEDS_RECONCILE */
  attemptInFlight: boolean;
}

type DeniedCode =
  | "duplicate_submission"
  | "attempt_in_flight"
  | "gate_closed"
  | "sandbox_blocked"
  | "token_missing"
  | "token_consumed"
  | "token_expired"
  | "token_invalid"
  | "fingerprint_mismatch"
  | "target_mismatch";

export type GateDecision = { allowed: true } | { allowed: false; code: DeniedCode; reason: string };

function deny(code: DeniedCode, reason: string): GateDecision {
  return { allowed: false, code, reason };
}

function normalizeTarget(target: string): string {
  return target.trim().toLowerCase();
}

/**
 * The submission gate matrix (spec §11, NORMATIVE). Check order below is load-bearing —
 * each check assumes every prior one already passed, and the first failure wins:
 *   duplicate_submission → attempt_in_flight → gate_closed → sandbox_blocked →
 *   token_missing/consumed/expired/invalid → fingerprint_mismatch → target_mismatch → allowed.
 */
export function evaluateSubmissionGates(input: GateCheckInput): GateDecision {
  if (input.hasConfirmedAttempt) {
    return deny("duplicate_submission", "a confirmed submission attempt already exists for this application");
  }
  if (input.attemptInFlight) {
    return deny("attempt_in_flight", "another submission attempt is already in flight (SUBMITTING/NEEDS_RECONCILE)");
  }
  if (!input.envGateOpen) {
    return deny(
      "gate_closed",
      `${ACTION_BY_CHANNEL[input.channel]} is disabled by the ${ENV_GATE_BY_CHANNEL[input.channel]} environment gate`,
    );
  }
  if (input.workspaceKind === "sandbox" && !input.sandboxTargetAllowed) {
    return deny("sandbox_blocked", "sandbox workspaces may only send to the configured sandbox host");
  }

  const { tokenRecord } = input;
  if (!tokenRecord) {
    return deny("token_missing", "no active confirmation token exists for this attempt");
  }
  if (tokenRecord.consumedAt !== null) {
    return deny("token_consumed", "this confirmation token has already been consumed");
  }
  if (tokenRecord.expiresAt.getTime() <= input.now.getTime()) {
    return deny("token_expired", "the confirmation token has expired");
  }
  if (hashConfirmationToken(input.presentedToken) !== tokenRecord.tokenHash) {
    return deny("token_invalid", "the presented confirmation token does not match");
  }

  if (input.currentFingerprint !== tokenRecord.payloadFingerprint) {
    return deny("fingerprint_mismatch", "the submission payload changed since it was confirmed");
  }
  const normalizedExpected = normalizeTarget(input.expectedTarget);
  const normalizedRetyped = normalizeTarget(input.retypedTarget);
  // An empty/whitespace-only expectedTarget has nothing valid to confirm against — never treat
  // that as a silent match, even if retypedTarget is also empty.
  if (normalizedExpected === "" || normalizedRetyped !== normalizedExpected) {
    return deny("target_mismatch", "the retyped recipient does not match the expected target");
  }

  return { allowed: true };
}
