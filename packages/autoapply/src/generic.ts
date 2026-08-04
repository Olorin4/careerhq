import { canonicalFormSchema, type CanonicalForm } from "@careerhq/contracts";
import { fieldIdentityHash, fieldKindFor, PARSER_VERSION, rawFieldId, type RawFormPage } from "./raw.js";
import { detectBlockers } from "./blockers.js";

function firstLine(text: string): string {
  return (text.split(/\r?\n/, 1)[0] ?? "").trim();
}

/** `"<title> at <company>"` split on the first " at ", per real Greenhouse/Lever <title> conventions. */
function splitTitle(pageTitle: string): { title: string; companyName: string } {
  const separator = " at ";
  const idx = pageTitle.indexOf(separator);
  if (idx === -1) return { title: pageTitle, companyName: "" };
  return { title: pageTitle.slice(0, idx), companyName: pageTitle.slice(idx + separator.length) };
}

/**
 * The ATS-agnostic fallback parser: maps a RawFormPage 1:1 into a
 * CanonicalForm using only structural signals (tag/type, aria-required,
 * <option> elements). It never guesses `canonicalField` — that semantic
 * mapping is Task 7's job (interpretField / deterministic label matching);
 * every field here is left "unknown" with mappingConfidence 0.
 */
export function parseGenericForm(
  page: RawFormPage,
  opts: { atsType: "greenhouse" | "lever" | "generic"; parseConfidence: number },
): CanonicalForm {
  const { title, companyName } = splitTitle(page.title);
  const url = new URL(page.url);

  const fields = page.fields
    .filter((field) => field.tag !== "button")
    .map((field) => ({
      id: rawFieldId(field),
      // Captured here, at the moment the form the user will review is built,
      // and re-checked by the driver against the live page before it types.
      identityHash: fieldIdentityHash(field),
      kind: fieldKindFor(field),
      label: field.labelText || field.placeholder || firstLine(field.nearbyText),
      required: field.required,
      options: field.options,
      maxLength: field.maxLength ?? undefined,
      accept: field.accept ?? undefined,
      step: field.step,
      canonicalField: "unknown" as const,
      mappingConfidence: 0,
      sensitive: false,
    }));

  return canonicalFormSchema.parse({
    atsType: opts.atsType,
    parserVersion: PARSER_VERSION,
    url: page.url,
    requisitionKey: `${url.host}${url.pathname}`,
    title,
    companyName,
    totalSteps: page.totalSteps,
    fields,
    blockers: detectBlockers(page),
    parseConfidence: opts.parseConfidence,
  });
}
