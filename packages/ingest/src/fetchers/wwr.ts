import { normalizedJobSchema, type NormalizedJob } from "@careerhq/contracts";
import { XMLParser } from "fast-xml-parser";
import type { FetchContext, JobFetcher } from "./types.js";

const URL = "https://weworkremotely.com/remote-jobs.rss";

// Job description bodies in this feed are HTML escaped inline (lots of &amp;/&lt;/&gt;), which
// routinely exceeds fast-xml-parser's default entity-expansion guard (1000 total refs) on a
// normal-sized feed. Raise the expanded-length ceiling instead of disabling the guard outright;
// passing an object form also lifts the total-expansion count cap to Infinity (its documented
// default when maxTotalExpansions isn't set), which is what actually trips on this feed.
const parser = new XMLParser({
  ignoreAttributes: false,
  processEntities: { maxExpandedLength: 5_000_000 },
});

/** WWR guid nodes may parse as a plain string or as `{ "#text": string }` when the node has attributes. */
function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "#text" in value) {
    const text = (value as Record<string, unknown>)["#text"];
    return typeof text === "string" ? text : undefined;
  }
  return undefined;
}

/** WWR titles are "Company: Role" — split on the FIRST ": "; no separator → companyName "Unknown". */
function splitTitle(title: string): { companyName: string; role: string } {
  const idx = title.indexOf(": ");
  if (idx === -1) return { companyName: "Unknown", role: title };
  return { companyName: title.slice(0, idx), role: title.slice(idx + 2) };
}

export const wwrFetcher: JobFetcher = {
  source: "wwr",
  async fetch(ctx: FetchContext): Promise<NormalizedJob[]> {
    const xml = await ctx.fetchText(URL);
    const parsed = parser.parse(xml) as {
      rss?: { channel?: { item?: unknown } };
    };
    const rawItems = parsed.rss?.channel?.item ?? [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];
    const out: NormalizedJob[] = [];
    for (const raw of items) {
      const r = raw as Record<string, unknown>;
      const title = typeof r.title === "string" ? r.title : "";
      const { companyName, role } = splitTitle(title);
      const result = normalizedJobSchema.safeParse({
        source: "wwr",
        externalId: textOf(r.guid),
        url: r.link,
        title: role,
        companyName,
        location: (typeof r.region === "string" && r.region) || undefined,
        remoteMode: "remote",
        descriptionMd: r.description,
        postedAt: r.pubDate,
      });
      if (result.success) out.push(result.data);
    }
    return out;
  },
};
