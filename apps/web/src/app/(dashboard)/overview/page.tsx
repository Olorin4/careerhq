import { inArray } from "drizzle-orm";
import { listApplications, jobs as jobsTable, companies as companiesTable } from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { getActiveWorkspace } from "../../../lib/workspace.js";

function humanize(state: string): string {
  return state.charAt(0) + state.slice(1).toLowerCase().replace(/_/g, " ");
}

export default async function OverviewPage() {
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  const apps = await listApplications(db, ws.id);

  const now = Date.now();
  const soon = now + 3 * 24 * 60 * 60 * 1000;
  const due = apps
    .filter((a) => a.nextActionDue && a.nextActionDue.getTime() <= soon)
    .sort((a, b) => a.nextActionDue!.getTime() - b.nextActionDue!.getTime());

  const counts = new Map<string, number>();
  for (const a of apps) counts.set(a.state, (counts.get(a.state) ?? 0) + 1);

  const jobRows = due.length
    ? await db.select().from(jobsTable).where(inArray(jobsTable.id, due.map((a) => a.jobId)))
    : [];
  const companyRows = jobRows.length
    ? await db.select().from(companiesTable)
        .where(inArray(companiesTable.id, jobRows.map((j) => j.companyId!).filter(Boolean)))
    : [];

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
                  {a.nextActionDue!.toLocaleDateString()}
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
