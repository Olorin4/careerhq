import { inArray } from "drizzle-orm";
import { listApplications, jobs as jobsTable, companies as companiesTable } from "@careerhq/db";
import { APPLICATION_STATES } from "@careerhq/contracts";
import { getDb } from "../../../lib/db.js";
import { readWorkspaceSnapshot } from "../../../lib/workspace.js";
import { formatDate } from "../../../lib/time.js";
import { STATE_TONE } from "../../../lib/application-state.js";
import { Badge, type BadgeTone } from "../../../components/badge.js";
import { Card } from "../../../components/card.js";
import { EmptyState } from "../../../components/empty-state.js";
import { Row } from "../../../components/row.js";
import { Section } from "../../../components/section.js";

// Every render reads the database, so there is nothing to prerender: without
// this Next would build these pages statically (baking in build-time data and
// requiring a reachable database at build time, which the container image has
// no reason to have).
export const dynamic = "force-dynamic";

function humanize(state: string): string {
  return state.charAt(0) + state.slice(1).toLowerCase().replace(/_/g, " ");
}

const TONE_TEXT: Record<BadgeTone, string> = {
  neutral: "text-muted",
  info: "text-info",
  warn: "text-warn",
  ok: "text-ok",
  bad: "text-bad",
};

export default async function OverviewPage() {
  const now = Date.now();
  const soon = now + 3 * 24 * 60 * 60 * 1000;

  // One snapshot for the whole page: the state counts below are counts OF the
  // applications resolved here, and a demo reset committing between the two
  // reads is what let a visitor see this workspace with none.
  const { due, jobRows, companyRows, counts } = await readWorkspaceSnapshot(getDb(), async (tx, ws) => {
    const apps = await listApplications(tx, ws.id);

    const dueApps = apps
      .filter((a) => a.nextActionDue && a.nextActionDue.getTime() <= soon)
      .sort((a, b) => a.nextActionDue!.getTime() - b.nextActionDue!.getTime());

    const stateCounts = new Map<string, number>();
    for (const a of apps) stateCounts.set(a.state, (stateCounts.get(a.state) ?? 0) + 1);

    const jobs = dueApps.length
      ? await tx.select().from(jobsTable).where(inArray(jobsTable.id, dueApps.map((a) => a.jobId)))
      : [];
    const companies = jobs.length
      ? await tx.select().from(companiesTable)
          .where(inArray(companiesTable.id, jobs.map((j) => j.companyId!).filter(Boolean)))
      : [];

    return { due: dueApps, jobRows: jobs, companyRows: companies, counts: stateCounts };
  });

  return (
    <main className="flex flex-col gap-8">
      <h1 className="text-2xl font-semibold text-ink">Overview</h1>

      {/* Every stage renders, including ones at zero — this is the whole
          pipeline, not just the stages that happen to be occupied right now.
          A freshly-reset demo workspace shows eleven honest zeroes here
          rather than an empty section, which is the point: an empty state
          that looks broken is a bug (see the brief). Zero-count stages are
          dimmed to `text-soft` so the tone colours stay reserved for stages
          that actually have something in them. */}
      <Section title="Funnel">
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3 p-0">
          {APPLICATION_STATES.map((state) => {
            const count = counts.get(state) ?? 0;
            const valueClass = count > 0 ? TONE_TEXT[STATE_TONE[state]] : "text-soft";
            return (
              <li key={state} data-testid="overview-counts-item">
                <Card className="flex flex-col gap-1">
                  <span className={`text-2xl font-semibold tabular-nums ${valueClass}`}>{count}</span>
                  <span className="text-xs text-muted">{humanize(state)}</span>
                </Card>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Due follow-ups">
        {due.length === 0 ? (
          <EmptyState title="Nothing due" hint="No follow-ups are due in the next 3 days." />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {due.map((a) => {
              const job = jobRows.find((j) => j.id === a.jobId);
              const company = companyRows.find((c) => c.id === job?.companyId);
              const overdue = a.nextActionDue!.getTime() < now;
              return (
                <li key={a.id}>
                  <Row href={`/applications/${a.id}`} testId="overview-due-item">
                    <div className="flex flex-1 flex-col gap-1">
                      <p className="m-0 font-semibold text-ink">
                        {company?.name ?? "?"} · {job?.title ?? "?"}
                      </p>
                      <p className="m-0 text-sm text-muted">
                        {a.nextAction ?? humanize(a.state)} — due {formatDate(a.nextActionDue!)}
                      </p>
                    </div>
                    {/* The one thing on this page that is genuinely on the
                        applicant, not the system — `warn`, same reading the
                        fact bank gives staleness. */}
                    {overdue && <Badge tone="warn">Overdue</Badge>}
                  </Row>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </main>
  );
}
