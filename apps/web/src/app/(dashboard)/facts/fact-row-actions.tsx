"use client";

import { useActionState } from "react";
import { Button } from "../../../components/button.js";
import { CONTROL_CLASSES } from "../../../components/field.js";
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
 *
 * Neither action is `irreversible`-toned: archiving is a soft delete (the row
 * disappears from this list, not from the workspace) and re-verifying just
 * bumps a date — neither touches anything outside CareerHQ, which is what
 * that tone is reserved for.
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
    <div className="flex flex-wrap items-center gap-2">
      <form action={reverify} className="flex items-center gap-2">
        <input type="hidden" name="id" value={factId} />
        <input
          type="date" name="reviewBy" defaultValue={reviewByDefault} required
          aria-label="Review by" className={CONTROL_CLASSES}
        />
        <Button type="submit" tone="default">Re-verify</Button>
      </form>
      <form action={archive}>
        <input type="hidden" name="id" value={factId} />
        <Button type="submit" tone="default">Archive</Button>
      </form>
      {refusal && (
        <p className="text-xs text-bad" role="alert">
          Not applied — {refusal.reason}.
        </p>
      )}
    </div>
  );
}
