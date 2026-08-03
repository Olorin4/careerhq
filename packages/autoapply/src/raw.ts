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
