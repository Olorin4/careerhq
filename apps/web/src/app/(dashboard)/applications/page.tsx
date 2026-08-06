import { listApplications, jobs as jobsTable, companies as companiesTable } from "@careerhq/db";
import { inArray } from "drizzle-orm";
import { getDb } from "../../../lib/db.js";
import { readWorkspaceSnapshot } from "../../../lib/workspace.js";
import { Board } from "./board.js";
import { NewApplicationForm } from "./new-application-form.js";

// Every render reads the database, so there is nothing to prerender: without
// this Next would build these pages statically (baking in build-time data and
// requiring a reachable database at build time, which the container image has
// no reason to have).
export const dynamic = "force-dynamic";

export default async function ApplicationsPage() {
  // One snapshot for the whole board: resolving the workspace and listing its
  // applications are two statements, and the demo reset's commit used to be
  // able to land between them and empty the board.
  const { apps, jobRows, companyRows } = await readWorkspaceSnapshot(getDb(), async (tx, ws) => {
    const rows = await listApplications(tx, ws.id);
    const jobs = rows.length
      ? await tx.select().from(jobsTable).where(inArray(jobsTable.id, rows.map((a) => a.jobId)))
      : [];
    const companies = jobs.length
      ? await tx.select().from(companiesTable)
          .where(inArray(companiesTable.id, jobs.map((j) => j.companyId!).filter(Boolean)))
      : [];
    return { apps: rows, jobRows: jobs, companyRows: companies };
  });
  const cards = apps.map((a) => {
    const job = jobRows.find((j) => j.id === a.jobId);
    const company = companyRows.find((c) => c.id === job?.companyId);
    return {
      id: a.id, state: a.state, title: job?.title ?? "?", company: company?.name ?? "?",
      nextAction: a.nextAction, nextActionDue: a.nextActionDue?.toISOString() ?? null,
    };
  });
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold text-ink">Applications</h1>
      <NewApplicationForm />
      <Board cards={cards} />
    </div>
  );
}
