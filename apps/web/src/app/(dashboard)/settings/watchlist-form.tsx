"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ATS_TYPES } from "@careerhq/contracts";
import { Button } from "../../../components/button.js";
import { Card } from "../../../components/card.js";
import { CONTROL_CLASSES, Field } from "../../../components/field.js";
import { addWatchlistEntryAction } from "./actions.js";

export function WatchlistForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = event.currentTarget;
    const formData = new FormData(form);
    const companyName = String(formData.get("companyName") ?? "");
    const atsType = String(formData.get("atsType") ?? "");
    const boardSlug = String(formData.get("boardSlug") ?? "");
    startTransition(async () => {
      const result = await addWatchlistEntryAction({ companyName, atsType, boardSlug });
      if (result.ok) {
        form.reset();
        router.refresh();
      } else {
        setError(result.reason);
      }
    });
  }

  return (
    <Card className="max-w-lg">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <h3 className="m-0 text-sm font-semibold text-ink">Add company</h3>
        <Field label="Company name">
          <input name="companyName" type="text" required className={CONTROL_CLASSES} />
        </Field>
        <Field label="ATS">
          <select name="atsType" required defaultValue={ATS_TYPES[0]} className={CONTROL_CLASSES}>
            {ATS_TYPES.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
        </Field>
        <Field label="Board slug">
          {/* Mirrors the server-side regex in actions.ts; the action still validates. */}
          <input
            name="boardSlug" type="text" placeholder="e.g. stripe" required
            pattern="[A-Za-z0-9._\-]+"
            title="Letters, digits, dots, dashes, underscores only"
            className={CONTROL_CLASSES}
          />
        </Field>
        <p className="m-0 text-xs text-soft">
          The slug from the company&apos;s public job board URL: boards.greenhouse.io/&lt;slug&gt;,
          jobs.lever.co/&lt;slug&gt;, or jobs.ashbyhq.com/&lt;slug&gt;.
        </p>
        <Button type="submit" tone="primary" disabled={isPending} className="self-start">
          Add to watchlist
        </Button>
        {error && (
          <p className="m-0 text-sm text-bad" role="alert">
            {error}
          </p>
        )}
      </form>
    </Card>
  );
}
