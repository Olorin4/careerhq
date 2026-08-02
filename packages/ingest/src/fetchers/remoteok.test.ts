import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { remoteokFetcher } from "./remoteok.js";
import type { FetchContext } from "./types.js";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/remoteok.json", import.meta.url), "utf8"));
const ctx: FetchContext = {
  fetchJson: async () => fixture,
  fetchText: async () => { throw new Error("unused"); },
};

describe("remoteok fetcher", () => {
  it("normalizes fixture items with source remoteok", async () => {
    const jobs = await remoteokFetcher.fetch(ctx);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(j.source).toBe("remoteok");
      expect(j.externalId).toBeTruthy();
      expect(j.url).toMatch(/^https?:\/\//);
      expect(j.remoteMode).toBe("remote");
    }
  });

  it("skips the leading legal-notice element", async () => {
    const jobs = await remoteokFetcher.fetch(ctx);
    expect(jobs.every((j) => j.title.length > 0)).toBe(true);
  });

  it("skips malformed items instead of throwing", async () => {
    const broken: FetchContext = {
      ...ctx,
      fetchJson: async () => [{ id: 1 }, ...(fixture as unknown[])],
    };
    const jobs = await remoteokFetcher.fetch(broken);
    expect(jobs.length).toBeGreaterThan(0); // the bad item is dropped, the rest survive
  });
});
