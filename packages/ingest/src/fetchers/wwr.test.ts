import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { wwrFetcher } from "./wwr.js";
import type { FetchContext } from "./types.js";

const fixture = readFileSync(new URL("../../fixtures/wwr.xml", import.meta.url), "utf8");
const ctx: FetchContext = {
  fetchJson: async () => { throw new Error("unused"); },
  fetchText: async () => fixture,
};

describe("wwr fetcher", () => {
  it("normalizes fixture items with source wwr and remote mode", async () => {
    const jobs = await wwrFetcher.fetch(ctx);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) {
      expect(j.source).toBe("wwr");
      expect(j.externalId).toBeTruthy();
      expect(j.url).toMatch(/^https?:\/\//);
      expect(j.remoteMode).toBe("remote");
    }
  });

  it("splits 'Company: Role' titles", async () => {
    const jobs = await wwrFetcher.fetch(ctx);
    expect(jobs[0]?.companyName).not.toContain(":");
    expect(jobs[0]?.title.length).toBeGreaterThan(0);
  });

  it("falls back to companyName 'Unknown' when title has no ': ' separator", async () => {
    const noColonXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss><channel>
  <item>
    <title>Just A Role With No Separator</title>
    <region>Anywhere in the World</region>
    <description>Some description</description>
    <pubDate>Sun, 02 Aug 2026 07:31:05 +0000</pubDate>
    <guid>https://weworkremotely.com/remote-jobs/no-colon</guid>
    <link>https://weworkremotely.com/remote-jobs/no-colon</link>
  </item>
</channel></rss>`;
    const noColonCtx: FetchContext = { ...ctx, fetchText: async () => noColonXml };
    const jobs = await wwrFetcher.fetch(noColonCtx);
    expect(jobs[0]?.companyName).toBe("Unknown");
    expect(jobs[0]?.title).toBe("Just A Role With No Separator");
  });

  it("handles guid as a plain string or as an object with #text", async () => {
    const objectGuidXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss><channel>
  <item>
    <title>Acme: Engineer</title>
    <region>Anywhere in the World</region>
    <description>desc</description>
    <pubDate>Sun, 02 Aug 2026 07:31:05 +0000</pubDate>
    <guid isPermaLink="false">https://weworkremotely.com/remote-jobs/acme-engineer</guid>
    <link>https://weworkremotely.com/remote-jobs/acme-engineer</link>
  </item>
</channel></rss>`;
    const objectGuidCtx: FetchContext = { ...ctx, fetchText: async () => objectGuidXml };
    const jobs = await wwrFetcher.fetch(objectGuidCtx);
    expect(jobs[0]?.externalId).toBe("https://weworkremotely.com/remote-jobs/acme-engineer");
  });

  it("normalizes a single <item> (non-array) into one job", async () => {
    const singleItemXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss><channel>
  <item>
    <title>Solo: Only Job</title>
    <region>Anywhere in the World</region>
    <description>desc</description>
    <pubDate>Sun, 02 Aug 2026 07:31:05 +0000</pubDate>
    <guid>https://weworkremotely.com/remote-jobs/solo-only-job</guid>
    <link>https://weworkremotely.com/remote-jobs/solo-only-job</link>
  </item>
</channel></rss>`;
    const singleItemCtx: FetchContext = { ...ctx, fetchText: async () => singleItemXml };
    const jobs = await wwrFetcher.fetch(singleItemCtx);
    expect(jobs.length).toBe(1);
    expect(jobs[0]?.companyName).toBe("Solo");
  });

  it("skips malformed items instead of throwing", async () => {
    const brokenXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss><channel>
  <item>
    <title>No Link Or Guid</title>
    <region>Anywhere in the World</region>
    <description>desc</description>
    <pubDate>Sun, 02 Aug 2026 07:31:05 +0000</pubDate>
  </item>
</channel></rss>`;
    const brokenCtx: FetchContext = { ...ctx, fetchText: async () => brokenXml };
    const jobs = await wwrFetcher.fetch(brokenCtx);
    expect(jobs.length).toBe(0);
  });
});
