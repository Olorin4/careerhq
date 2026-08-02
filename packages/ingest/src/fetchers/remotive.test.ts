import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { remotiveFetcher } from "./remotive.js";
import type { FetchContext } from "./types.js";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/remotive.json", import.meta.url), "utf8"));
const ctx: FetchContext = {
  fetchJson: async () => fixture,
  fetchText: async () => { throw new Error("unused"); },
};

describe("remotive fetcher", () => {
  it("normalizes fixture items with source remotive and remote mode", async () => {
    const jobs = await remotiveFetcher.fetch(ctx);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(j.source).toBe("remotive");
      expect(j.externalId).toBeTruthy();
      expect(j.url).toMatch(/^https?:\/\//);
      expect(j.remoteMode).toBe("remote");
    }
  });
  it("skips malformed items instead of throwing", async () => {
    const broken: FetchContext = {
      ...ctx,
      fetchJson: async () => ({ jobs: [{ id: 1 }, ...(fixture as { jobs: unknown[] }).jobs] }),
    };
    const jobs = await remotiveFetcher.fetch(broken);
    expect(jobs.length).toBeGreaterThan(0); // the bad item is dropped, the rest survive
  });
});
