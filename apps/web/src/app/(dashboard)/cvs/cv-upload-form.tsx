"use client";
import { useActionState } from "react";
import { uploadCvAction } from "./actions.js";

/**
 * The upload form, as a client component purely so `useActionState` can carry
 * a refusal back into the page. `uploadCvAction` used to throw its refusals
 * (too big, not a PDF) at a plain `<form action={…}>`, which reaches the
 * visitor as an error overlay rather than as a sentence about their file; the
 * demo rate limit and the store ceiling would have done the same. Same pattern
 * as the manual-draft form in `materials.tsx`.
 *
 * The typed label comes back with the refusal and re-seeds `defaultValue`
 * (React resets an uncontrolled form once its action resolves). The chosen
 * file cannot: a file input's value is not settable from script, which is why
 * the message asks for it again.
 */
export function CvUploadForm({ formats }: { formats: ReadonlyArray<{ value: string; label: string }> }) {
  const [state, upload] = useActionState(uploadCvAction, null);

  return (
    <form action={upload} className="cv-form">
      <h2>Upload CV</h2>
      <label>
        Label
        <input name="label" type="text" required defaultValue={state?.label ?? ""} />
      </label>
      <label>
        Format
        <select name="format" required defaultValue={formats[0]?.value}>
          {formats.map((format) => (
            <option key={format.value} value={format.value}>
              {format.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        PDF file
        <input name="file" type="file" accept="application/pdf" required />
      </label>
      <button type="submit">Upload</button>
      {state && (
        <p className="cv-error">Not uploaded — {state.reason}. Choose the file again to retry.</p>
      )}
    </form>
  );
}
