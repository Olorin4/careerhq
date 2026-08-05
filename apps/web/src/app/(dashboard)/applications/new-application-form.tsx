"use client";

import { useActionState, useState } from "react";
import { createApplicationAction } from "./actions.js";

/**
 * Driven through `useActionState` rather than a plain `<form action={…}>` so a
 * refusal — the demo rate limit, or a field past its length cap — renders here
 * instead of throwing. Same pattern as `CvUploadForm` and the manual-draft
 * form, and for the same reason: a thrown server-action failure reaches the
 * visitor as Next's full-page "Application error" overlay.
 *
 * Every text input re-seeds its `defaultValue` from the values the refusal
 * carried back. React resets an uncontrolled form once its action resolves, so
 * without that, "try again in 40s" would also silently empty everything just
 * typed. `external` is React state and survives on its own.
 */
export function NewApplicationForm() {
  const [external, setExternal] = useState(false);
  const [state, submit] = useActionState(createApplicationAction, null);
  const typed = state?.values ?? {};

  return (
    <form action={submit} className="new-application-form">
      <h2>Log application</h2>
      <label>
        Company
        <input name="companyName" type="text" required defaultValue={typed.companyName ?? ""} />
      </label>
      <label>
        Job title
        <input name="jobTitle" type="text" required defaultValue={typed.jobTitle ?? ""} />
      </label>
      <label>
        Job URL
        <input name="jobUrl" type="url" defaultValue={typed.jobUrl ?? ""} />
      </label>
      <label>
        Notes
        <textarea name="notes" defaultValue={typed.notes ?? ""} />
      </label>
      <label className="new-application-form-checkbox">
        <input
          name="external"
          type="checkbox"
          checked={external}
          onChange={(e) => setExternal(e.target.checked)}
        />
        Already applied elsewhere
      </label>
      {external && (
        <label>
          Submitted on
          <input name="submittedAt" type="date" required defaultValue={typed.submittedAt ?? ""} />
        </label>
      )}
      <button type="submit">Log application</button>
      {state && <p className="form-error">Not logged — {state.reason}.</p>}
    </form>
  );
}
