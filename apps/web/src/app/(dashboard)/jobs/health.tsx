import { listIngestRuns } from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { timeAgo } from "../../../lib/time.js";
import { EmptyState } from "../../../components/empty-state.js";
import { Table, Td, Th } from "../../../components/table.js";

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
      <EmptyState
        title="No ingestion runs yet"
        hint="The worker runs on a schedule, or trigger one via the worker."
      />
    );
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Source</Th>
          <Th>Started</Th>
          <Th>Duration</Th>
          <Th>Fetched</Th>
          <Th>Inserted</Th>
          <Th>Updated</Th>
          <Th>Duplicates</Th>
          <Th>Errors</Th>
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
              <Td>{run.source}</Td>
              <Td className="tabular-nums">{timeAgo(run.startedAt, now)}</Td>
              <Td className="tabular-nums">{duration}</Td>
              <Td className="tabular-nums">{run.fetched}</Td>
              <Td className="tabular-nums">{run.inserted}</Td>
              <Td className="tabular-nums">{run.updated}</Td>
              <Td className="tabular-nums">{run.duplicates}</Td>
              <Td>
                {errorsList.length > 0 ? (
                  <details>
                    <summary className="inline-flex cursor-pointer items-center rounded-full bg-bad-soft px-2 py-0.5 text-xs font-medium text-bad">
                      {errorsList.length}
                      {" "}
                      error
                      {errorsList.length > 1 ? "s" : ""}
                    </summary>
                    <div className="mt-2 rounded-md border-l-4 border-bad bg-bad-soft p-3 text-sm text-ink">
                      <ul className="m-0 flex list-none flex-col gap-1 p-0">
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
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
