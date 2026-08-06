"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ApplicationState } from "@careerhq/contracts";
import { legalTargets } from "@careerhq/core";
import { Button } from "../../../components/button.js";
import { transitionApplicationAction } from "./actions.js";

function humanize(state: string): string {
  return state.charAt(0) + state.slice(1).toLowerCase().replace(/_/g, " ");
}

/**
 * Every `user`-triggerable edge out of a state (`legalTargets(state, "user")`)
 * is an internal record change — SUBMITTED only ever arrives via the
 * confirmed-attempt trigger the auto-apply driver uses, never from this
 * button row. Nothing here sends, submits, or deletes anything outside
 * CareerHQ, so every button stays the `default` tone; `irreversible` is
 * reserved for controls that do (see `[id]/site-panel.tsx`'s own confirm
 * step).
 */
export function TransitionButtons({
  applicationId,
  state,
}: {
  applicationId: string;
  state: ApplicationState;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const targets = legalTargets(state, "user");

  if (targets.length === 0) return null;

  function handleClick(to: ApplicationState) {
    setError(null);
    startTransition(async () => {
      const result = await transitionApplicationAction({ applicationId, to });
      if (result.ok) {
        router.refresh();
      } else {
        setError(result.reason);
      }
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        {targets.map((to) => (
          <Button
            key={to}
            type="button"
            size="compact"
            disabled={isPending}
            onClick={() => handleClick(to)}
          >
            {humanize(to)}
          </Button>
        ))}
      </div>
      {error && (
        <p className="m-0 text-xs text-bad" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
