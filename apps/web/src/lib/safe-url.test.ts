import { describe, expect, it } from "vitest";
import { safeExternalHref } from "./safe-url.js";

describe("safeExternalHref", () => {
  it("passes ordinary http(s) URLs through unchanged", () => {
    expect(safeExternalHref("https://boards.greenhouse.io/acme/jobs/1")).toBe("https://boards.greenhouse.io/acme/jobs/1");
    expect(safeExternalHref("http://example.test/x")).toBe("http://example.test/x");
  });
  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "blob:https://x.example/abc",
  ])("refuses %s", (raw) => {
    expect(safeExternalHref(raw)).toBeNull();
  });
  it("refuses relative, empty and unparseable values", () => {
    for (const raw of ["/applications/1", "", "   ", "not a url", null, undefined]) {
      expect(safeExternalHref(raw)).toBeNull();
    }
  });
});
