"use client";

import { useActionState, useState } from "react";
import { FACT_CATEGORIES, SENSITIVITIES } from "@careerhq/contracts";
import { createFactAction } from "./actions.js";

function humanize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

function defaultReviewBy(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 12);
  return d.toISOString().slice(0, 10);
}

/**
 * `useActionState` rather than a plain `<form action={…}>`, so the demo rate
 * limit and the claim/detail length caps are reported in the form instead of
 * thrown at the visitor as a full-page error overlay. Every control re-seeds
 * from the values the refusal carried back — React resets an uncontrolled form
 * once its action resolves.
 */
export function FactForm() {
  const [reviewBy] = useState(defaultReviewBy);
  const [state, submit] = useActionState(createFactAction, null);
  const typed = state?.values ?? {};

  return (
    <form action={submit} className="fact-form">
      <h2>Add fact</h2>
      <label>
        Category
        <select name="category" required defaultValue={typed.category ?? FACT_CATEGORIES[0]}>
          {FACT_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {humanize(category)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Claim
        <input name="claim" type="text" required defaultValue={typed.claim ?? ""} />
      </label>
      <label>
        Detail
        <textarea name="detail" defaultValue={typed.detail ?? ""} />
      </label>
      <label>
        Evidence URL
        <input name="evidenceUrl" type="url" defaultValue={typed.evidenceUrl ?? ""} />
      </label>
      <label>
        Sensitivity
        <select name="sensitivity" required defaultValue={typed.sensitivity ?? "normal"}>
          {SENSITIVITIES.map((sensitivity) => (
            <option key={sensitivity} value={sensitivity}>
              {humanize(sensitivity)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Review by
        <input name="reviewBy" type="date" defaultValue={typed.reviewBy ?? reviewBy} required />
      </label>
      <button type="submit">Add fact</button>
      {state && <p className="form-error">Not saved — {state.reason}.</p>}
    </form>
  );
}
