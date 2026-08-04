// Greenhouse adapter: layers name/id pattern hints for canonicalField on top
// of the ATS-agnostic generic parser (Task 4). The patterns below are the
// stable, documented Greenhouse conventions (spec Task 5 hint table) — real
// Greenhouse boards render `job_application[first_name]`-style names on some
// tenants and bare `first_name` on others, so each hint is a substring match
// against `name`/`id` rather than an exact match.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { canonicalFormSchema, type CanonicalField, type CanonicalForm, type FieldKind } from "@careerhq/contracts";
import { parseGenericForm } from "../generic.js";
import { rawFieldId, type RawField, type RawFormPage } from "../raw.js";
import { isAttestationCheckbox } from "./attestation.js";

/**
 * A hint's target is usually a fixed CanonicalField, but a few name/id
 * patterns are ambiguous without also looking at the field's structural
 * `kind` (e.g. "cover_letter" is a file upload on some tenants, a pasted
 * text box on others) — those hints resolve via a `(kind) => field`
 * function instead.
 */
type HintTarget = CanonicalField | ((kind: FieldKind) => CanonicalField);

interface NameHint {
  pattern: RegExp;
  field: HintTarget;
}

/**
 * Ordered name/id substring hints (case-insensitive). First match wins, so
 * MORE specific patterns that nest inside a more general one (e.g.
 * "relocation" containing "location") are listed first — belt-and-braces
 * with the `\b` word-boundary anchors on the fields most prone to that,
 * so "relocation" can never satisfy the bare `location` pattern regardless
 * of ordering (fix round: Task 5 review flagged `/location/i` shadowing a
 * `relocation` field at 0.9 before this).
 *
 * `job_application[first_name]`-style Greenhouse names already contain the
 * bare keyword (e.g. "first_name"), so a single substring pattern covers
 * both the bracketed and unbracketed conventions from the brief.
 */
const NAME_HINTS: NameHint[] = [
  { pattern: /first_name/i, field: "first_name" },
  { pattern: /last_name/i, field: "last_name" },
  { pattern: /email/i, field: "email" },
  { pattern: /phone/i, field: "phone" },
  { pattern: /resume/i, field: "resume_file" },
  // Kind-aware: a "cover_letter"-named field is only ever a file input or a
  // textarea in practice — route each to its own canonical field instead of
  // always forcing cover_letter_file (fix round: Task 5 review flagged
  // cover_letter_text as unreachable before this).
  { pattern: /cover_letter/i, field: (kind) => (kind === "textarea" ? "cover_letter_text" : "cover_letter_file") },
  { pattern: /linkedin/i, field: "linkedin_url" },
  { pattern: /github/i, field: "github_url" },
  { pattern: /website|portfolio/i, field: "portfolio_url" },
  { pattern: /\brelocation\b/i, field: "relocation" },
  { pattern: /work_auth/i, field: "work_authorization" },
  { pattern: /sponsor/i, field: "visa_sponsorship" },
  { pattern: /\blocation\b/i, field: "location" },
  { pattern: /question_|custom_question/i, field: "screening_question" },
  { pattern: /gender|race|ethnicity|veteran|disability|self_identif/i, field: "demographics" },
];

function matchNameHint(raw: RawField, kind: FieldKind): CanonicalField | null {
  // Checked before the ordered substring hints: an attestation checkbox is
  // never one of the identity/link fields below, and its wording ("I agree…")
  // can otherwise collide with them. See ./attestation.ts for why it is
  // checkbox-only.
  if (isAttestationCheckbox(raw, kind)) return "legal_attestation";
  const haystack = `${raw.name} ${raw.id}`.toLowerCase();
  for (const hint of NAME_HINTS) {
    if (hint.pattern.test(haystack)) {
      return typeof hint.field === "function" ? hint.field(kind) : hint.field;
    }
  }
  return null;
}

/**
 * Applies the Greenhouse hints over `parseGenericForm`'s structural pass.
 *
 * A field the name/id hints don't recognize but that is still a free-text
 * `textarea` is treated as a `screening_question`: real Greenhouse
 * "custom_question"/"question_N" fields always render as textareas, and a
 * tenant may give that textarea a human-readable name (as our demo-ats
 * fixture does with "why_northwind") instead of the generic convention.
 * An attestation checkbox maps to `legal_attestation` (see
 * `isAttestationCheckbox`); every other unmatched field (remaining checkboxes,
 * unrecognized selects, ...) is left "unknown" — deterministic label matching
 * is Task 7's job.
 *
 * Fix round (Task 5 review): the demo-ats fixture's `work_authorization`
 * and `visa_sponsorship` <select> fields now map to their matching
 * canonical fields via the `work_auth`/`sponsor` hints added above, instead
 * of staying "unknown" as they did pre-review — see task-6-report.md's fix
 * round section for why.
 */
export function parseGreenhouse(page: RawFormPage): CanonicalForm {
  const generic = parseGenericForm(page, { atsType: "greenhouse", parseConfidence: 0.9 });

  const rawById = new Map<string, RawField>();
  for (const raw of page.fields) {
    if (raw.tag === "button") continue;
    rawById.set(rawFieldId(raw), raw);
  }

  const fields = generic.fields.map((field) => {
    const raw = rawById.get(field.id);
    if (!raw) return field;

    const hinted = matchNameHint(raw, field.kind);
    if (hinted) {
      return { ...field, canonicalField: hinted, mappingConfidence: 0.9 };
    }
    if (field.kind === "textarea") {
      return { ...field, canonicalField: "screening_question" as const, mappingConfidence: 0.9 };
    }
    return field;
  });

  return canonicalFormSchema.parse({ ...generic, fields });
}

/** sha256 of a RawFormPage's canonical (whitespace-normalized) JSON. */
export function hashRawFormPage(page: RawFormPage): string {
  return createHash("sha256").update(JSON.stringify(page)).digest("hex");
}

// `import.meta.dirname` (Node 22+) rather than `fileURLToPath(new URL(".",
// import.meta.url))`: webpack's static `new URL(literal, import.meta.url)`
// asset-import analysis — which apps/web's production build applies to every
// module it bundles, this one included, once @careerhq/autoapply is reachable
// from a server action — tries to resolve "." as an asset and fails the
// build; a plain string has no such special handling.
const FIXTURE_PATH = path.resolve(import.meta.dirname, "..", "..", "fixtures", "greenhouse-page.json");

function loadFixtureRawPage(): RawFormPage {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as RawFormPage;
}

/**
 * sha256 of the committed `fixtures/greenhouse-page.json` — the
 * parser-drift tripwire (spec §10.5). Compared in greenhouse.test.ts
 * against a freshly-computed hash of the live demo-ats helper output: if
 * apps/demo-ats's Greenhouse markup drifts without regenerating the
 * fixture (`scripts/write-fixture.ts`), that test fails.
 */
export const GREENHOUSE_FIXTURE_HASH: string = hashRawFormPage(loadFixtureRawPage());
