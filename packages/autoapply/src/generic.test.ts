import { describe, expect, it } from "vitest";
import { greenhousePage, leverPage } from "@careerhq/demo-ats";
import { rawPageFromHtml } from "./testing/from-html.js";
import { rawFieldId, type RawField } from "./raw.js";
import { parseGenericForm } from "./generic.js";

const job = { id: "eng-1", title: "Senior Robotics Engineer", company: "Northwind Robotics" };
const url = "https://northwind.example/greenhouse/jobs/eng-1";

function idFor(selector: string): string {
  return rawFieldId({ selector } as RawField);
}

describe("parseGenericForm (greenhouse demo-ats fixture)", () => {
  const page = rawPageFromHtml(greenhousePage(job), url);
  const form = parseGenericForm(page, { atsType: "greenhouse", parseConfidence: 0.95 });

  it("yields at least 10 fields", () => {
    expect(form.fields.length).toBeGreaterThanOrEqual(10);
  });

  it("assigns stable ids: identical input reproduces the same ids", () => {
    const rebuilt = parseGenericForm(rawPageFromHtml(greenhousePage(job), url), {
      atsType: "greenhouse",
      parseConfidence: 0.95,
    });
    expect(rebuilt.fields.map((f) => f.id)).toEqual(form.fields.map((f) => f.id));
  });

  it("assigns a different id for a different selector", () => {
    expect(idFor("#first_name")).not.toBe(idFor("#last_name"));
  });

  it("maps the why_northwind textarea to kind textarea", () => {
    const field = form.fields.find((f) => f.id === idFor("#why_northwind"));
    expect(field?.kind).toBe("textarea");
  });

  it("preserves select options in document order", () => {
    const field = form.fields.find((f) => f.id === idFor("#work_authorization"));
    expect(field?.options).toEqual([
      { value: "", label: "-- Select --" },
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ]);
  });

  it("derives required from aria-required/required", () => {
    const required = form.fields.find((f) => f.id === idFor("#first_name"));
    expect(required?.required).toBe(true);
    const optional = form.fields.find((f) => f.id === idFor("#phone"));
    expect(optional?.required).toBe(false);
  });

  it("reports totalSteps 3 for the three-section wizard", () => {
    expect(form.totalSteps).toBe(3);
  });

  it("derives requisitionKey from host + pathname", () => {
    expect(form.requisitionKey).toBe("northwind.example/greenhouse/jobs/eng-1");
  });

  it("leaves canonicalField unknown for every field (Task 7 maps it)", () => {
    expect(form.fields.every((f) => f.canonicalField === "unknown" && f.mappingConfidence === 0)).toBe(true);
  });
});

describe("parseGenericForm (lever demo-ats fixture, single-page)", () => {
  it("reports totalSteps 1 when the page has no [data-step] sections", () => {
    const page = rawPageFromHtml(leverPage(job), "https://northwind.example/lever/jobs/eng-1");
    const form = parseGenericForm(page, { atsType: "lever", parseConfidence: 0.95 });
    expect(form.totalSteps).toBe(1);
    expect(form.fields.every((f) => f.step === 0)).toBe(true);
  });
});

describe("parseGenericForm title/companyName splitting", () => {
  it("splits '<title> at <company>' on the first ' at '", () => {
    const html = `<html><head><title>Software Engineer at Acme Corp</title></head><body><form><input id="x" name="x" /></form></body></html>`;
    const form = parseGenericForm(rawPageFromHtml(html, "https://acme.example/careers/apply"), {
      atsType: "generic",
      parseConfidence: 0.4,
    });
    expect(form.title).toBe("Software Engineer");
    expect(form.companyName).toBe("Acme Corp");
  });

  it("leaves companyName empty when there is no ' at ' separator", () => {
    const html = `<html><head><title>Apply Now</title></head><body><form><input id="x" name="x" /></form></body></html>`;
    const form = parseGenericForm(rawPageFromHtml(html, "https://acme.example/careers/apply"), {
      atsType: "generic",
      parseConfidence: 0.4,
    });
    expect(form.title).toBe("Apply Now");
    expect(form.companyName).toBe("");
  });
});
