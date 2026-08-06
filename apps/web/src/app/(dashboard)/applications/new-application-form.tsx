"use client";

import { useActionState, useState } from "react";
import { Button } from "../../../components/button.js";
import { Card } from "../../../components/card.js";
import { CONTROL_CLASSES, Field } from "../../../components/field.js";
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
    <Card className="max-w-lg">
      <form action={submit} className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-ink">Log application</h2>
        <Field label="Company">
          <input
            name="companyName" type="text" required defaultValue={typed.companyName ?? ""}
            className={CONTROL_CLASSES}
          />
        </Field>
        <Field label="Job title">
          <input
            name="jobTitle" type="text" required defaultValue={typed.jobTitle ?? ""}
            className={CONTROL_CLASSES}
          />
        </Field>
        <Field label="Job URL">
          <input
            name="jobUrl" type="url" defaultValue={typed.jobUrl ?? ""}
            className={CONTROL_CLASSES}
          />
        </Field>
        <Field label="Notes">
          <textarea
            name="notes" defaultValue={typed.notes ?? ""}
            className={CONTROL_CLASSES}
          />
        </Field>
        {/* A checkbox doesn't fit `Field` — it stacks label above control,
            which draws an empty label line over a lone tickbox. Composed
            inline instead; see `field.tsx`'s `CONTROL_CLASSES` comment. */}
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            name="external"
            type="checkbox"
            checked={external}
            onChange={(e) => setExternal(e.target.checked)}
          />
          Already applied elsewhere
        </label>
        {external && (
          <Field label="Submitted on">
            <input
              name="submittedAt" type="date" required defaultValue={typed.submittedAt ?? ""}
              className={CONTROL_CLASSES}
            />
          </Field>
        )}
        <Button type="submit" tone="primary" className="self-start">Log application</Button>
        {state && (
          <p className="m-0 text-sm text-bad" role="alert">
            Not logged — {state.reason}.
          </p>
        )}
      </form>
    </Card>
  );
}
