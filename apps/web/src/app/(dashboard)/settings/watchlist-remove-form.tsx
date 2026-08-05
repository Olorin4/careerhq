"use client";

import { useActionState } from "react";
import { removeWatchlistEntryAction } from "./actions.js";

/**
 * The Remove button for one watchlist row, as a client component so
 * `useActionState` can carry a refusal back into the table.
 *
 * `removeWatchlistEntryAction` returned `void` behind a plain
 * `<form action={…}>`, which left the demo rate limit no way to report itself
 * but an exception — reaching the visitor as the full-page "Application error"
 * overlay rather than as a reason next to the button they pressed.
 */
export function WatchlistRemoveForm({ entryId }: { entryId: string }) {
  const [state, remove] = useActionState(removeWatchlistEntryAction, null);

  return (
    <form action={remove}>
      <input type="hidden" name="id" value={entryId} />
      <button type="submit">Remove</button>
      {state && <p className="form-error">Not removed — {state.reason}.</p>}
    </form>
  );
}
