import { inArray } from "drizzle-orm";
import {
  applications as applicationsTable, companies as companiesTable, jobs as jobsTable,
  listPendingSuggestions,
} from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { getActiveWorkspace } from "../../../lib/workspace.js";
import { SuggestionQueue, type SuggestionListItem } from "./suggestions.js";

// Every render reads the database, so there is nothing to prerender: without
// this Next would build these pages statically (baking in build-time data and
// requiring a reachable database at build time, which the container image has
// no reason to have).
export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  const messages = await listPendingSuggestions(db, ws.id);

  const applicationIds = [...new Set(
    messages.map((m) => m.applicationId).filter((id): id is string => id !== null),
  )];
  const appRows = applicationIds.length
    ? await db.select().from(applicationsTable).where(inArray(applicationsTable.id, applicationIds))
    : [];
  const jobRows = appRows.length
    ? await db.select().from(jobsTable).where(inArray(jobsTable.id, appRows.map((a) => a.jobId)))
    : [];
  const companyRows = jobRows.length
    ? await db.select().from(companiesTable)
        .where(inArray(companiesTable.id, jobRows.map((j) => j.companyId!).filter(Boolean)))
    : [];

  const suggestions: SuggestionListItem[] = messages.map((m) => {
    const application = m.applicationId ? appRows.find((a) => a.id === m.applicationId) : undefined;
    const job = application ? jobRows.find((j) => j.id === application.jobId) : undefined;
    const company = job ? companyRows.find((c) => c.id === job.companyId) : undefined;
    return {
      id: m.id,
      fromAddr: m.fromAddr,
      subject: m.subject,
      snippet: m.snippet,
      receivedAt: m.receivedAt.toISOString(),
      classification: m.classification,
      classificationConfidence: m.classificationConfidence,
      suggestedTransition: m.suggestedTransition,
      quotedEvidence: m.quotedEvidence,
      application: application && job
        ? { id: application.id, company: company?.name ?? "?", title: job.title, state: application.state }
        : null,
    };
  });

  return (
    <main>
      <h1>Mail</h1>
      <SuggestionQueue suggestions={suggestions} />
    </main>
  );
}
