import { describe, expect, it } from "vitest";
import { leverPage } from "@careerhq/demo-ats";
import { rawFieldId, type RawField } from "../raw.js";
import {
  loadGreenhouseFixture, loadLeverFixture as loadFixture, readGreenhouseFixtureHash, readLeverFixtureHash,
} from "../testing/fixtures.js";
import { rawPageFromHtml } from "../testing/from-html.js";
import { parseGreenhouse } from "./greenhouse.js";
import { hashRawFormPage, parseForm, parseLever } from "./lever.js";

const job = { id: "eng-1", title: "Senior Robotics Engineer", company: "Northwind Robotics" };
const url = "https://northwind.example/lever/jobs/eng-1";

function idFor(selector: string): string {
  return rawFieldId({ selector } as RawField);
}

describe("parseLever (committed fixture)", () => {
  const page = loadFixture();
  const form = parseLever(page);

  it("sets atsType to lever", () => {
    expect(form.atsType).toBe("lever");
  });

  it("has a single totalSteps (Lever's single-page form)", () => {
    expect(form.totalSteps).toBe(1);
  });

  it("maps the single 'name' field to full_name at 0.9 confidence", () => {
    const field = form.fields.find((f) => f.id === idFor("#name"));
    expect(field?.canonicalField).toBe("full_name");
    expect(field?.mappingConfidence).toBe(0.9);
  });

  it("maps identity/url fields to their canonical fields at 0.9 confidence", () => {
    const cases: Array<[string, string]> = [
      ["#email", "email"],
      ["#phone", "phone"],
      ["#resume", "resume_file"],
      ['input[name="cards[urls][LinkedIn]"]', "linkedin_url"],
      ['input[name="cards[urls][Portfolio]"]', "portfolio_url"],
    ];
    for (const [selector, canonicalField] of cases) {
      const field = form.fields.find((f) => f.id === idFor(selector));
      expect(field?.canonicalField).toBe(canonicalField);
      expect(field?.mappingConfidence).toBe(0.9);
    }
  });

  it("maps the notice-period select to notice_period at 0.9", () => {
    const field = form.fields.find((f) => f.id === idFor("#notice_period"));
    expect(field?.canonicalField).toBe("notice_period");
    expect(field?.mappingConfidence).toBe(0.9);
  });

  it("maps the 'Additional information' comments textarea to screening_question at 0.9", () => {
    const field = form.fields.find((f) => f.id === idFor("#comments"));
    expect(field?.canonicalField).toBe("screening_question");
    expect(field?.mappingConfidence).toBe(0.9);
  });
});

describe("fix round: availability no longer collides with notice_period", () => {
  it("maps a 'notice' field and an 'availability' field to their own distinct canonical fields", () => {
    const html = `<html><body><form>
      <input id="notice" name="notice" />
      <input id="availability" name="availability" />
    </form></body></html>`;
    const page = rawPageFromHtml(html, "https://acme.example/lever/apply");
    const form = parseLever(page);

    const notice = form.fields.find((f) => f.id === idFor("#notice"));
    expect(notice?.canonicalField).toBe("notice_period");
    expect(notice?.mappingConfidence).toBe(0.9);

    const availability = form.fields.find((f) => f.id === idFor("#availability"));
    expect(availability?.canonicalField).toBe("availability");
    expect(availability?.mappingConfidence).toBe(0.9);
  });
});

describe("attestation checkboxes map to legal_attestation", () => {
  it("maps a checkbox whose label reads as an attestation, and leaves a typed signature alone", () => {
    const html = `<html><body><form>
      <div class="field"><label for="consent">
        <input type="checkbox" id="consent" name="consent" required />
        I certify that the information provided is accurate
      </label></div>
      <div class="field">
        <label for="signature">Type your full legal name to certify this application</label>
        <input type="text" id="signature" name="signature" required />
      </div>
    </form></body></html>`;
    const page = rawPageFromHtml(html, "https://acme.example/lever/apply");
    const form = parseLever(page);

    const consent = form.fields.find((f) => f.id === idFor("#consent"));
    expect(consent?.canonicalField).toBe("legal_attestation");
    expect(consent?.mappingConfidence).toBe(0.9);

    // A typed signature is NOT a consent tick — it stays unmapped and is
    // pause-and-return's job (blockers.ts), not the review screen's.
    const signature = form.fields.find((f) => f.id === idFor("#signature"));
    expect(signature?.canonicalField).toBe("unknown");
  });
});

describe("readLeverFixtureHash (parser-drift tripwire)", () => {
  it("still matches the sha256 of the live demo-ats helper output", () => {
    const livePage = rawPageFromHtml(leverPage(job), url);
    expect(hashRawFormPage(livePage)).toBe(readLeverFixtureHash());
  });
});

describe("parseForm dispatch", () => {
  it("dispatches a greenhouse-marked page to parseGreenhouse", () => {
    const page = loadGreenhouseFixture();
    expect(parseForm(page)).toEqual(parseGreenhouse(page));
    expect(readGreenhouseFixtureHash()).toBe(hashRawFormPage(page));
  });

  it("dispatches a lever-marked page to parseLever", () => {
    const page = loadFixture();
    expect(parseForm(page)).toEqual(parseLever(page));
  });

  it("falls back to the generic parser at 0.4 confidence for a marker-less page", () => {
    const page = rawPageFromHtml(
      `<html><body><form><input name="q" /></form></body></html>`,
      "https://example.com/careers",
    );
    const form = parseForm(page);
    expect(form.atsType).toBe("generic");
    expect(form.parseConfidence).toBe(0.4);
    expect(form.fields.every((f) => f.canonicalField === "unknown")).toBe(true);
  });
});
