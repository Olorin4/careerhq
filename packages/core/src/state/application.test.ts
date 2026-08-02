import { describe, expect, it } from "vitest";
import { canTransition, legalTargets, AUTO_ACK_CONFIDENCE } from "./application.js";

describe("application state machine (spec §6.2)", () => {
  it("allows the happy path with user triggers", () => {
    expect(canTransition("DISCOVERED", "SHORTLISTED", "user").ok).toBe(true);
    expect(canTransition("SHORTLISTED", "PREPARING", "user").ok).toBe(true);
    expect(canTransition("INTERVIEW", "OFFER", "user").ok).toBe(true);
  });
  it("PREPARING → READY_FOR_REVIEW requires materials", () => {
    expect(canTransition("PREPARING", "READY_FOR_REVIEW", "user", { hasMaterials: false }).ok).toBe(false);
    expect(canTransition("PREPARING", "READY_FOR_REVIEW", "user", { hasMaterials: true }).ok).toBe(true);
  });
  it("user can NEVER set SUBMITTED directly", () => {
    const r = canTransition("READY_FOR_REVIEW", "SUBMITTED", "user", { hasConfirmedAttempt: true });
    expect(r.ok).toBe(false);
  });
  it("attempt trigger sets SUBMITTED only with a confirmed attempt", () => {
    expect(canTransition("READY_FOR_REVIEW", "SUBMITTED", "attempt", { hasConfirmedAttempt: true }).ok).toBe(true);
    expect(canTransition("READY_FOR_REVIEW", "SUBMITTED", "attempt", {}).ok).toBe(false);
  });
  it("classification auto-acks only at high confidence", () => {
    expect(canTransition("SUBMITTED", "ACKNOWLEDGED", "classification",
      { classificationConfidence: AUTO_ACK_CONFIDENCE }).ok).toBe(true);
    expect(canTransition("SUBMITTED", "ACKNOWLEDGED", "classification",
      { classificationConfidence: 0.5 }).ok).toBe(false);
    expect(canTransition("SUBMITTED", "ACKNOWLEDGED", "user").ok).toBe(true);
  });
  it("classification may never set INTERVIEW/OFFER/REJECTED (user-confirmed only)", () => {
    expect(canTransition("SUBMITTED", "INTERVIEW", "classification", { classificationConfidence: 1 }).ok).toBe(false);
    expect(canTransition("INTERVIEW", "OFFER", "classification", { classificationConfidence: 1 }).ok).toBe(false);
    expect(canTransition("SUBMITTED", "REJECTED", "classification", { classificationConfidence: 1 }).ok).toBe(false);
  });
  it("any active state can be REJECTED or WITHDRAWN by the user", () => {
    for (const from of ["DISCOVERED", "PREPARING", "SUBMITTED", "INTERVIEW", "OFFER"] as const) {
      expect(canTransition(from, "REJECTED", "user").ok).toBe(true);
      expect(canTransition(from, "WITHDRAWN", "user").ok).toBe(true);
    }
  });
  it("only DISCOVERED/SHORTLISTED can EXPIRE, via system", () => {
    expect(canTransition("DISCOVERED", "EXPIRED", "system").ok).toBe(true);
    expect(canTransition("SHORTLISTED", "EXPIRED", "system").ok).toBe(true);
    expect(canTransition("SUBMITTED", "EXPIRED", "system").ok).toBe(false);
  });
  it("terminal states have no exits", () => {
    for (const from of ["REJECTED", "WITHDRAWN", "EXPIRED"] as const) {
      expect(legalTargets(from, "user")).toEqual([]);
    }
  });
  it("legalTargets lists user-triggerable targets for the UI", () => {
    expect(legalTargets("DISCOVERED", "user")).toEqual(
      expect.arrayContaining(["SHORTLISTED", "REJECTED", "WITHDRAWN"]),
    );
    expect(legalTargets("READY_FOR_REVIEW", "user")).not.toContain("SUBMITTED");
  });
});
