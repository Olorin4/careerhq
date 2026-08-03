// Greenhouse adapter: layers name/id pattern hints for canonicalField on top
// of the ATS-agnostic generic parser (Task 4). The patterns below are the
// stable, documented Greenhouse conventions (spec Task 5 hint table) — real
// Greenhouse boards render `job_application[first_name]`-style names on some
// tenants and bare `first_name` on others, so each hint is a substring match
// against `name`/`id` rather than an exact match.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalFormSchema, type CanonicalField, type CanonicalForm } from "@careerhq/contracts";
import { parseGenericForm } from "../generic.js";
import { rawFieldId, type RawField, type RawFormPage } from "../raw.js";

interface NameHint {
  pattern: RegExp;
  field: CanonicalField;
}

/**
 * Ordered name/id substring hints (case-insensitive). First match wins.
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
  { pattern: /cover_letter/i, field: "cover_letter_file" },
  { pattern: /linkedin/i, field: "linkedin_url" },
  { pattern: /github/i, field: "github_url" },
  { pattern: /website|portfolio/i, field: "portfolio_url" },
  { pattern: /location/i, field: "location" },
  { pattern: /question_|custom_question/i, field: "screening_question" },
  { pattern: /gender|race|ethnicity|veteran|disability|self_identif/i, field: "demographics" },
];

function matchNameHint(raw: RawField): CanonicalField | null {
  const haystack = `${raw.name} ${raw.id}`.toLowerCase();
  for (const hint of NAME_HINTS) {
    if (hint.pattern.test(haystack)) return hint.field;
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
 * Every other unmatched field (selects, checkboxes, ...) is left "unknown"
 * — deterministic label matching is Task 7's job.
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

    const hinted = matchNameHint(raw);
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

const FIXTURE_PATH = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "fixtures",
  "greenhouse-page.json",
);

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
