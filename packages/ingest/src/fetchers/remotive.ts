import { normalizedJobSchema, type NormalizedJob } from "@careerhq/contracts";
import type { FetchContext, JobFetcher } from "./types.js";

const URL = "https://remotive.com/api/remote-jobs?category=software-dev&limit=100";

export const remotiveFetcher: JobFetcher = {
  source: "remotive",
  async fetch(ctx: FetchContext): Promise<NormalizedJob[]> {
    const data = (await ctx.fetchJson(URL)) as { jobs?: unknown[] };
    const out: NormalizedJob[] = [];
    for (const raw of data.jobs ?? []) {
      const r = raw as Record<string, unknown>;
      const parsed = normalizedJobSchema.safeParse({
        source: "remotive",
        externalId: String(r.id ?? ""),
        url: r.url,
        title: r.title,
        companyName: r.company_name,
        location: r.candidate_required_location,
        remoteMode: "remote",
        salaryRaw: r.salary || undefined,
        descriptionMd: r.description,
        postedAt: r.publication_date,
      });
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  },
};
