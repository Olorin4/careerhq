import { describe, expect, it } from "vitest";
import { contentHashOf, stripHtml } from "./normalize.js";

describe("stripHtml", () => {
  it("removes tags, decodes common entities, collapses whitespace", () => {
    expect(stripHtml("<p>Hello&nbsp;&amp;\n<b>world</b></p>")).toBe("Hello & world");
  });
});
describe("contentHashOf (spec §5.2 key 2)", () => {
  const base = { companyName: "Acme", title: "Engineer", descriptionMd: "<p>Build things</p>" };
  it("is stable across case and whitespace variants", () => {
    expect(contentHashOf(base)).toBe(
      contentHashOf({ companyName: " ACME ", title: "engineer", descriptionMd: "Build   things" }),
    );
  });
  it("differs when the title differs", () => {
    expect(contentHashOf(base)).not.toBe(contentHashOf({ ...base, title: "Designer" }));
  });
  it("uses only the first 500 description chars", () => {
    const long = "x".repeat(600);
    expect(contentHashOf({ ...base, descriptionMd: long }))
      .toBe(contentHashOf({ ...base, descriptionMd: long.slice(0, 500) + "DIFFERENT TAIL" }));
  });
});
