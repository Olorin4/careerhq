"use client";

import { useActionState } from "react";
import { archiveFactAction, reverifyFactAction } from "./actions.js";

/**
 * The re-verify and archive controls for one fact row, lifted out of the
 * server-rendered page into a client component purely so `useActionState` can
 * carry a refusal back.
 *
 * Both actions used to return `void` behind plain `<form action={…}>` tags, so
 * the demo rate limit had nowhere to report itself except by throwing — which
 * a visitor sees as the full-page "Application error" overlay, not as a
 * sentence about waiting. Each form keeps its own state so a throttled archive
 * cannot look like a failed re-verify.
 */
export function FactRowActions({
  factId,
  reviewByDefault,
}: {
  factId: string;
  reviewByDefault: string;
}) {
  const [reverifyState, reverify] = useActionState(reverifyFactAction, null);
  const [archiveState, archive] = useActionState(archiveFactAction, null);
  const refusal = reverifyState ?? archiveState;

  return (
    <div className="fact-row-actions">
      <form action={reverify} className="fact-reverify-form">
        <input type="hidden" name="id" value={factId} />
        <input type="date" name="reviewBy" defaultValue={reviewByDefault} required />
        <button type="submit">Re-verify</button>
      </form>
      <form action={archive}>
        <input type="hidden" name="id" value={factId} />
        <button type="submit">Archive</button>
      </form>
      {refusal && <p className="form-error">Not applied — {refusal.reason}.</p>}
    </div>
  );
}
