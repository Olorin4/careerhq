import { describe, expect, it } from "vitest";
import { computeNextAction } from "./next-action.js";

describe("computeNextAction (spec §6.2)", () => {
  it("terminal states have no next action", () => {
    for (const state of ["REJECTED", "WITHDRAWN", "EXPIRED"] as const) {
      expect(computeNextAction({ state })).toBeNull();
    }
  });
  it("SUBMITTED gets a follow-up due submittedAt + 7 days by default", () => {
    const submittedAt = new Date("2026-08-01T00:00:00Z");
    const action = computeNextAction({ state: "SUBMITTED", submittedAt });
    expect(action?.label).toBe("Follow up");
    expect(action?.due?.toISOString()).toBe("2026-08-08T00:00:00.000Z");
  });
  it("follow-up window is configurable", () => {
    const submittedAt = new Date("2026-08-01T00:00:00Z");
    const action = computeNextAction({ state: "SUBMITTED", submittedAt, followUpDays: 3 });
    expect(action?.due?.toISOString()).toBe("2026-08-04T00:00:00.000Z");
  });
  it("pre-submission states get action labels without due dates", () => {
    expect(computeNextAction({ state: "DISCOVERED" })).toEqual({ label: "Shortlist or dismiss", due: null });
    expect(computeNextAction({ state: "PREPARING" })).toEqual({ label: "Complete application materials", due: null });
    expect(computeNextAction({ state: "READY_FOR_REVIEW" })).toEqual({ label: "Review and submit", due: null });
    expect(computeNextAction({ state: "INTERVIEW" })).toEqual({ label: "Prepare for interview", due: null });
  });
});
