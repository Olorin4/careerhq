"use client";

import { useState, useTransition, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import type { CvVariant } from "@careerhq/db";
import { CONTROL_CLASSES, Field } from "../../../../components/field.js";
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
 *
 * Not in Task 8's file list, but styled anyway: both `SitePanel` and
 * `EmailPanel` link here with a `#cv-select` "change" anchor from inside
 * their own now-restyled review screens, and an unstyled bare `<select>`
 * sitting between two redesigned `Card` panels would read as broken, not
 * deliberate — the "fix the component, not the page" precedent applies
 * equally to a page's own small, unlisted neighbour.
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
    <div
      id="cv-select"
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4 shadow-card"
    >
      <Field label="CV variant">
        <select
          value={cvVariantId ?? ""}
          onChange={handleChange}
          disabled={isPending}
          className={CONTROL_CLASSES}
        >
          <option value="">No CV selected</option>
          {variants.map((variant) => (
            <option key={variant.id} value={variant.id}>
              {variant.label}
            </option>
          ))}
        </select>
      </Field>
      {error && (
        <p className="m-0 text-sm text-bad" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
