// Shared by the Greenhouse and Lever adapters (deliberately one declaration:
// this predicate decides whether a control is offered to the user as a consent
// tick, and two copies of it could drift apart per-ATS).
//
// Not re-exported from the package barrel — it is an adapter implementation
// detail, not part of the public surface.
import type { FieldKind } from "@careerhq/contracts";
import type { RawField } from "../raw.js";

const ATTESTATION_CHECKBOX_RE = /certif|attest|acknowledg|agree/i;

/**
 * True for a checkbox whose name/id/label reads as a legal attestation
 * ("I certify…", "I acknowledge…").
 *
 * Such a checkbox is no longer a blocker — spec §10.6 (revised) demotes it to a
 * field-level consent tick the user checks personally on the review screen — so
 * it must carry a canonicalField for the planner and the UI to key off.
 *
 * Checkbox-only, and deliberately so: the same wording on a text input is a
 * TYPED SIGNATURE, which cannot be rendered as a tick and still pauses the page
 * (blockers.ts). Mapping that here would hand the review screen a field it has
 * no honest way to present. It also stops the broad `agree` term from
 * swallowing unrelated typed controls.
 *
 * Matched against label text as well as name/id: plenty of tenants render the
 * attestation as an unnamed `input[type=checkbox]` whose only identifying text
 * is the sentence beside it.
 */
export function isAttestationCheckbox(raw: RawField, kind: FieldKind): boolean {
  return kind === "checkbox" && ATTESTATION_CHECKBOX_RE.test(`${raw.name} ${raw.id} ${raw.labelText}`);
}
