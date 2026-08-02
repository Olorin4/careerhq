import { describe, expect, it } from "vitest";
import {
  APPLICATION_STATES,
  ATTEMPT_STATUSES,
  FACT_CATEGORIES,
  applicationStateSchema,
} from "./index.js";

describe("contracts", () => {
  it("defines the 11 application states verbatim from spec §6.1", () => {
    expect(APPLICATION_STATES).toEqual([
      "DISCOVERED", "SHORTLISTED", "PREPARING", "READY_FOR_REVIEW", "SUBMITTED",
      "ACKNOWLEDGED", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN", "EXPIRED",
    ]);
  });
  it("defines the 8 attempt statuses", () => {
    expect(ATTEMPT_STATUSES).toHaveLength(8);
    expect(ATTEMPT_STATUSES).toContain("NEEDS_RECONCILE");
  });
  it("defines the 9 fact categories from spec §7.1", () => {
    expect(FACT_CATEGORIES).toHaveLength(9);
  });
  it("rejects unknown states via zod", () => {
    expect(applicationStateSchema.safeParse("GHOSTED").success).toBe(false);
    expect(applicationStateSchema.safeParse("SUBMITTED").success).toBe(true);
  });
});
