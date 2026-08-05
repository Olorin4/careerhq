import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REQUIRED = [
  "--canvas", "--surface", "--ink", "--muted", "--soft", "--line",
  "--anchor", "--anchor-soft", "--shadow",
  "--info", "--info-soft", "--warn", "--warn-soft",
  "--ok", "--ok-soft", "--bad", "--bad-soft", "--irreversible",
] as const;

describe("design tokens", () => {
  const css = readFileSync(path.resolve(import.meta.dirname, "tokens.css"), "utf8");

  it("defines every token the Tailwind config maps", () => {
    for (const name of REQUIRED) expect(css).toContain(`${name}:`);
  });

  it("defines them on :root so a dark palette can override them later", () => {
    expect(css).toMatch(/:root\s*\{/);
  });

  it("carries no raw hex outside the :root block", () => {
    const afterRoot = css.slice(css.indexOf("}"));
    expect(afterRoot).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
