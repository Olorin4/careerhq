"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { ScoringProfile } from "@careerhq/contracts";
import { saveScoringProfileAction } from "./actions.js";

export function ProfileForm({ profile }: { profile: ScoringProfile }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    const formData = new FormData(event.currentTarget);
    startTransition(async () => {
      const result = await saveScoringProfileAction(formData);
      if (result.ok) {
        setSaved(true);
        router.refresh();
      } else {
        setError(result.reason);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="settings-form">
      <label>
        Roles (one per line)
        <textarea name="roles" rows={4} defaultValue={profile.roles.join("\n")} />
      </label>
      <label>
        Stack (one per line)
        <textarea name="stack" rows={4} defaultValue={profile.stack.join("\n")} />
      </label>
      <label>
        Boost keywords (one per line)
        <textarea name="boost" rows={4} defaultValue={profile.boost.join("\n")} />
      </label>
      <label>
        Exclude keywords (one per line)
        <textarea name="exclude" rows={4} defaultValue={profile.exclude.join("\n")} />
      </label>
      <label className="settings-form-checkbox">
        <input type="checkbox" name="requireRemote" defaultChecked={profile.requireRemote} />
        Require remote
      </label>
      <label className="settings-form-checkbox">
        <input type="checkbox" name="includeUnknownRemote" defaultChecked={profile.includeUnknownRemote} />
        Include jobs with unknown remote mode
      </label>
      <label>
        Minimum role hits
        <input type="number" name="minRoleHits" min={0} step={1} defaultValue={profile.minRoleHits} required />
      </label>
      <label>
        Minimum stack hits
        <input type="number" name="minStackHits" min={0} step={1} defaultValue={profile.minStackHits} required />
      </label>
      <label>
        Top N sent to LLM re-rank
        <input type="number" name="topNForLlm" min={1} step={1} defaultValue={profile.topNForLlm} required />
      </label>
      <button type="submit" disabled={isPending}>Save profile</button>
      {saved && !error && <p className="settings-form-success">Saved.</p>}
      {error && <p className="settings-form-error">{error}</p>}
    </form>
  );
}
