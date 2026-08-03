import { describe, expect, it } from "vitest";
import { greenhousePage, leverPage } from "@careerhq/demo-ats";
import { rawPageFromHtml } from "./testing/from-html.js";
import { detectAts } from "./detect.js";

const job = { id: "eng-1", title: "Senior Robotics Engineer", company: "Northwind Robotics" };

describe("detectAts", () => {
  it("detects greenhouse from the demo-ats fixture with high confidence", () => {
    const page = rawPageFromHtml(greenhousePage(job), "https://northwind.example/greenhouse/jobs/eng-1");
    expect(detectAts(page)).toEqual({ atsType: "greenhouse", confidence: 0.95 });
  });

  it("detects lever from the demo-ats fixture with high confidence", () => {
    const page = rawPageFromHtml(leverPage(job), "https://northwind.example/lever/jobs/eng-1");
    expect(detectAts(page)).toEqual({ atsType: "lever", confidence: 0.95 });
  });

  it("falls back to generic with low confidence when no ATS markers are present", () => {
    const page = rawPageFromHtml(
      `<html><body><form><input name="q" /></form></body></html>`,
      "https://example.com/careers",
    );
    expect(detectAts(page)).toEqual({ atsType: "generic", confidence: 0.4 });
  });

  it("detects lever purely from a cards[...]-style field name, without a lever marker", () => {
    const page = rawPageFromHtml(
      `<html><body><form><input name="cards[urls][LinkedIn]" /></form></body></html>`,
      "https://example.com/apply",
    );
    expect(detectAts(page)).toEqual({ atsType: "lever", confidence: 0.95 });
  });
});
