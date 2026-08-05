"use client";
import { useActionState } from "react";
import { uploadCvAction, type CvUploadState } from "./actions.js";

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
 *
 * `sizeLimit` is the same cap and the same sentence the server refuses with
 * (`cvSizeLimit`, resolved in `page.tsx` because its module reads the
 * filesystem). Checking it HERE is what keeps the promise the rest of this
 * component makes: above the framework's server-action body limit Next answers
 * 413 before `uploadCvAction` is ever called, so there is no refusal for
 * `useActionState` to carry and the overlay comes back — a 7 MB scanned CV was
 * enough, measured against a real `next start` (P6 final review, BLOCKING 2).
 * A file that never leaves the browser cannot hit that bound at all, and the
 * visitor gets the app's own wording, which is the one that tells them what
 * size is actually allowed.
 */
export function CvUploadForm({ formats, sizeLimit }: {
  formats: ReadonlyArray<{ value: string; label: string }>;
  sizeLimit: { maxBytes: number; reason: string };
}) {
  /**
   * A client wrapper around the server action rather than an `onSubmit`
   * handler: the refusal it produces has to be the same `CvUploadState` the
   * action returns, so the message renders in the same place, re-seeds the same
   * label, and there is exactly one way for this form to say no.
   */
  const [state, upload] = useActionState(
    async (previous: CvUploadState, formData: FormData): Promise<CvUploadState> => {
      const file = formData.get("file");
      if (file instanceof File && file.size > sizeLimit.maxBytes) {
        const label = formData.get("label");
        return { reason: sizeLimit.reason, label: typeof label === "string" ? label : "" };
      }
      return uploadCvAction(previous, formData);
    },
    null,
  );

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
