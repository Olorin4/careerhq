import type { BlockerKind } from "@careerhq/contracts";
import type { RawFormPage } from "./raw.js";

const CAPTCHA_RE = /recaptcha|hcaptcha|turnstile|cf-challenge/i;
const HUMAN_CHECK_RE = /verify you are human/i;
const IDENTITY_RE = /verify your identity|government[- ]issued id/i;
const ASSESSMENT_RE = /coding (challenge|assessment)|timed test|hackerrank|codility/i;
/**
 * Kept in step with the attestation half of `SENSITIVE_TERMS` and with
 * `CONSENT_ONLY_LABEL_RE` (@careerhq/core) — three rulesets that must agree, or
 * a wording is an attestation for one and an ordinary reusable answer for
 * another. `signature`, `legal name` and `acknowledg` were the gap: a required
 * "Signature" / "E-signature" / "Type your full legal name to acknowledge the
 * terms" input did NOT pause, and the demo fixture only blocked because its
 * label happened to say "certify".
 *
 * This over-blocks by design. A bare required "Full legal name" identity field
 * now pauses the page, which costs the user a few minutes in their own browser;
 * the alternative is CareerHQ typing a legal signature on their behalf, or
 * replaying one approved on a different application. Only the second is
 * unrecoverable, so the false positive is the cheaper error.
 */
const ATTESTATION_RE = /certify|attest|acknowledg|under penalty|legally binding|signature|legal name/i;

/**
 * Pause-and-return signals per spec §10.6. Order is not significant; the
 * caller (site orchestrator, Task 11) decides how to react to each kind.
 *
 * legal_attestation is a blocker only for attestations we cannot put to the
 * user as a simple yes/no — a typed signature, a "type your full legal name"
 * input, a signature date. A required attestation CHECKBOX is deliberately NOT
 * a blocker: it is demoted to a field-level consent tick the user checks
 * personally on the review screen (spec §10.6, revised). See the loop below.
 */
export function detectBlockers(page: RawFormPage): Array<{ kind: BlockerKind; detail: string }> {
  const blockers: Array<{ kind: BlockerKind; detail: string }> = [];

  const markerHaystack = [...page.rootMarkers, ...page.fields.map((field) => field.selector)].join(" ");
  if (CAPTCHA_RE.test(markerHaystack) || HUMAN_CHECK_RE.test(page.bodyText)) {
    blockers.push({ kind: "captcha", detail: "CAPTCHA widget or human-verification challenge detected" });
  }

  // ANY password input pauses the page, with no "…unless there is also a resume
  // upload" carve-out. That carve-out was meant to let an ATS's
  // "create-an-account-while-you-apply" page through, but there is no safe way
  // to carry a password through this pipeline: `generic.ts` has no password
  // FieldKind, so the input becomes a plain `text` field whose value would be
  // planned, shown, persisted verbatim in form_snapshots.planned_answers, folded
  // into the fingerprinted payload and copied onto the receipt — plaintext
  // secrets in the database, which spec §13 forbids. Pausing costs the user the
  // few seconds it takes to make the account in their own browser.
  const hasPassword = page.fields.some((field) => field.tag === "input" && field.type === "password");
  if (hasPassword) {
    blockers.push({ kind: "login_required", detail: "Page contains a password field — accounts and sign-in are yours to complete" });
  }

  if (IDENTITY_RE.test(page.bodyText)) {
    blockers.push({ kind: "identity_verification", detail: "Page requests identity or government-issued ID verification" });
  }

  if (ASSESSMENT_RE.test(page.bodyText)) {
    blockers.push({ kind: "assessment", detail: "Page requires a coding assessment or timed test" });
  }

  for (const field of page.fields) {
    if (field.tag === "input" && field.type === "file" && field.accept) {
      const accept = field.accept.toLowerCase();
      const acceptsPdf = accept.includes("pdf");
      const acceptsDoc = accept.includes("doc");
      if (!acceptsPdf && !acceptsDoc) {
        blockers.push({
          kind: "unsupported_file_control",
          detail: `${field.selector} only accepts: ${field.accept}`,
        });
      }
    }
  }

  // A REQUIRED ATTESTATION CHECKBOX IS NOT A BLOCKER (spec §10.6, revised):
  // it is demoted to a field-level consent tick the user checks personally in
  // the review screen, having seen its exact text. That returns control to the
  // user more precisely than abandoning the attempt — and the tick, being
  // source "user", lands inside the fingerprinted payload and the receipt.
  //
  // What we still cannot render honestly is an attestation that is not a simple
  // yes/no: a typed signature, a "type your full legal name" input, or a
  // signature date. Those still pause the page.
  for (const field of page.fields) {
    const isCheckbox = field.tag === "input" && field.type === "checkbox";
    if (isCheckbox) continue;
    const isTypedControl =
      field.tag === "textarea" || (field.tag === "input" && ["text", "date"].includes(field.type));
    if (!isTypedControl || !field.required) continue;
    const text = `${field.labelText} ${field.nearbyText}`;
    if (ATTESTATION_RE.test(text)) {
      blockers.push({
        kind: "legal_attestation",
        detail: `${field.selector}: ${field.labelText || field.nearbyText}`,
      });
    }
  }

  return blockers;
}
