"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ATS_TYPES } from "@careerhq/contracts";
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
    <form onSubmit={handleSubmit} className="watchlist-form">
      <h3>Add company</h3>
      <label>
        Company name
        <input name="companyName" type="text" required />
      </label>
      <label>
        ATS
        <select name="atsType" required defaultValue={ATS_TYPES[0]}>
          {ATS_TYPES.map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
      </label>
      <label>
        Board slug
        {/* Mirrors the server-side regex in actions.ts; the action still validates. */}
        <input
          name="boardSlug" type="text" placeholder="e.g. stripe" required
          pattern="[A-Za-z0-9._\-]+"
          title="Letters, digits, dots, dashes, underscores only"
        />
      </label>
      <p className="watchlist-form-help">
        The slug from the company&apos;s public job board URL: boards.greenhouse.io/&lt;slug&gt;,
        jobs.lever.co/&lt;slug&gt;, or jobs.ashbyhq.com/&lt;slug&gt;.
      </p>
      <button type="submit" disabled={isPending}>Add to watchlist</button>
      {error && <p className="watchlist-form-error">{error}</p>}
    </form>
  );
}
