import { listReusableAnswers } from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { readWorkspaceSnapshot } from "../../../lib/workspace.js";
import { formatDate } from "../../../lib/time.js";
import { Badge } from "../../../components/badge.js";
import { EmptyState } from "../../../components/empty-state.js";
import { Row } from "../../../components/row.js";

// Every render reads the database, so there is nothing to prerender: without
// this Next would build this page statically (baking in build-time data and
// requiring a reachable database at build time, which the container image has
// no reason to have).
export const dynamic = "force-dynamic";

export default async function AnswersPage() {
  // Already ordered by questionNorm ascending (listReusableAnswers), which is
  // the alphabetical grouping the brief asks for — a flat list in that order,
  // same convention as the fact bank's per-category lists. One snapshot for
  // the workspace and its answers (see `readWorkspaceSnapshot`).
  const answers = await readWorkspaceSnapshot(getDb(), (tx, ws) => listReusableAnswers(tx, ws.id));

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold text-ink">Answer bank</h1>
      <p className="text-sm text-muted">
        Reusable answers approved from applications, available to reuse anywhere in this
        workspace.
      </p>
      {answers.length === 0 ? (
        <EmptyState
          title="No reusable answers yet"
          hint="Approve an answer from an application's screening Q&A to add one."
        />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {answers.map((answer) => (
            <li key={answer.id}>
              <Row testId="answers-row">
                <div className="flex flex-1 flex-col gap-1">
                  <p className="m-0 font-semibold text-ink">{answer.questionRaw}</p>
                  <p className="m-0 whitespace-pre-wrap text-sm text-ink">{answer.answer}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {/* A stale answer is something the user must act on
                        (re-verify or retire it) — `warn`, per the same rule
                        applied on `/facts`. */}
                    {answer.staleForReuse && <Badge tone="warn">Stale</Badge>}
                    <span className="text-xs text-soft">
                      {answer.sourceFactIds.length} source fact
                      {answer.sourceFactIds.length === 1 ? "" : "s"}
                    </span>
                    <span className="text-xs text-soft">
                      Approved{" "}
                      {answer.approvedAt ? formatDate(answer.approvedAt) : "—"}
                    </span>
                  </div>
                </div>
              </Row>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
