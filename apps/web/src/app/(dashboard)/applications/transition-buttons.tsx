"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ApplicationState } from "@careerhq/contracts";
import { legalTargets } from "@careerhq/core";
import { transitionApplicationAction } from "./actions.js";

function humanize(state: string): string {
  return state.charAt(0) + state.slice(1).toLowerCase().replace(/_/g, " ");
}

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
    <div className="board-card-actions">
      <div className="board-card-buttons">
        {targets.map((to) => (
          <button key={to} type="button" disabled={isPending} onClick={() => handleClick(to)}>
            {humanize(to)}
          </button>
        ))}
      </div>
      {error && <p className="board-card-error">{error}</p>}
    </div>
  );
}
