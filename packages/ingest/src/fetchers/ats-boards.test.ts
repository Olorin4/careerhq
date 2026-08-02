import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeAtsBoardsFetcher, type WatchlistEntry } from "./ats-boards.js";
import type { FetchContext } from "./types.js";

const greenhouseFixture = JSON.parse(
  readFileSync(new URL("../../fixtures/greenhouse.json", import.meta.url), "utf8"),
);
const leverFixture = JSON.parse(readFileSync(new URL("../../fixtures/lever.json", import.meta.url), "utf8"));
const ashbyFixture = JSON.parse(readFileSync(new URL("../../fixtures/ashby.json", import.meta.url), "utf8"));

function dispatchingFetchJson(overrides?: Record<string, () => Promise<unknown>>) {
  return async (url: string): Promise<unknown> => {
    for (const [needle, handler] of Object.entries(overrides ?? {})) {
      if (url.includes(needle)) return handler();
    }
    if (url.includes("boards-api.greenhouse")) return greenhouseFixture;
    if (url.includes("api.lever.co")) return leverFixture;
    if (url.includes("api.ashbyhq.com")) return ashbyFixture;
    throw new Error(`unexpected url in test: ${url}`);
  };
}

function makeCtx(overrides?: Record<string, () => Promise<unknown>>): FetchContext {
  return {
    fetchJson: dispatchingFetchJson(overrides),
    fetchText: async () => {
      throw new Error("unused");
    },
  };
}

const watchlist: WatchlistEntry[] = [
  { atsType: "greenhouse", boardSlug: "stripe", companyName: "Stripe Inc" },
  { atsType: "lever", boardSlug: "leverdemo", companyName: "Lever Demo Co" },
  { atsType: "ashby", boardSlug: "ashby", companyName: "Ashby HQ" },
];

