import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { leverPage } from "@careerhq/demo-ats";
import { rawFieldId, type RawField, type RawFormPage } from "../raw.js";
import { rawPageFromHtml } from "../testing/from-html.js";
import { GREENHOUSE_FIXTURE_HASH, parseGreenhouse } from "./greenhouse.js";
import { hashRawFormPage, LEVER_FIXTURE_HASH, parseForm, parseLever } from "./lever.js";

const job = { id: "eng-1", title: "Senior Robotics Engineer", company: "Northwind Robotics" };
const url = "https://northwind.example/lever/jobs/eng-1";

const FIXTURE_PATH = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "fixtures",
  "lever-page.json",
);

const GREENHOUSE_FIXTURE_PATH = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "fixtures",
  "greenhouse-page.json",
);

function loadFixture(): RawFormPage {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as RawFormPage;
}

function loadGreenhouseFixture(): RawFormPage {
  return JSON.parse(readFileSync(GREENHOUSE_FIXTURE_PATH, "utf8")) as RawFormPage;
}

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

describe("LEVER_FIXTURE_HASH (parser-drift tripwire)", () => {
  it("still matches the sha256 of the live demo-ats helper output", () => {
    const livePage = rawPageFromHtml(leverPage(job), url);
    expect(hashRawFormPage(livePage)).toBe(LEVER_FIXTURE_HASH);
  });
});

describe("parseForm dispatch", () => {
  it("dispatches a greenhouse-marked page to parseGreenhouse", () => {
    const page = loadGreenhouseFixture();
    expect(parseForm(page)).toEqual(parseGreenhouse(page));
    expect(GREENHOUSE_FIXTURE_HASH).toBe(hashRawFormPage(page));
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
