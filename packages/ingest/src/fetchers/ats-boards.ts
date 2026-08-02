import { normalizedJobSchema, type AtsType, type NormalizedJob } from "@careerhq/contracts";
import type { FetchContext, JobFetcher } from "./types.js";

/** A single company/board to poll, resolved by the worker from the db at call time. */
export interface WatchlistEntry {
  atsType: AtsType;
  boardSlug: string;
  companyName: string;
}

function greenhouseUrl(slug: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
}
function leverUrl(slug: string): string {
  return `https://api.lever.co/v0/postings/${slug}?mode=json`;
}
function ashbyUrl(slug: string): string {
  return `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
}

function mapGreenhouseJob(raw: unknown, companyName: string): unknown {
  const r = raw as Record<string, unknown>;
  const location = r.location as Record<string, unknown> | undefined;
  const locationName = typeof location?.name === "string" ? location.name : "";
  return {
    source: "ats_boards",
    externalId: r.id !== undefined && r.id !== null ? `gh-${r.id}` : "",
    url: r.absolute_url,
    title: r.title,
    companyName,
    location: locationName || undefined,
    remoteMode: /remote/i.test(locationName) ? "remote" : "unknown",
    descriptionMd: r.content,
    postedAt: r.updated_at,
  };
}

function mapLeverJob(raw: unknown, companyName: string): unknown {
  const r = raw as Record<string, unknown>;
  const categories = r.categories as Record<string, unknown> | undefined;
  const location = typeof categories?.location === "string" ? categories.location : undefined;
  const remoteSource = String(r.workplaceType ?? location ?? "");
  // createdAt is unix MILLISECONDS, not seconds — new Date(ms) directly, no *1000.
  const postedAt = typeof r.createdAt === "number" && Number.isFinite(r.createdAt) ? new Date(r.createdAt) : undefined;
  return {
    source: "ats_boards",
    externalId: r.id !== undefined && r.id !== null ? `lever-${r.id}` : "",
    url: r.hostedUrl,
    title: r.text,
    companyName,
    location,
    remoteMode: /remote/i.test(remoteSource) ? "remote" : "unknown",
    descriptionMd: r.descriptionPlain || r.description,
    postedAt,
  };
}

function mapAshbyJob(raw: unknown, companyName: string): unknown {
  const r = raw as Record<string, unknown>;
  return {
    source: "ats_boards",
    externalId: r.id !== undefined && r.id !== null ? `ashby-${r.id}` : "",
    url: r.jobUrl,
    title: r.title,
    companyName,
    location: typeof r.location === "string" ? r.location : undefined,
    remoteMode: r.isRemote === true ? "remote" : "unknown",
    descriptionMd: r.descriptionHtml,
    postedAt: r.publishedAt,
  };
}

/**
 * Parameterized fetcher over a watchlist of Greenhouse/Lever/Ashby boards. Each entry is polled
 * independently — a broken slug (404, network error, unexpected shape) is logged and skipped so
 * it can't prevent the rest of the watchlist's jobs from returning.
 */
export function makeAtsBoardsFetcher(watchlist: WatchlistEntry[]): JobFetcher {
  return {
    source: "ats_boards",
    async fetch(ctx: FetchContext): Promise<NormalizedJob[]> {
      const out: NormalizedJob[] = [];
      for (const entry of watchlist) {
        try {
          if (entry.atsType === "greenhouse") {
            const data = (await ctx.fetchJson(greenhouseUrl(entry.boardSlug))) as { jobs?: unknown[] };
            for (const raw of data.jobs ?? []) {
              const parsed = normalizedJobSchema.safeParse(mapGreenhouseJob(raw, entry.companyName));
              if (parsed.success) out.push(parsed.data);
            }
          } else if (entry.atsType === "lever") {
            const data = await ctx.fetchJson(leverUrl(entry.boardSlug));
            for (const raw of Array.isArray(data) ? data : []) {
              const parsed = normalizedJobSchema.safeParse(mapLeverJob(raw, entry.companyName));
              if (parsed.success) out.push(parsed.data);
            }
          } else if (entry.atsType === "ashby") {
            const data = (await ctx.fetchJson(ashbyUrl(entry.boardSlug))) as { jobs?: unknown[] };
            for (const raw of data.jobs ?? []) {
              const parsed = normalizedJobSchema.safeParse(mapAshbyJob(raw, entry.companyName));
              if (parsed.success) out.push(parsed.data);
            }
          }
        } catch (err) {
          // One broken board must not kill the rest of the watchlist; log-and-skip per the brief
          // (run-level error accounting stays coarse in P2).
          console.error(
            `ats_boards: failed to fetch ${entry.atsType} board "${entry.boardSlug}" (${entry.companyName}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      return out;
    },
  };
}
