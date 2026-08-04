import type { BlockerKind } from "@careerhq/contracts";
import type { RawFormPage } from "./raw.js";

const CAPTCHA_RE = /recaptcha|hcaptcha|turnstile|cf-challenge/i;
const HUMAN_CHECK_RE = /verify you are human/i;
const IDENTITY_RE = /verify your identity|government[- ]issued id/i;
const ASSESSMENT_RE = /coding (challenge|assessment)|timed test|hackerrank|codility/i;
const ATTESTATION_RE = /certify|attest|under penalty|legally binding/i;

/**
 * Pause-and-return signals per spec §10.6. Order is not significant; the
 * caller (site orchestrator, Task 11) decides how to react to each kind.
 *
 * legal_attestation is a blocker ONLY when the checkbox is required — spec
 * §10.6 forbids auto-apply from ticking a legal attestation on the user's
 * behalf, but an optional/voluntary attestation checkbox is not a blocker.
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

  for (const field of page.fields) {
    if (field.tag === "input" && field.type === "checkbox" && field.required) {
      const text = `${field.labelText} ${field.nearbyText}`;
      if (ATTESTATION_RE.test(text)) {
        blockers.push({
          kind: "legal_attestation",
          detail: `${field.selector}: ${field.labelText || field.nearbyText}`,
        });
      }
    }
  }

  return blockers;
}
