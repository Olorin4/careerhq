import { describe, expect, it } from "vitest";
import { captchaPage, confirmationPage, greenhousePage, leverPage, loginPage } from "./pages.js";

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
  it("lever page is single-step with a resume input and notice-period select", () => {
    const html = leverPage(job);
    expect(html).toContain('data-source="lever"');
    expect(html).toContain('name="resume"');
    expect(html.toLowerCase()).toContain("notice period");
    expect(html).not.toContain('id="btn_next"');
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
});
