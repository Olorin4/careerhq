import { REPLY_CLASSIFICATIONS } from "@careerhq/contracts";
import { describe, expect, it } from "vitest";
import { STATE_TONE, classificationTone } from "./application-state.js";

/**
 * The regression guard for the final branch review's Finding 3: `/inbox` kept
 * its own hand-written classification→tone table, and when the board's `OFFER`
 * was corrected from `ok` to `warn` the copy was not. The same event then read
 * green in the mail queue and amber on the board — opposite answers to "who
 * acts next", which is the one thing the tone vocabulary exists to say.
 */
describe("classificationTone", () => {
  it("agrees with STATE_TONE for every classification that names a stage", () => {
    expect(classificationTone("offer")).toBe(STATE_TONE.OFFER);
    expect(classificationTone("interview")).toBe(STATE_TONE.INTERVIEW);
    expect(classificationTone("rejection")).toBe(STATE_TONE.REJECTED);
  });

  it("reads neutral for classifications that are not evidence of a stage", () => {
    expect(classificationTone("ack")).toBe("neutral");
    expect(classificationTone("recruiter")).toBe("neutral");
    expect(classificationTone("unrelated")).toBe("neutral");
  });

  it("has an answer for every classification the contract defines", () => {
    for (const classification of REPLY_CLASSIFICATIONS) {
      expect(classificationTone(classification)).toBeTruthy();
    }
  });
});
