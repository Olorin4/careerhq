// raw.ts — the ONLY shape the browser hands back (must be JSON-serializable).
//
// This is the browser-free "brain" contract: whatever scrapes a live ATS
// page (a Playwright driver in the browser context, or the linkedom-backed
// test helper in ./testing/from-html.ts) must emit exactly this shape, so
// detect.ts/blockers.ts/generic.ts never need to know whether the page came
// from a real browser or a static HTML fixture.
import { createHash } from "node:crypto";

export interface RawField {
  selector: string; // unique CSS selector the driver can re-find
  tag: "input" | "textarea" | "select" | "button";
  type: string; // input type, or "" for textarea/select
  name: string;
  id: string;
  labelText: string; // resolved from <label for>, wrapping label, aria-label or aria-labelledby
  nearbyText: string; // trimmed text of the closest field container, <=400 chars
  placeholder: string;
  required: boolean; // required attr OR aria-required="true"
  maxLength: number | null;
  accept: string | null;
  options: Array<{ value: string; label: string }>;
  step: number; // 0-based; driver assigns per visible step
}

export interface RawFormPage {
  url: string;
  title: string;
  bodyText: string; // <= 20_000 chars, whitespace-collapsed
  rootMarkers: string[]; // e.g. ["data-source=greenhouse", "id=application_form"]
  fields: RawField[];
  buttons: Array<{ selector: string; id: string; text: string }>;
  totalSteps: number;
}

export const PARSER_VERSION = "1";

/** Stable per-field id assigned by the parser (CanonicalFormField.id). */
export function rawFieldId(field: RawField): string {
  return createHash("sha256").update(field.selector).digest("hex").slice(0, 16);
}

/**
 * What the user actually reviewed: THIS control, asking THIS question.
 *
 * `rawFieldId` deliberately hashes the selector alone — it is the join key
 * between a planned answer and a control, and it must survive a page that
 * rewords its help text. That makes it the wrong thing to re-verify against at
 * submit time: a page edited between review and submit can keep every selector
 * and change every question, and each planned answer would still "match" the
 * field it was planned for.
 *
 * So the identity carries the label too. It matters most for a CONSENT TICK,
 * whose entire meaning is the statement sitting beside it: a recorded consent
 * that no longer describes what would be submitted is worse than no consent at
 * all. The driver compares this before it types anything (see
 * `fillAndSubmit`), and refuses pre-click when it has moved.
 *
 * The label is whitespace-collapsed first: a reflow is not a reword, and the
 * same sentence wrapped differently must not refuse a legitimate submission.
 */
export function fieldIdentityHash(field: Pick<RawField, "selector" | "labelText">): string {
  const label = field.labelText.replace(/\s+/g, " ").trim();
  // "\n" separates the two parts; the selector can contain one, so it is
  // escaped rather than trusted to be separator-free.
  const selector = field.selector.replace(/\n/g, "\\n");
  return createHash("sha256").update(`${selector}\n${label}`).digest("hex").slice(0, 16);
}
