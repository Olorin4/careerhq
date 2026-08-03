import { notFound } from "next/navigation";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getApplicationDetail, listDocuments, listFacts, companies as companiesTable } from "@careerhq/db";
import { loadConfig } from "@careerhq/config";
import { getDb } from "../../../../lib/db.js";
import { TransitionButtons } from "../transition-buttons.js";
import { Materials } from "./materials.js";

// Every render reads the database, so there is nothing to prerender: without
// this Next would build these pages statically (baking in build-time data and
// requiring a reachable database at build time, which the container image has
// no reason to have).
export const dynamic = "force-dynamic";

function humanize(state: string): string {
  return state.charAt(0) + state.slice(1).toLowerCase().replace(/_/g, " ");
}

export default async function ApplicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const idCheck = z.string().uuid().safeParse(id);
  if (!idCheck.success) notFound();

  const db = getDb();
  const detail = await getApplicationDetail(db, id);
  if (!detail) notFound();
  const { application, job, events } = detail;

  const [company] = job.companyId
    ? await db.select().from(companiesTable).where(eq(companiesTable.id, job.companyId))
    : [];

  const documents = await listDocuments(db, application.id);
  // Includes archived facts: a document generated before a fact was archived
  // should still show that fact's claim as a provenance chip, not "fact
  // removed".
  const facts = await listFacts(db, application.workspaceId, { includeArchived: true });
  const factClaims: Record<string, string> = Object.fromEntries(
    facts.map((fact) => [fact.id, fact.claim] as const),
  );
  const aiAvailable = loadConfig().openrouterApiKey !== null;

  return (
    <main>
      <h1>
        {company?.name ?? "?"} · {job.title}
      </h1>
      {job.url && (
        <p>
          <a href={job.url} target="_blank" rel="noreferrer">
            {job.url}
          </a>
        </p>
      )}
      <p>
        State: <strong>{humanize(application.state)}</strong>
      </p>
      {application.nextAction && (
        <p>
          Next action: {application.nextAction}
          {application.nextActionDue
            ? ` — due ${application.nextActionDue.toLocaleDateString()}`
            : ""}
        </p>
      )}
      {application.notes && (
        <p>
          Notes: {application.notes}
        </p>
      )}
      <TransitionButtons applicationId={application.id} state={application.state} />

      <Materials
        applicationId={application.id}
        documents={documents}
        factClaims={factClaims}
        aiAvailable={aiAvailable}
      />

      <h2>Event timeline</h2>
      <ol className="detail-timeline">
        {events.map((event) => (
          <li key={event.id}>
            {event.createdAt.toISOString()} — {event.fromState ?? "·"} → {event.toState} (
            {event.trigger})
          </li>
        ))}
      </ol>
    </main>
  );
}
