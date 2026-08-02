import { listApplications, jobs as jobsTable, companies as companiesTable } from "@careerhq/db";
import { inArray } from "drizzle-orm";
import { getDb } from "../../../lib/db.js";
import { getActiveWorkspace } from "../../../lib/workspace.js";
import { Board } from "./board.js";
import { NewApplicationForm } from "./new-application-form.js";

export default async function ApplicationsPage() {
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  const apps = await listApplications(db, ws.id);
  const jobRows = apps.length
    ? await db.select().from(jobsTable).where(inArray(jobsTable.id, apps.map((a) => a.jobId)))
    : [];
  const companyRows = jobRows.length
    ? await db.select().from(companiesTable)
        .where(inArray(companiesTable.id, jobRows.map((j) => j.companyId!).filter(Boolean)))
    : [];
  const cards = apps.map((a) => {
    const job = jobRows.find((j) => j.id === a.jobId);
    const company = companyRows.find((c) => c.id === job?.companyId);
    return {
      id: a.id, state: a.state, title: job?.title ?? "?", company: company?.name ?? "?",
      nextAction: a.nextAction, nextActionDue: a.nextActionDue?.toISOString() ?? null,
    };
  });
  return (
    <main>
      <h1>Applications</h1>
      <NewApplicationForm />
      <Board cards={cards} />
    </main>
  );
}
