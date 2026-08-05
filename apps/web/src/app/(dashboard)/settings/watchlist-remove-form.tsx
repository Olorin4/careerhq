"use client";

import { useActionState } from "react";
import { Button } from "../../../components/button.js";
import { removeWatchlistEntryAction } from "./actions.js";

/**
 * The Remove button for one watchlist row, as a client component so
 * `useActionState` can carry a refusal back into the table.
 *
 * `removeWatchlistEntryAction` returned `void` behind a plain
 * `<form action={…}>`, which left the demo rate limit no way to report itself
 * but an exception — reaching the visitor as the full-page "Application error"
 * overlay rather than as a reason next to the button they pressed.
 *
 * Not `irreversible`-toned: removing a company only drops it from this
 * workspace's watchlist (re-addable any time) — it doesn't touch anything
 * outside CareerHQ.
 */
export function WatchlistRemoveForm({ entryId }: { entryId: string }) {
  const [state, remove] = useActionState(removeWatchlistEntryAction, null);

  return (
    <form action={remove} className="flex flex-col items-start gap-1">
      <input type="hidden" name="id" value={entryId} />
      <Button type="submit" tone="default">Remove</Button>
      {state && (
        <p className="m-0 text-xs text-bad" role="alert">
          Not removed — {state.reason}.
        </p>
      )}
    </form>
  );
}
