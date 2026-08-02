import { normalizedJobSchema, type NormalizedJob } from "@careerhq/contracts";
import type { FetchContext, JobFetcher } from "./types.js";

const URL = "https://remoteok.com/api";

export const remoteokFetcher: JobFetcher = {
  source: "remoteok",
  async fetch(ctx: FetchContext): Promise<NormalizedJob[]> {
    const data = (await ctx.fetchJson(URL)) as unknown[];
    const out: NormalizedJob[] = [];
    for (const raw of data ?? []) {
      const r = raw as Record<string, unknown>;
      // The first element of the array is a legal notice with no id/position — skip it
      // (and any other malformed element missing either field) before building a candidate.
      if (!r.id || !r.position) continue;
      const salaryRaw = r.salary_min && r.salary_max ? `$${r.salary_min}-$${r.salary_max}` : undefined;
      const parsed = normalizedJobSchema.safeParse({
        source: "remoteok",
        externalId: String(r.id),
        url: r.url,
        title: r.position,
        companyName: r.company,
        location: r.location || undefined,
        remoteMode: "remote",
        salaryRaw,
        descriptionMd: r.description,
        postedAt: r.date,
      });
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  },
};
