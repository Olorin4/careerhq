import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { greenhousePage } from "@careerhq/demo-ats";
import { rawFieldId, type RawField, type RawFormPage } from "../raw.js";
import { rawPageFromHtml } from "../testing/from-html.js";
import { GREENHOUSE_FIXTURE_HASH, hashRawFormPage, parseGreenhouse } from "./greenhouse.js";

const job = { id: "eng-1", title: "Senior Robotics Engineer", company: "Northwind Robotics" };
const url = "https://northwind.example/greenhouse/jobs/eng-1";

const FIXTURE_PATH = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "fixtures",
  "greenhouse-page.json",
);

function loadFixture(): RawFormPage {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as RawFormPage;
}

function idFor(selector: string): string {
  return rawFieldId({ selector } as RawField);
}

describe("parseGreenhouse (committed fixture)", () => {
  const page = loadFixture();
  const form = parseGreenhouse(page);

  it("sets atsType to greenhouse", () => {
    expect(form.atsType).toBe("greenhouse");
  });

  it("maps identity fields to their canonical fields at 0.9 confidence", () => {
    const cases: Array<[string, string]> = [
      ["#first_name", "first_name"],
      ["#last_name", "last_name"],
      ["#email", "email"],
      ["#phone", "phone"],
      ["#resume", "resume_file"],
      ["#linkedin_url", "linkedin_url"],
    ];
    for (const [selector, canonicalField] of cases) {
      const field = form.fields.find((f) => f.id === idFor(selector));
      expect(field?.canonicalField).toBe(canonicalField);
      expect(field?.mappingConfidence).toBe(0.9);
    }
  });

  // Fix round (Task 5 review): work_auth/sponsor hints added to close the
  // "each maps to its own canonical field" gap alongside the
  // location/relocation fix below — these two demo-ats <select> fields now
  // map instead of staying "unknown" (see the "unmapped custom fields" test
  // further down, which was narrowed to just legal_attestation).
  it("maps work_authorization and visa_sponsorship selects to their canonical fields at 0.9", () => {
    const cases: Array<[string, string]> = [
      ["#work_authorization", "work_authorization"],
      ["#visa_sponsorship", "visa_sponsorship"],
    ];
    for (const [selector, canonicalField] of cases) {
      const field = form.fields.find((f) => f.id === idFor(selector));
      expect(field?.canonicalField).toBe(canonicalField);
      expect(field?.mappingConfidence).toBe(0.9);
    }
  });

  it("maps the demographics radios (gender, veteran_status) to demographics at 0.9", () => {
    const demographics = form.fields.filter((f) => f.canonicalField === "demographics");
    // 4 gender options (male/female/nonbinary/decline) + 3 veteran_status options
    expect(demographics.length).toBe(7);
    expect(demographics.every((f) => f.mappingConfidence === 0.9)).toBe(true);
  });

  it("maps the 'why do you want to work here' screening textarea to screening_question", () => {
    const field = form.fields.find((f) => f.id === idFor("#why_northwind"));
    expect(field?.canonicalField).toBe("screening_question");
    expect(field?.mappingConfidence).toBe(0.9);
  });

  // The attestation checkbox is no longer a blocker (spec §10.6, revised) — it
  // is a field-level consent tick, so it must carry a canonical field for the
  // review screen and the planner to key off.
  it("maps the required attestation checkbox to legal_attestation", () => {
    const ack = form.fields.find((f) => f.id === idFor("#legal_attestation"));
    expect(ack?.kind).toBe("checkbox");
    expect(ack?.canonicalField).toBe("legal_attestation");
    expect(ack?.mappingConfidence).toBe(0.9);
  });
});

describe("GREENHOUSE_FIXTURE_HASH (parser-drift tripwire)", () => {
  it("still matches the sha256 of the live demo-ats helper output", () => {
    const livePage = rawPageFromHtml(greenhousePage(job), url);
    expect(hashRawFormPage(livePage)).toBe(GREENHOUSE_FIXTURE_HASH);
  });
});

describe("fix round: location/relocation/sponsorship/work_authorization don't collide", () => {
  it("maps each of a synthetic relocation, location, sponsorship, and work_authorization field to its own distinct canonical field", () => {
    const html = `<html><body><form>
      <input id="relocation" name="relocation" />
      <input id="location" name="location" />
      <input id="sponsorship" name="sponsorship" />
      <input id="work_authorization" name="work_authorization" />
    </form></body></html>`;
    const page = rawPageFromHtml(html, "https://acme.example/careers/apply");
    const form = parseGreenhouse(page);

    const cases: Array<[string, string]> = [
      ["#relocation", "relocation"],
      ["#location", "location"],
      ["#sponsorship", "visa_sponsorship"],
      ["#work_authorization", "work_authorization"],
    ];
    const mapped = cases.map(([selector, expected]) => {
      const field = form.fields.find((f) => f.id === idFor(selector));
      expect(field?.canonicalField).toBe(expected);
      expect(field?.mappingConfidence).toBe(0.9);
      return field?.canonicalField;
    });
    // Belt-and-braces: all four resolved fields are pairwise distinct — no
    // field silently shadows another's canonical field.
    expect(new Set(mapped).size).toBe(4);
  });
});

describe("attestation mapping is checkbox-only", () => {
  it("leaves a typed-signature 'certify' text input unknown", () => {
    // A typed signature is not a consent tick — it stays unmapped and is
    // pause-and-return's job (blockers.ts), not the review screen's.
    const html = `<html><body><form>
      <label for="signature">Type your full legal name to certify this application</label>
      <input type="text" id="signature" name="signature" required />
    </form></body></html>`;
    const page = rawPageFromHtml(html, "https://acme.example/careers/apply");
    const form = parseGreenhouse(page);
    const field = form.fields.find((f) => f.id === idFor("#signature"));
    expect(field?.canonicalField).toBe("unknown");
  });
});

describe("fix round: cover_letter is kind-aware", () => {
  it("maps a cover_letter file input to cover_letter_file", () => {
    const html = `<html><body><form>
      <input type="file" id="cover_letter" name="cover_letter" />
    </form></body></html>`;
    const page = rawPageFromHtml(html, "https://acme.example/careers/apply");
    const form = parseGreenhouse(page);
    const field = form.fields.find((f) => f.id === idFor("#cover_letter"));
    expect(field?.canonicalField).toBe("cover_letter_file");
    expect(field?.mappingConfidence).toBe(0.9);
  });

  it("maps a cover_letter textarea to cover_letter_text", () => {
    const html = `<html><body><form>
      <textarea id="cover_letter" name="cover_letter"></textarea>
    </form></body></html>`;
    const page = rawPageFromHtml(html, "https://acme.example/careers/apply");
    const form = parseGreenhouse(page);
    const field = form.fields.find((f) => f.id === idFor("#cover_letter"));
    expect(field?.canonicalField).toBe("cover_letter_text");
    expect(field?.mappingConfidence).toBe(0.9);
  });
});
