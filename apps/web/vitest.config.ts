import { defineConfig } from "vitest/config";

// Next's own tsconfig sets "jsx": "preserve" for its SWC pipeline; esbuild
// (what Vitest transforms .tsx through) doesn't understand that value and
// falls back to the classic `React.createElement` transform, which then
// throws "React is not defined" because nothing imports React implicitly.
// The component tests are the first .tsx specs in this package to actually
// render JSX, so pin esbuild to the automatic runtime here.
export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    // @testing-library/react's automatic per-test `cleanup()` only wires
    // itself up when it finds a global `afterEach` — without this, the
    // button/badge/countdown specs' explicitly-imported `afterEach` never
    // triggers it, and DOM nodes from one `it` leak into the next.
    globals: true,
  },
});