describe("ats boards fetcher", () => {
  it("has source 'ats_boards'", () => {
    const fetcher = makeAtsBoardsFetcher(watchlist);
    expect(fetcher.source).toBe("ats_boards");
  });

  it("fetches and normalizes jobs across all three ATS types", async () => {
    const fetcher = makeAtsBoardsFetcher(watchlist);
    const jobs = await fetcher.fetch(makeCtx());
    expect(jobs.length).toBe(6); // 2 fixture jobs x 3 boards
    for (const j of jobs) {
      expect(j.source).toBe("ats_boards");
      expect(j.externalId).toBeTruthy();
      expect(j.url).toMatch(/^https?:\/\//);
      expect(j.title.length).toBeGreaterThan(0);
    }
  });

  it("prefixes externalId per ATS type as a cross-ATS id-collision guard", async () => {
    const fetcher = makeAtsBoardsFetcher(watchlist);
    const jobs = await fetcher.fetch(makeCtx());
    const ghJobs = jobs.filter((j) => j.externalId.startsWith("gh-"));
    const leverJobs = jobs.filter((j) => j.externalId.startsWith("lever-"));
    const ashbyJobs = jobs.filter((j) => j.externalId.startsWith("ashby-"));
    expect(ghJobs).toHaveLength(2);
    expect(leverJobs).toHaveLength(2);
    expect(ashbyJobs).toHaveLength(2);
    expect(ghJobs.some((j) => j.externalId === "gh-7954688")).toBe(true);
    expect(leverJobs.some((j) => j.externalId === "lever-33538a2f-d27d-4a96-8f05-fa4b0e4d940e")).toBe(true);
    expect(ashbyJobs.some((j) => j.externalId === "ashby-86a60834-ba64-484d-9658-afa1bc97a957")).toBe(true);
  });

  it("takes companyName from the watchlist entry, not the API response", async () => {
    const fetcher = makeAtsBoardsFetcher(watchlist);
    const jobs = await fetcher.fetch(makeCtx());
    for (const j of jobs) {
      if (j.externalId.startsWith("gh-")) expect(j.companyName).toBe("Stripe Inc");
      if (j.externalId.startsWith("lever-")) expect(j.companyName).toBe("Lever Demo Co");
      if (j.externalId.startsWith("ashby-")) expect(j.companyName).toBe("Ashby HQ");
    }
    // The greenhouse fixture job itself carries company_name "Stripe" (from the API) — assert we
    // did NOT use that field.
    const gh = jobs.find((j) => j.externalId === "gh-7954688");
    expect(gh?.companyName).not.toBe("Stripe");
  });

  it("maps greenhouse fields: url from absolute_url, title, location.name, remoteMode from /remote/i on location name", async () => {
    const fetcher = makeAtsBoardsFetcher(watchlist);
    const jobs = await fetcher.fetch(makeCtx());
    const onsite = jobs.find((j) => j.externalId === "gh-7954688");
    const remote = jobs.find((j) => j.externalId === "gh-7993151");
    expect(onsite?.url).toBe("https://stripe.com/jobs/search?gh_jid=7954688");
    expect(onsite?.title).toBe("Account Executive, AI Sales (Grower)");
    expect(onsite?.location).toBe("San Francisco, CA");
    expect(onsite?.remoteMode).toBe("unknown");
    expect(remote?.location).toMatch(/remote/i);
    expect(remote?.remoteMode).toBe("remote");
    expect(onsite?.postedAt).toBeInstanceOf(Date);
  });

  it("maps lever fields: url from hostedUrl, title from text, location from categories.location, unix-ms createdAt, remoteMode from workplaceType/location", async () => {
    const fetcher = makeAtsBoardsFetcher(watchlist);
    const jobs = await fetcher.fetch(makeCtx());
    const hybrid = jobs.find((j) => j.externalId === "lever-33538a2f-d27d-4a96-8f05-fa4b0e4d940e");
    const remote = jobs.find((j) => j.externalId === "lever-c559265a-55ec-4f75-ac56-78290081f6e7");
    expect(hybrid?.url).toBe("https://jobs.lever.co/leverdemo/33538a2f-d27d-4a96-8f05-fa4b0e4d940e");
    expect(hybrid?.title).toBe("AbelsonTaylor Writer");
    expect(hybrid?.location).toBe("Arlington, TX");
    expect(hybrid?.remoteMode).toBe("unknown"); // workplaceType "hybrid" doesn't match /remote/i
    expect(remote?.remoteMode).toBe("remote"); // workplaceType "remote"
    // createdAt 1553186035299 is unix milliseconds, not seconds
    expect(hybrid?.postedAt?.getTime()).toBe(1553186035299);
  });

  it("maps ashby fields: url from jobUrl, title, location, remoteMode from isRemote, postedAt from publishedAt", async () => {
    const fetcher = makeAtsBoardsFetcher(watchlist);
    const jobs = await fetcher.fetch(makeCtx());
    const job = jobs.find((j) => j.externalId === "ashby-7458d4e9-da2e-47bd-98cb-adfda43d42b2");
    expect(job?.url).toBe("https://jobs.ashbyhq.com/ashby/7458d4e9-da2e-47bd-98cb-adfda43d42b2");
    expect(job?.title).toBe("Engineering Manager - EU");
    expect(job?.location).toBe("Remote - European Union");
    expect(job?.remoteMode).toBe("remote");
    expect(job?.postedAt).toBeInstanceOf(Date);
  });

  it("sets ashby remoteMode to 'unknown' when isRemote is not exactly true", async () => {
    // The live ashby fixture board happens to be fully remote; exercise the false branch inline.
    const nonRemoteAshby = {
      jobs: [
        {
          id: "synthetic-onsite",
          title: "Office Only Role",
          location: "New York, NY",
          isRemote: false,
          jobUrl: "https://jobs.ashbyhq.com/ashby/synthetic-onsite",
          descriptionHtml: "<p>desc</p>",
          publishedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const fetcher = makeAtsBoardsFetcher([{ atsType: "ashby", boardSlug: "ashby", companyName: "Ashby HQ" }]);
    const ctx = makeCtx({ "api.ashbyhq.com": async () => nonRemoteAshby });
    const jobs = await fetcher.fetch(ctx);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.remoteMode).toBe("unknown");
  });

  it("catches a per-board fetch error and still returns the other boards' jobs", async () => {
    const withBroken: WatchlistEntry[] = [
      ...watchlist,
      { atsType: "greenhouse", boardSlug: "broken-slug", companyName: "Broken Co" },
    ];
    const fetcher = makeAtsBoardsFetcher(withBroken);
    const ctx = makeCtx({
      "broken-slug": async () => {
        throw new Error("board unavailable");
      },
    });
    const jobs = await fetcher.fetch(ctx);
    expect(jobs.length).toBe(6); // the broken board contributes nothing, the other 3 still do
  });

  it("skips malformed items instead of throwing", async () => {
    const brokenGreenhouse = { jobs: [{ id: 1 }, ...(greenhouseFixture as { jobs: unknown[] }).jobs] };
    const fetcher = makeAtsBoardsFetcher([{ atsType: "greenhouse", boardSlug: "stripe", companyName: "Stripe Inc" }]);
    const ctx = makeCtx({ "boards-api.greenhouse": async () => brokenGreenhouse });
    const jobs = await fetcher.fetch(ctx);
    expect(jobs.length).toBe(2); // the malformed item (missing url/title) is dropped, the rest survive
  });
});
