import { readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import postcss, { type AtRule, type ChildNode, type Container, type Document } from "postcss";
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

/**
 * The regression guard for the final branch review's Finding 1: Inter was
 * downloaded on every page load and never used to paint a glyph, because
 * `globals.css` kept an UNLAYERED `body { font-family: system-ui, … }` while
 * the `font-sans` utility that carries `--font-sans` compiles into
 * `@layer utilities` — and an unlayered rule outranks a layered one whatever
 * the specificity. Every test, typecheck, lint and build passed through it,
 * including this file's own checks above: they read `tokens.css` as text and
 * so cannot see a cascade, a Tailwind config or a compiled utility.
 *
 * So these compile `globals.css` through the app's REAL pipeline
 * (`@tailwindcss/postcss`, which follows the `@config` line to
 * `tailwind.config.ts` and scans `src/`) and assert against the emitted CSS.
 *
 * What this deliberately does NOT do is assert a computed style. That needs a
 * browser: jsdom's CSS engine implements neither `@layer` nor `var()`, so the
 * one measurement that settles this — `getComputedStyle(document.body)
 * .fontFamily` starting with "Inter" — is only meaningful against a real
 * engine and is part of the live verification instead. What is asserted here
 * is the complete chain that produces it: the loader names `--font-sans`,
 * `<body>` carries `font-sans`, `font-sans` resolves to `var(--font-sans)`,
 * and nothing unlayered declares a family that would outrank it.
 */
describe("the app's font stack", () => {
  const appDir = path.resolve(import.meta.dirname);
  const globals = path.join(appDir, "globals.css");
  const layout = readFileSync(path.join(appDir, "layout.tsx"), "utf8");

  async function compile(): Promise<Container> {
    const result = await postcss([tailwindcss()]).process(readFileSync(globals, "utf8"), { from: globals });
    return result.root;
  }

  it("loads Inter into the same custom property the font utility reads", () => {
    expect(layout).toMatch(/Inter\(\{[^}]*variable:\s*"--font-sans"/s);
    expect(layout).toMatch(/<body className="[^"]*\bfont-sans\b/);
  });

  it("compiles a font-sans utility that resolves to that property", async () => {
    const root = await compile();
    const families: string[] = [];
    root.walkRules(/(^|,)\s*\.font-sans\b/, (rule) => {
      rule.walkDecls("font-family", (decl) => {
        families.push(decl.value);
      });
    });
    expect(families).toContain("var(--font-sans)");
  });

  it("declares no font-family outside a layer, where it would outrank that utility", async () => {
    const root = await compile();
    const unlayered: string[] = [];
    root.walkDecls("font-family", (decl) => {
      let node: Container | ChildNode | Document | undefined = decl.parent;
      let layered = false;
      while (node) {
        if (node.type === "atrule" && (node as AtRule).name === "layer") layered = true;
        node = node.parent;
      }
      if (!layered) unlayered.push(`${decl.parent?.toString().split("{")[0]?.trim()} { ${decl.toString()} }`);
    });
    expect(unlayered).toEqual([]);
  });
});
