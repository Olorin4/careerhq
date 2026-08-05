import { listIngestRuns } from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { timeAgo } from "../../../lib/time.js";

interface ErrorItem {
  message: string;
}

export async function IngestHealth({ workspaceId }: { workspaceId: string }) {
  const db = getDb();
  const runs = await listIngestRuns(db, workspaceId);
  // One reading for the whole table, so every row's age is measured against
  // the same instant and two rows a millisecond apart cannot land in different
  // buckets. This is a server component — it never hydrates — so unlike the
  // email settings table it needs no prop, only a single decision.
  const now = Date.now();

  if (runs.length === 0) {
    return (
      <p>
        No ingestion runs yet — the worker runs on a schedule, or trigger one via the worker.
      </p>
    );
  }

  return (
    <table className="ingest-health-table">
      <thead>
        <tr>
          <th>Source</th>
          <th>Started</th>
          <th>Duration</th>
          <th>Fetched</th>
          <th>Inserted</th>
          <th>Updated</th>
          <th>Duplicates</th>
          <th>Errors</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => {
          const duration = run.finishedAt && run.startedAt
            ? `${Math.round((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000)}s`
            : "—";

          // Defensively coerce errors to array; handle both array and non-array shapes
          const errorsList = Array.isArray(run.errors) ? run.errors : [];

          return (
            <tr key={run.id}>
              <td>{run.source}</td>
              <td>{timeAgo(run.startedAt, now)}</td>
              <td>{duration}</td>
              <td>{run.fetched}</td>
              <td>{run.inserted}</td>
              <td>{run.updated}</td>
              <td>{run.duplicates}</td>
              <td>
                {errorsList.length > 0 ? (
                  <details className="ingest-error-details">
                    <summary className="badge badge-error">
                      {errorsList.length}
                      {" "}
                      error
                      {errorsList.length > 1 ? "s" : ""}
                    </summary>
                    <div className="ingest-error-messages">
                      <ul>
                        {errorsList.map((item, idx) => {
                          const message = (item as ErrorItem)?.message ?? String(item);
                          return (
                            <li key={idx}>{message}</li>
                          );
                        })}
                      </ul>
                    </div>
                  </details>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
