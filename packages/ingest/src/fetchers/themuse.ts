import { normalizedJobSchema, type NormalizedJob } from "@careerhq/contracts";
import type { FetchContext, JobFetcher } from "./types.js";

const URL = "https://www.themuse.com/api/public/jobs?page=1";

export const themuseFetcher: JobFetcher = {
  source: "themuse",
  async fetch(ctx: FetchContext): Promise<NormalizedJob[]> {
    const data = (await ctx.fetchJson(URL)) as { results?: unknown[] };
    const out: NormalizedJob[] = [];
    for (const raw of data.results ?? []) {
      const r = raw as Record<string, unknown>;
      const locations = Array.isArray(r.locations)
        ? (r.locations as Record<string, unknown>[]).map((l) => l.name).filter((n): n is string => typeof n === "string")
        : [];
      const remoteMode = locations.some((name) => /remote|flexible/i.test(name)) ? "remote" : "unknown";
      const company = r.company as Record<string, unknown> | undefined;
      const refs = r.refs as Record<string, unknown> | undefined;
      const parsed = normalizedJobSchema.safeParse({
        source: "themuse",
        externalId: r.id !== undefined && r.id !== null ? String(r.id) : "",
        url: refs?.landing_page,
        title: r.name,
        companyName: company?.name,
        location: locations.join("; ") || undefined,
        remoteMode,
        descriptionMd: r.contents,
        postedAt: r.publication_date,
      });
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  },
};
