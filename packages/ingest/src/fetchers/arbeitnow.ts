import { normalizedJobSchema, type NormalizedJob } from "@careerhq/contracts";
import type { FetchContext, JobFetcher } from "./types.js";

const URL = "https://www.arbeitnow.com/api/job-board-api";

export const arbeitnowFetcher: JobFetcher = {
  source: "arbeitnow",
  async fetch(ctx: FetchContext): Promise<NormalizedJob[]> {
    const data = (await ctx.fetchJson(URL)) as { data?: unknown[] };
    const out: NormalizedJob[] = [];
    for (const raw of data.data ?? []) {
      const r = raw as Record<string, unknown>;
      // created_at is unix seconds. z.coerce.date() on an Invalid Date fails validation,
      // so pass undefined when created_at isn't a finite number — the item still survives,
      // just without a postedAt — instead of letting the whole item get dropped.
      const postedAt = typeof r.created_at === "number" && Number.isFinite(r.created_at)
        ? new Date(r.created_at * 1000)
        : undefined;
      const parsed = normalizedJobSchema.safeParse({
        source: "arbeitnow",
        externalId: r.slug,
        url: r.url,
        title: r.title,
        companyName: r.company_name,
        location: r.location || undefined,
        remoteMode: r.remote === true ? "remote" : "unknown",
        descriptionMd: r.description,
        postedAt,
      });
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  },
};
