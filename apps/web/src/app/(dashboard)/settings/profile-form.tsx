"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { ScoringProfile } from "@careerhq/contracts";
import { Button } from "../../../components/button.js";
import { Card } from "../../../components/card.js";
import { CONTROL_CLASSES, Field } from "../../../components/field.js";
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
    <Card className="max-w-lg">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <Field label="Roles (one per line)">
          <textarea name="roles" rows={4} defaultValue={profile.roles.join("\n")} className={CONTROL_CLASSES} />
        </Field>
        <Field label="Stack (one per line)">
          <textarea name="stack" rows={4} defaultValue={profile.stack.join("\n")} className={CONTROL_CLASSES} />
        </Field>
        <Field label="Boost keywords (one per line)">
          <textarea name="boost" rows={4} defaultValue={profile.boost.join("\n")} className={CONTROL_CLASSES} />
        </Field>
        <Field label="Exclude keywords (one per line)">
          <textarea name="exclude" rows={4} defaultValue={profile.exclude.join("\n")} className={CONTROL_CLASSES} />
        </Field>
        {/* A checkbox doesn't fit `Field` — it stacks label above control,
            which draws an empty label line over a lone tickbox. Composed
            inline instead; see `field.tsx`'s `CONTROL_CLASSES` comment. */}
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" name="requireRemote" defaultChecked={profile.requireRemote} />
          Require remote
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" name="includeUnknownRemote" defaultChecked={profile.includeUnknownRemote} />
          Include jobs with unknown remote mode
        </label>
        <Field label="Minimum role hits">
          <input
            type="number" name="minRoleHits" min={0} step={1} defaultValue={profile.minRoleHits} required
            className={CONTROL_CLASSES}
          />
        </Field>
        <Field label="Minimum stack hits">
          <input
            type="number" name="minStackHits" min={0} step={1} defaultValue={profile.minStackHits} required
            className={CONTROL_CLASSES}
          />
        </Field>
        <Field label="Top N sent to LLM re-rank">
          <input
            type="number" name="topNForLlm" min={1} step={1} defaultValue={profile.topNForLlm} required
            className={CONTROL_CLASSES}
          />
        </Field>
        <Button type="submit" tone="primary" disabled={isPending} className="self-start">
          Save profile
        </Button>
        {saved && !error && <p className="m-0 text-sm text-ok">Saved.</p>}
        {error && (
          <p className="m-0 text-sm text-bad" role="alert">
            {error}
          </p>
        )}
      </form>
    </Card>
  );
}
