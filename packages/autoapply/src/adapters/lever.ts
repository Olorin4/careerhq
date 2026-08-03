// Lever adapter: layers name/id pattern hints for canonicalField on top of
// the ATS-agnostic generic parser (Task 4), mirroring the Greenhouse
// adapter's structure. The patterns below are the stable, documented Lever
// conventions (spec Task 6 hint table): a single "name" field (no
// first/last split, unlike Greenhouse), `cards[urls][...]` bracketed field
// names for social/portfolio links, and a "comments" free-text field.
//
// Also exports `parseForm`, the single ATS-dispatch entry point later tasks
// use: detectAts → parseGreenhouse | parseLever | parseGenericForm(generic).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalFormSchema, type CanonicalField, type CanonicalForm } from "@careerhq/contracts";
import { detectAts } from "../detect.js";
import { parseGenericForm } from "../generic.js";
import { rawFieldId, type RawField, type RawFormPage } from "../raw.js";
import { hashRawFormPage, parseGreenhouse } from "./greenhouse.js";

// Re-exported so callers (and this file's own fixture-hash tripwire below)
// can import the hashing helper from either adapter module — it traces back
// to the single declaration in greenhouse.ts, so the index.ts barrel's
// `export *` from both adapters is not an ambiguous re-export.
export { hashRawFormPage };

interface NameHint {
  pattern: RegExp;
  field: CanonicalField;
}

/**
 * Ordered name/id substring hints (case-insensitive), checked after the
 * "name" exact-match special case below. First match wins.
 *
 * Fix round audit (Task 5 review item 3 — checked every hint below against
 * the full CANONICAL_FIELDS list for the same "general pattern shadows a
 * more specific sibling field" bug found in greenhouse.ts's location hint):
 * only `notice|availability -> notice_period` collided (fixed above,
 * splitting out a dedicated `availability` hint). Everything else —
 * `org|company` (current_company), `resume`, `linkedin`, `github`,
 * `portfolio`, `comments|additional_information`, `salary|compensation`
 * (desired_salary), `work_auth|authorized` (work_authorization), `sponsor`
 * (visa_sponsorship), `email`, `phone`, plus the exact-match "name" ->
 * full_name check — has no other CanonicalField whose name is a substring
 * match (or superset) of its pattern, so no further splitting was needed.
 */
const NAME_HINTS: NameHint[] = [
  { pattern: /org|company/i, field: "current_company" },
  { pattern: /resume/i, field: "resume_file" },
  { pattern: /linkedin/i, field: "linkedin_url" },
  { pattern: /github/i, field: "github_url" },
  { pattern: /portfolio/i, field: "portfolio_url" },
  { pattern: /comments|additional_information/i, field: "screening_question" },
  // Fix round (Task 5 review, item 3 — auditing lever.ts for the same
  // collision class): "availability" is its OWN CanonicalField, distinct
  // from "notice_period" (start-date availability vs. current-employer
  // notice period). The original combined `/notice|availability/i ->
  // notice_period` pattern (straight from the Task 6 brief's hint table)
  // silently conflated the two — split so each substring maps to its own
  // field. No effect on the committed lever fixture: its only matching
  // field is id/name "notice_period", which only contains "notice".
  { pattern: /notice/i, field: "notice_period" },
  { pattern: /availability/i, field: "availability" },
  { pattern: /salary|compensation/i, field: "desired_salary" },
  { pattern: /work_auth|authorized/i, field: "work_authorization" },
  { pattern: /sponsor/i, field: "visa_sponsorship" },
  { pattern: /email/i, field: "email" },
  { pattern: /phone/i, field: "phone" },
];

function matchNameHint(raw: RawField): CanonicalField | null {
  // Lever's single full-name field is literally named/id'd "name" — an
  // exact match, not a substring one (a substring match would wrongly
  // catch fields like "company_name"). Checked before the ordered
  // substring hints below.
  if (raw.name.toLowerCase() === "name" || raw.id.toLowerCase() === "name") {
    return "full_name";
  }
  const haystack = `${raw.name} ${raw.id}`.toLowerCase();
  for (const hint of NAME_HINTS) {
    if (hint.pattern.test(haystack)) return hint.field;
  }
  return null;
}

/**
 * Applies the Lever hints over `parseGenericForm`'s structural pass.
 *
 * Unlike the Greenhouse adapter, this does NOT fall back to mapping every
 * unmatched textarea to `screening_question`: Lever's one free-text field
 * in our fixture ("Additional information", named `comments`) is already
 * covered by the explicit `comments|additional_information` hint above, so
 * a broad textarea fallback would only risk over-mapping future Lever
 * custom-question textareas that a tenant names arbitrarily — deterministic
 * label matching (Task 7) is the right place for that, not a blanket guess
 * here.
 */
export function parseLever(page: RawFormPage): CanonicalForm {
  const generic = parseGenericForm(page, { atsType: "lever", parseConfidence: 0.9 });

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
    return field;
  });

  return canonicalFormSchema.parse({ ...generic, fields });
}

const FIXTURE_PATH = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "fixtures",
  "lever-page.json",
);

function loadFixtureRawPage(): RawFormPage {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as RawFormPage;
}

/**
 * sha256 of the committed `fixtures/lever-page.json` — the parser-drift
 * tripwire (spec §10.5), same pattern as GREENHOUSE_FIXTURE_HASH: if
 * apps/demo-ats's Lever markup drifts without regenerating the fixture
 * (`scripts/write-fixture.ts lever`), the matching test fails.
 */
export const LEVER_FIXTURE_HASH: string = hashRawFormPage(loadFixtureRawPage());

/**
 * The single ATS-dispatch entry point later tasks (Task 7+) use: detect the
 * ATS from structural markers, then route to the matching adapter, falling
 * back to the ATS-agnostic generic parser at its low detection confidence.
 */
export function parseForm(page: RawFormPage): CanonicalForm {
  const { atsType } = detectAts(page);
  if (atsType === "greenhouse") return parseGreenhouse(page);
  if (atsType === "lever") return parseLever(page);
  return parseGenericForm(page, { atsType: "generic", parseConfidence: 0.4 });
}
