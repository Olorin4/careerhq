import { listReusableAnswers } from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { readWorkspaceSnapshot } from "../../../lib/workspace.js";
import { formatDate } from "../../../lib/time.js";

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
    <main>
      <h1>Answer bank</h1>
      <p className="answers-summary">
        Reusable answers approved from applications, available to reuse anywhere in this
        workspace.
      </p>
      {answers.length === 0 ? (
        <p className="answers-empty">No reusable answers yet.</p>
      ) : (
        <ul className="answers-list">
          {answers.map((answer) => (
            <li key={answer.id} className="answers-row" data-testid="answers-row">
              <p className="answers-question">
                <strong>{answer.questionRaw}</strong>
              </p>
              <p className="answers-text">{answer.answer}</p>
              <div className="answers-meta">
                {answer.staleForReuse && <span className="badge badge-stale">STALE</span>}
                <span className="answers-detail">
                  {answer.sourceFactIds.length} source fact
                  {answer.sourceFactIds.length === 1 ? "" : "s"}
                </span>
                <span className="answers-detail">
                  Approved{" "}
                  {answer.approvedAt ? formatDate(answer.approvedAt) : "—"}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
