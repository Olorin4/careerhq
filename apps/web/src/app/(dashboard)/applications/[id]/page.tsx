import { notFound } from "next/navigation";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getApplicationDetail, companies as companiesTable } from "@careerhq/db";
import { getDb } from "../../../../lib/db.js";
import { TransitionButtons } from "../transition-buttons.js";

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
