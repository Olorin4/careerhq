import { listIngestRuns } from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { timeAgo } from "../../../lib/time.js";

interface ErrorsRecord {
  [key: string]: string | string[] | undefined;
}

export async function IngestHealth({ workspaceId }: { workspaceId: string }) {
  const db = getDb();
  const runs = await listIngestRuns(db, workspaceId);

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

          return (
            <tr key={run.id}>
              <td>{run.source}</td>
              <td>{timeAgo(run.startedAt)}</td>
              <td>{duration}</td>
              <td>{run.fetched}</td>
              <td>{run.inserted}</td>
              <td>{run.updated}</td>
              <td>{run.duplicates}</td>
              <td>
                {run.errors ? (
                  <details className="ingest-error-details">
                    <summary className="badge badge-error">
                      {Object.keys(run.errors).length}
                      {" "}
                      error
                      {Object.keys(run.errors).length > 1 ? "s" : ""}
                    </summary>
                    <div className="ingest-error-messages">
                      {Object.entries(run.errors as ErrorsRecord).map(([key, value]) => {
                        const messages = Array.isArray(value) ? value : [value];
                        return (
                          <div key={key}>
                            <strong>{key}:</strong>
                            <ul>
                              {messages.map((msg, idx) => (
                                <li key={idx}>{msg}</li>
                              ))}
                            </ul>
                          </div>
                        );
                      })}
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
