import type { ScoringProfile } from "@careerhq/contracts";

export const SCORE_WEIGHTS = { role: 3, roleTitleMultiplier: 2, stack: 2, boost: 1 } as const;

export interface ScoreBreakdownEntry {
  term: string; kind: "role" | "stack" | "boost" | "exclude";
  inTitle: boolean; points: number;
}
export interface JobScore {
  score: number; excluded: boolean; excludedBy: string[];
  remoteFiltered: boolean; meetsMinimums: boolean;
  breakdown: ScoreBreakdownEntry[];
}

export function scoreJob(
  job: { title: string; descriptionMd?: string | null; remoteMode?: string | null },
  profile: ScoringProfile,
): JobScore {
  const title = job.title.toLowerCase();
  const body = `${title}\n${(job.descriptionMd ?? "").toLowerCase()}`;
  const breakdown: ScoreBreakdownEntry[] = [];
  const excludedBy: string[] = [];
  let roleHits = 0, stackHits = 0, score = 0;

  const scan = (terms: string[], kind: "role" | "stack" | "boost", base: number) => {
    for (const raw of terms) {
      const term = raw.toLowerCase();
      if (!term || !body.includes(term)) continue;
      const inTitle = title.includes(term);
      const points = kind === "role" && inTitle ? base * SCORE_WEIGHTS.roleTitleMultiplier : base;
      breakdown.push({ term: raw, kind, inTitle, points });
      score += points;
      if (kind === "role") roleHits += 1;
      if (kind === "stack") stackHits += 1;
    }
  };
  scan(profile.roles, "role", SCORE_WEIGHTS.role);
  scan(profile.stack, "stack", SCORE_WEIGHTS.stack);
  scan(profile.boost, "boost", SCORE_WEIGHTS.boost);

  for (const raw of profile.exclude) {
    const term = raw.toLowerCase();
    if (term && body.includes(term)) {
      excludedBy.push(raw);
      breakdown.push({ term: raw, kind: "exclude", inTitle: title.includes(term), points: 0 });
    }
  }
  const excluded = excludedBy.length > 0;

  const mode = job.remoteMode ?? "unknown";
  // "hybrid" still requires being on site part of the week, so requireRemote
  // filters it exactly like "onsite".
  const remoteFiltered = profile.requireRemote &&
    (mode === "onsite" || mode === "hybrid"
      || ((mode === "unknown") && !profile.includeUnknownRemote));

  return {
    score: excluded || remoteFiltered ? 0 : score,
    excluded, excludedBy, remoteFiltered,
    meetsMinimums: roleHits >= profile.minRoleHits && stackHits >= profile.minStackHits,
    breakdown,
  };
}
