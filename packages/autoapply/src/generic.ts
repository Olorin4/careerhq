import { canonicalFormSchema, type CanonicalForm, type FieldKind } from "@careerhq/contracts";
import { PARSER_VERSION, rawFieldId, type RawField, type RawFormPage } from "./raw.js";
import { detectBlockers } from "./blockers.js";

const INPUT_KIND_BY_TYPE: Partial<Record<string, FieldKind>> = {
  email: "email",
  tel: "tel",
  url: "url",
  checkbox: "checkbox",
  radio: "radio",
  file: "file",
  date: "date",
  hidden: "hidden",
};

function kindFor(field: RawField): FieldKind {
  if (field.tag === "textarea") return "textarea";
  if (field.tag === "select") return "select";
  // Any other/unrecognized input type (text, password, number, ...) falls
  // back to plain "text" — there is no dedicated FieldKind for e.g. password.
  return INPUT_KIND_BY_TYPE[field.type] ?? "text";
}

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
      kind: kindFor(field),
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
