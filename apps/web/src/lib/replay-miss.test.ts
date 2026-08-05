import { describe, expect, it } from "vitest";
import { makeFsReplayStore, withReplay } from "@careerhq/ai";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPLAY_MISS, replayMissMessage } from "./replay-miss";

describe("REPLAY_MISS", () => {
  // The constant only earns its keep if it is the token withReplay actually
  // produces: a rename there with no rename here would silently put the demo
  // back to rendering the raw string (Task 12, C1).
  it("is the error a real replay miss returns", async () => {
    const result = await withReplay<string>({
      mode: "replay",
      store: makeFsReplayStore(mkdtempSync(path.join(tmpdir(), "careerhq-miss-"))),
      taskId: "generate",
      prompt: { system: "s", user: "nothing was ever recorded for this" },
      run: async () => {
        throw new Error("replay mode must never call the model");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(REPLAY_MISS);
  });
});

describe("replayMissMessage", () => {
  for (const kind of ["document", "question"] as const) {
    describe(kind, () => {
      const message = replayMissMessage(kind);

      it("never leaks the internal token", () => {
        expect(message).not.toContain(REPLAY_MISS);
        expect(message).not.toMatch(/_/);
      });

      it("explains that answers are recorded rather than generated live", () => {
        expect(message).toContain("recorded");
        expect(message).toContain("no live model calls");
      });

      it("points at something that does work", () => {
        expect(message).toContain("Wexford Health");
        expect(message).toContain("OpenRouter key");
      });

      it("reads as prose, not as a status line", () => {
        // Sentence case, ends in a full stop, and long enough to be an
        // explanation rather than a label.
        expect(message.length).toBeGreaterThan(120);
        expect(message.endsWith(".")).toBe(true);
        expect(message[0]).toBe(message[0]?.toUpperCase());
      });
    });
  }

  it("tells the Q&A panel's visitor which question is recorded", () => {
    expect(replayMissMessage("question")).toContain("Why do you want to work here?");
  });

  it("tells the materials panel's visitor that every seeded application is covered", () => {
    expect(replayMissMessage("document")).toContain("cover letter");
    expect(replayMissMessage("document")).toContain("email body");
  });
});
