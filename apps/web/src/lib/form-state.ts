import type { z } from "zod";

/**
 * The two things every plain `<form action={…}>` needs once its action grows a
 * return value.
 *
 * Five of the dashboard's mutating actions returned `Promise<void>`, so the
 * only way they could have reported a demo rate-limit refusal was to throw one
 * — and a thrown refusal reaches the visitor as Next's full-page "Application
 * error" overlay, not as a sentence about waiting forty seconds. Converting
 * them to `useActionState` gives them somewhere to put the reason; these
 * helpers are what the conversions share.
 */

/**
 * Every string entry of a submitted form, keyed by field name.
 *
 * React resets an uncontrolled form once its action resolves, so an action
 * that refuses has to hand the typed values back for the inputs to re-seed
 * their `defaultValue` from — otherwise a refusal silently discards
 * everything the visitor had just typed (the same failure `cv-upload-form`
 * and the manual-draft form already carry a single field back to avoid; the
 * create forms have six and nine).
 *
 * `File` entries are skipped deliberately: a file input's value is not
 * settable from script, so there is nothing a form could do with one.
 */
export function submittedTextValues(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, value] of formData.entries()) {
    if (typeof value === "string") values[name] = value;
  }
  return values;
}

/**
 * A Zod failure as one line a person can read, `field: message` when the issue
 * names a field. Same shape `saveScoringProfileAction` and the email settings
 * actions already produce by hand — extracted here because the actions that
 * moved from `.parse` to `.safeParse` (so that a `.max()` rejection renders
 * instead of throwing) all need it.
 */
export function describeZodIssue(error: z.ZodError, fallback: string): string {
  const issue = error.issues[0];
  if (!issue) return fallback;
  const field = issue.path.join(".");
  return field ? `${field}: ${issue.message}` : issue.message;
}
