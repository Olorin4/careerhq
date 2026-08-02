import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { themuseFetcher } from "./themuse.js";
import type { FetchContext } from "./types.js";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/themuse.json", import.meta.url), "utf8"));
const ctx: FetchContext = {
  fetchJson: async () => fixture,
  fetchText: async () => { throw new Error("unused"); },
};

describe("themuse fetcher", () => {
  it("normalizes fixture items with source themuse", async () => {
    const jobs = await themuseFetcher.fetch(ctx);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(j.source).toBe("themuse");
      expect(j.externalId).toBeTruthy();
      expect(j.url).toMatch(/^https?:\/\//);
    }
  });

  it("joins multiple locations and detects remote", async () => {
    const jobs = await themuseFetcher.fetch(ctx);
    expect(jobs[0]?.externalId).toMatch(/^\d+$/);
    expect(jobs[0]?.location).toBe("New York, NY; San Francisco, CA; Seattle, WA");
  });

  it("detects remote when a location name matches /remote|flexible/i", async () => {
    const data = fixture as { results: Record<string, unknown>[] };
    const base = data.results[0] as Record<string, unknown>;
    const remoteJob = { ...base, id: 999001, locations: [{ name: "Remote" }] };
    const flexibleJob = { ...base, id: 999002, locations: [{ name: "Flexible / Anywhere" }] };
    const onsiteJob = { ...base, id: 999003, locations: [{ name: "Austin, TX" }] };
    const mixed: FetchContext = { ...ctx, fetchJson: async () => ({ results: [remoteJob, flexibleJob, onsiteJob] }) };
    const jobs = await themuseFetcher.fetch(mixed);
    expect(jobs.find((j) => j.externalId === "999001")?.remoteMode).toBe("remote");
    expect(jobs.find((j) => j.externalId === "999002")?.remoteMode).toBe("remote");
    expect(jobs.find((j) => j.externalId === "999003")?.remoteMode).toBe("unknown");
  });

  it("skips malformed items instead of throwing", async () => {
    const data = fixture as { results: unknown[] };
    const broken: FetchContext = {
      ...ctx,
      fetchJson: async () => ({ results: [{ id: 1 }, ...data.results] }),
    };
    const jobs = await themuseFetcher.fetch(broken);
    expect(jobs.length).toBeGreaterThan(0); // the bad item is dropped, the rest survive
  });
});
