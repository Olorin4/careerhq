import { describe, expect, it } from "vitest";
import { consentPage } from "@careerhq/demo-ats";
import { rawPageFromHtml } from "./testing/from-html.js";
import { parseGenericForm } from "./generic.js";
import { fieldIdentityHash, rawFieldId, type RawField } from "./raw.js";

const field = (selector: string, labelText: string): Pick<RawField, "selector" | "labelText"> => ({
  selector,
  labelText,
});

const CONSENT = field("#background_check_consent", "I consent to a background check");

describe("fieldIdentityHash", () => {
  it("is stable for the same control asking the same question", () => {
    expect(fieldIdentityHash(CONSENT)).toBe(fieldIdentityHash({ ...CONSENT }));
  });

  it("is a short hex digest, like the other parser ids", () => {
    expect(fieldIdentityHash(CONSENT)).toMatch(/^[0-9a-f]{16}$/);
  });

  /**
   * The property the whole re-verification rests on: the selector alone is not
   * the field's identity. `rawFieldId` hashes only the selector, so a page that
   * swaps the statement beside a consent tick keeps the SAME field id — the
   * planned answer still "matches" — while the question it answers has changed.
   */
  it("changes when the question changes, even though the field id does not", () => {
    const reworded = field(CONSENT.selector, "I consent to my data being sold to third parties");
    expect(rawFieldId(reworded as RawField)).toBe(rawFieldId(CONSENT as RawField));
    expect(fieldIdentityHash(reworded)).not.toBe(fieldIdentityHash(CONSENT));
  });

  it("changes when the same question moves to a different control", () => {
    expect(fieldIdentityHash(field("#other_consent", CONSENT.labelText))).not.toBe(fieldIdentityHash(CONSENT));
  });

  it("ignores whitespace differences in the label — a reflow is not a reword", () => {
    const reflowed = field(CONSENT.selector, "  I consent\n   to a  background\tcheck ");
    expect(fieldIdentityHash(reflowed)).toBe(fieldIdentityHash(CONSENT));
  });

  it("does not conflate a selector/label split with its neighbour", () => {
    // "a\nb" vs "a" + "\n" + "b": the separator must not let two different
    // (selector, label) pairs collapse onto one hash.
    expect(fieldIdentityHash(field("a\nb", "c"))).not.toBe(fieldIdentityHash(field("a", "b c")));
  });
});

describe("parsed forms carry the identity of what the user reviewed", () => {
  const url = "https://northwind.example/consent/jobs/consent-1";
  const page = rawPageFromHtml(consentPage({ id: "consent-1", title: "Robotics Engineer", company: "Northwind" }), url);
  const form = parseGenericForm(page, { atsType: "generic", parseConfidence: 0.5 });

  it("gives every field the hash of its own selector and label", () => {
    expect(form.fields.length).toBeGreaterThan(0);
    for (const parsed of form.fields) {
      const raw = page.fields.find((candidate) => rawFieldId(candidate) === parsed.id);
      expect(raw).toBeDefined();
      expect(parsed.identityHash).toBe(fieldIdentityHash(raw!));
    }
  });
});
