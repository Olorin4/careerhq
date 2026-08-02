"use client";

import { useState } from "react";
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

export function FactForm() {
  const [reviewBy] = useState(defaultReviewBy);

  return (
    <form action={createFactAction} className="fact-form">
      <h2>Add fact</h2>
      <label>
        Category
        <select name="category" required defaultValue={FACT_CATEGORIES[0]}>
          {FACT_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {humanize(category)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Claim
        <input name="claim" type="text" required />
      </label>
      <label>
        Detail
        <textarea name="detail" />
      </label>
      <label>
        Evidence URL
        <input name="evidenceUrl" type="url" />
      </label>
      <label>
        Sensitivity
        <select name="sensitivity" required defaultValue="normal">
          {SENSITIVITIES.map((sensitivity) => (
            <option key={sensitivity} value={sensitivity}>
              {humanize(sensitivity)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Review by
        <input name="reviewBy" type="date" defaultValue={reviewBy} required />
      </label>
      <button type="submit">Add fact</button>
    </form>
  );
}
