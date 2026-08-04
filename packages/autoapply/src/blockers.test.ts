import { describe, expect, it } from "vitest";
import { captchaPage, loginPage } from "@careerhq/demo-ats";
import { rawPageFromHtml } from "./testing/from-html.js";
import { detectBlockers } from "./blockers.js";

const job = { id: "x", title: "Open Position", company: "Northwind Robotics" };

describe("detectBlockers", () => {
  it("flags the demo-ats captcha fixture with exactly one captcha blocker", () => {
    const page = rawPageFromHtml(captchaPage(job), "https://northwind.example/captcha/jobs/x");
    expect(detectBlockers(page).map((b) => b.kind)).toEqual(["captcha"]);
  });

  it("flags the demo-ats login fixture with exactly one login_required blocker", () => {
    const page = rawPageFromHtml(loginPage(job), "https://northwind.example/login/jobs/x");
    expect(detectBlockers(page).map((b) => b.kind)).toEqual(["login_required"]);
  });

  it("flags login_required for ANY password input, even beside a resume upload", () => {
    // The "create an account while you apply" page. Without this rule the
    // password becomes a plain `text` field (generic.ts has no password kind),
    // gets planned like any other answer, and its plaintext value is persisted
    // into form_snapshots.planned_answers, the fingerprinted payload and the
    // receipt — which spec §13 forbids outright.
    const html = `<html><body><form>
      <input type="password" id="password" name="password" required />
      <input type="file" id="resume" name="resume" />
    </form></body></html>`;
    const page = rawPageFromHtml(html, "https://example.com/apply");
    expect(detectBlockers(page).map((b) => b.kind)).toEqual(["login_required"]);
  });

  it("flags a required attestation checkbox as legal_attestation", () => {
    const html = `<html><body><form>
      <div class="field"><label for="attest">
        <input type="checkbox" id="attest" name="attest" required />
        I certify that the above is true and complete.
      </label></div>
    </form></body></html>`;
    const page = rawPageFromHtml(html, "https://example.com/apply");
    expect(detectBlockers(page).map((b) => b.kind)).toEqual(["legal_attestation"]);
  });

  it("does not flag the same attestation checkbox when it is not required", () => {
    const html = `<html><body><form>
      <div class="field"><label for="attest">
        <input type="checkbox" id="attest" name="attest" />
        I certify that the above is true and complete.
      </label></div>
    </form></body></html>`;
    const page = rawPageFromHtml(html, "https://example.com/apply");
    expect(detectBlockers(page)).toEqual([]);
  });

  it("flags a file input whose accept excludes both pdf and doc", () => {
    const html = `<html><body><form>
      <input type="file" id="resume" name="resume" accept="image/png" required />
    </form></body></html>`;
    const page = rawPageFromHtml(html, "https://example.com/apply");
    expect(detectBlockers(page).map((b) => b.kind)).toEqual(["unsupported_file_control"]);
  });

  it("does not flag a file input with no accept restriction", () => {
    const html = `<html><body><form>
      <input type="file" id="resume" name="resume" required />
    </form></body></html>`;
    const page = rawPageFromHtml(html, "https://example.com/apply");
    expect(detectBlockers(page)).toEqual([]);
  });

  it("flags identity verification and assessment language in bodyText", () => {
    const identity = rawPageFromHtml(
      `<html><body><p>Please verify your identity with a government-issued ID.</p></body></html>`,
      "https://example.com/apply",
    );
    expect(detectBlockers(identity).map((b) => b.kind)).toEqual(["identity_verification"]);

    const assessment = rawPageFromHtml(
      `<html><body><p>Next you'll complete a timed test on HackerRank.</p></body></html>`,
      "https://example.com/apply",
    );
    expect(detectBlockers(assessment).map((b) => b.kind)).toEqual(["assessment"]);
  });
});
