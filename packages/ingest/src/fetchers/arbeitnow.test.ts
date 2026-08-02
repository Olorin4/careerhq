import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { arbeitnowFetcher } from "./arbeitnow.js";
import type { FetchContext } from "./types.js";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/arbeitnow.json", import.meta.url), "utf8"));
const ctx: FetchContext = {
  fetchJson: async () => fixture,
  fetchText: async () => { throw new Error("unused"); },
};

describe("arbeitnow fetcher", () => {
  it("normalizes fixture items with source arbeitnow", async () => {
    const jobs = await arbeitnowFetcher.fetch(ctx);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(j.source).toBe("arbeitnow");
      expect(j.externalId).toBeTruthy();
      expect(j.url).toMatch(/^https?:\/\//);
    }
  });

  it("maps unix created_at to postedAt and remote flag to remoteMode", async () => {
    const jobs = await arbeitnowFetcher.fetch(ctx);
    expect(jobs[0]?.postedAt).toBeInstanceOf(Date);
    expect(["remote", "unknown"]).toContain(jobs[0]?.remoteMode);
  });

  it("maps remote: true to remoteMode remote and remote: false to unknown", async () => {
    const data = fixture as { data: Record<string, unknown>[] };
    const base = data.data[0] as Record<string, unknown>;
    const remoteTrue = { ...base, slug: "synthetic-remote-true", remote: true };
    const remoteFalse = { ...base, slug: "synthetic-remote-false", remote: false };
    const mixed: FetchContext = {
      ...ctx,
      fetchJson: async () => ({ data: [remoteTrue, remoteFalse] }),
    };
    const jobs = await arbeitnowFetcher.fetch(mixed);
    const trueJob = jobs.find((j) => j.externalId === "synthetic-remote-true");
    const falseJob = jobs.find((j) => j.externalId === "synthetic-remote-false");
    expect(trueJob?.remoteMode).toBe("remote");
    expect(falseJob?.remoteMode).toBe("unknown");
  });

  it("skips malformed items instead of throwing", async () => {
    const data = fixture as { data: unknown[] };
    const broken: FetchContext = {
      ...ctx,
      fetchJson: async () => ({ data: [{ slug: "bad" }, ...data.data] }),
    };
    const jobs = await arbeitnowFetcher.fetch(broken);
    expect(jobs.length).toBeGreaterThan(0); // the bad item is dropped, the rest survive
  });

  it("does not throw when created_at is non-numeric", async () => {
    const data = fixture as { data: Record<string, unknown>[] };
    const base = data.data[0] as Record<string, unknown>;
    const weird: FetchContext = {
      ...ctx,
      fetchJson: async () => ({ data: [{ ...base, slug: "no-date", created_at: "not-a-number" }] }),
    };
    const jobs = await arbeitnowFetcher.fetch(weird);
    const job = jobs.find((j) => j.externalId === "no-date");
    expect(job).toBeDefined();
    expect(job?.postedAt).toBeUndefined();
  });
});
