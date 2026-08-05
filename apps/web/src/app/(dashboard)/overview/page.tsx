import { inArray } from "drizzle-orm";
import { listApplications, jobs as jobsTable, companies as companiesTable } from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { readWorkspaceSnapshot } from "../../../lib/workspace.js";
import { formatDate } from "../../../lib/time.js";

// Every render reads the database, so there is nothing to prerender: without
// this Next would build these pages statically (baking in build-time data and
// requiring a reachable database at build time, which the container image has
// no reason to have).
export const dynamic = "force-dynamic";

function humanize(state: string): string {
  return state.charAt(0) + state.slice(1).toLowerCase().replace(/_/g, " ");
}

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
    <main>
      <h1>Overview</h1>

      <h2>Due follow-ups</h2>
      {due.length === 0 ? (
        <p className="board-empty">Nothing due in the next 3 days</p>
      ) : (
        <ul className="overview-due-list">
          {due.map((a) => {
            const job = jobRows.find((j) => j.id === a.jobId);
            const company = companyRows.find((c) => c.id === job?.companyId);
            const overdue = a.nextActionDue!.getTime() < now;
            return (
              <li key={a.id} className={overdue ? "overview-due-overdue" : undefined}>
                <a href={`/applications/${a.id}`}>
                  {company?.name ?? "?"} · {job?.title ?? "?"} — {a.nextAction ?? humanize(a.state)}
                  {" — due "}
                  {formatDate(a.nextActionDue!)}
                </a>
              </li>
            );
          })}
        </ul>
      )}

      <h2>State counts</h2>
      <ul className="overview-counts">
        {[...counts.entries()].map(([state, count]) => (
          <li key={state}>
            {humanize(state)}: {count}
          </li>
        ))}
      </ul>
    </main>
  );
}
