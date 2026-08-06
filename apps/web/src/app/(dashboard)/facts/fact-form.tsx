"use client";

import { useActionState, useState } from "react";
import { FACT_CATEGORIES, SENSITIVITIES } from "@careerhq/contracts";
import { Button } from "../../../components/button.js";
import { Card } from "../../../components/card.js";
import { CONTROL_CLASSES, Field } from "../../../components/field.js";
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
    <Card className="max-w-lg">
      <form action={submit} className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-ink">Add fact</h2>
        <Field label="Category">
          <select
            name="category" required defaultValue={typed.category ?? FACT_CATEGORIES[0]}
            className={CONTROL_CLASSES}
          >
            {FACT_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {humanize(category)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Claim">
          <input
            name="claim" type="text" required defaultValue={typed.claim ?? ""}
            className={CONTROL_CLASSES}
          />
        </Field>
        <Field label="Detail">
          <textarea name="detail" defaultValue={typed.detail ?? ""} className={CONTROL_CLASSES} />
        </Field>
        <Field label="Evidence URL">
          <input
            name="evidenceUrl" type="url" defaultValue={typed.evidenceUrl ?? ""}
            className={CONTROL_CLASSES}
          />
        </Field>
        <Field label="Sensitivity">
          <select
            name="sensitivity" required defaultValue={typed.sensitivity ?? "normal"}
            className={CONTROL_CLASSES}
          >
            {SENSITIVITIES.map((sensitivity) => (
              <option key={sensitivity} value={sensitivity}>
                {humanize(sensitivity)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Review by">
          <input
            name="reviewBy" type="date" defaultValue={typed.reviewBy ?? reviewBy} required
            className={CONTROL_CLASSES}
          />
        </Field>
        <Button type="submit" tone="primary" className="self-start">
          Add fact
        </Button>
        {state && (
          <p className="text-sm text-bad" role="alert">
            Not saved — {state.reason}.
          </p>
        )}
      </form>
    </Card>
  );
}
