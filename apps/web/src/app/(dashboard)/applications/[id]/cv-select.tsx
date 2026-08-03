"use client";

import { useState, useTransition, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import type { CvVariant } from "@careerhq/db";
import { selectCvAction } from "../actions.js";

interface CvSelectProps {
  applicationId: string;
  /** The application's currently selected CV variant id, or null when none is set. */
  cvVariantId: string | null;
  /** Every CV variant in the workspace, for the dropdown's options. */
  variants: CvVariant[];
}

/**
 * Lets the user pick which CV variant this application will submit with.
 * Materials can't be marked READY_FOR_REVIEW without one selected (see
 * `transitionApplicationAction`), so this needs to be visible on the
 * application detail page alongside the materials/Q&A panels.
 */
export function CvSelect({ applicationId, cvVariantId, variants }: CvSelectProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleChange(event: ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value;
    const nextCvVariantId = value === "" ? null : value;
    setError(null);
    startTransition(async () => {
      const result = await selectCvAction({ applicationId, cvVariantId: nextCvVariantId });
      if (result.ok) {
        router.refresh();
      } else {
        setError(result.reason);
      }
    });
  }

  return (
    <div className="cv-select" id="cv-select">
      <label>
        CV variant
        <select value={cvVariantId ?? ""} onChange={handleChange} disabled={isPending}>
          <option value="">No CV selected</option>
          {variants.map((variant) => (
            <option key={variant.id} value={variant.id}>
              {variant.label}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="cv-select-error">{error}</p>}
    </div>
  );
}
