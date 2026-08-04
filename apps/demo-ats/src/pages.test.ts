import { describe, expect, it } from "vitest";
import {
  captchaPage,
  confirmationPage,
  consentPage,
  greenhousePage,
  hiddenConsentPage,
  leverPage,
  loginPage,
  signaturePage,
} from "./pages.js";

const job = { id: "eng-1", title: "Senior Robotics Engineer", company: "Northwind Robotics" };

describe("demo-ats pages", () => {
  it("greenhouse page carries the ats marker, 3 steps and the sensitive selects", () => {
    const html = greenhousePage(job);
    expect(html).toContain('data-source="greenhouse"');
    expect(html).toContain('id="application_form"');
    expect(html).toContain('data-step="3"');
    expect(html.toLowerCase()).toContain("work authorization");
    expect(html.toLowerCase()).toContain("sponsorship");
    expect(html).toContain('id="btn_submit"');
  });
  it("greenhouse page gives each step's Next button a distinct id, and no id repeats in the document", () => {
    const html = greenhousePage(job);
    expect(html).toContain('id="btn_next_1"');
    expect(html).toContain('id="btn_next_2"');
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBeGreaterThan(0);
    expect(uniqueIds.size).toBe(ids.length);
  });
  it("lever page is single-step with a resume input and notice-period select", () => {
    const html = leverPage(job);
    expect(html).toContain('data-source="lever"');
    expect(html).toContain('name="resume"');
    expect(html.toLowerCase()).toContain("notice period");
    expect(html).not.toContain('id="btn_next"');
  });
  it("greenhouse and lever <title> follow the '<role> at <company>' convention the parser splits on", () => {
    expect(greenhousePage(job)).toContain(
      "<title>Senior Robotics Engineer at Northwind Robotics</title>",
    );
    expect(leverPage(job)).toContain("<title>Senior Robotics Engineer at Northwind Robotics</title>");
  });
  it("captcha and login pages expose their blocker markers", () => {
    expect(captchaPage(job)).toContain("g-recaptcha");
    expect(loginPage(job)).toContain('type="password"');
  });
  it("confirmation page exposes the id twice (text and attribute)", () => {
    const html = confirmationPage("NR-abc12345");
    expect(html).toContain("Application received");
    expect(html).toContain("Confirmation ID: NR-abc12345");
    expect(html).toContain('data-confirmation-id="NR-abc12345"');
  });
  it("consent page ships its two OPTIONAL consent boxes pre-ticked, and the required attestation unticked", () => {
    const html = consentPage(job);
    // The whole point of this fixture: the server decides these are ticked, so
    // "the planner left it blank" is not the same as "the box is clear".
    expect(html).toContain(
      '<input type="checkbox" id="background_check_consent" name="background_check_consent" value="true" checked />',
    );
    expect(html).toContain(
      '<input type="checkbox" id="talent_pool_opt_in" name="talent_pool_opt_in" value="true" checked />',
    );
    // The required attestation is NOT pre-ticked — a required empty answer
    // already blocks the review screen, so it is not the dangerous case.
    expect(html).toContain(
      '<input type="checkbox" id="legal_attestation" name="legal_attestation" aria-required="true" required value="true" />',
    );
    expect(html).toContain('name="resume"');
    expect(html).not.toContain('type="password"');
  });

  it("hidden-consent page ships the same pre-ticked box inside a display:none wrapper", () => {
    const html = hiddenConsentPage(job);
    expect(html).toContain('<div class="field" style="display:none">');
    expect(html).toContain(
      '<input type="checkbox" id="background_check_consent" name="background_check_consent" value="true" checked />',
    );
    // No custom widget stands in for it — the point is a control Playwright
    // cannot act on, so uncheck() times out.
    expect(html).toContain('id="btn_submit"');
  });

  it("signature page carries a typed-signature and date attestation, no checkbox", () => {
    const html = signaturePage(job);
    expect(html).toContain('data-source="lever"');
    expect(html.toLowerCase()).toContain("type your full legal name");
    expect(html.toLowerCase()).toContain("date of signature");
    expect(html).toContain('name="resume"');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain("g-recaptcha");
  });
});
