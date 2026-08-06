import { inArray } from "drizzle-orm";
import {
  applications as applicationsTable, companies as companiesTable, jobs as jobsTable,
  listPendingSuggestions,
} from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { readWorkspaceSnapshot } from "../../../lib/workspace.js";
import { SuggestionQueue, type SuggestionListItem } from "./suggestions.js";

// Every render reads the database, so there is nothing to prerender: without
// this Next would build these pages statically (baking in build-time data and
// requiring a reachable database at build time, which the container image has
// no reason to have).
export const dynamic = "force-dynamic";

export default async function InboxPage() {
  // One snapshot: a suggestion and the application it is about must come from
  // the same generation of the workspace (see `readWorkspaceSnapshot`).
  const { messages, appRows, jobRows, companyRows } = await readWorkspaceSnapshot(
    getDb(),
    async (tx, ws) => {
      const pending = await listPendingSuggestions(tx, ws.id);

      const applicationIds = [...new Set(
        pending.map((m) => m.applicationId).filter((id): id is string => id !== null),
      )];
      const apps = applicationIds.length
        ? await tx.select().from(applicationsTable).where(inArray(applicationsTable.id, applicationIds))
        : [];
      const jobs = apps.length
        ? await tx.select().from(jobsTable).where(inArray(jobsTable.id, apps.map((a) => a.jobId)))
        : [];
      const companies = jobs.length
        ? await tx.select().from(companiesTable)
            .where(inArray(companiesTable.id, jobs.map((j) => j.companyId!).filter(Boolean)))
        : [];

      return { messages: pending, appRows: apps, jobRows: jobs, companyRows: companies };
    },
  );

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
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold text-ink">Mail</h1>
      <SuggestionQueue suggestions={suggestions} />
    </div>
  );
}
