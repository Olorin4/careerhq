// Test-only fixture loaders and the parser-drift tripwire hashes (spec §10.5).
//
// These deliberately live OUTSIDE the adapters. `greenhouse.ts` and `lever.ts`
// used to compute their fixture hash in a module-level `const`, which meant
// every importer read a test fixture off disk at import time — including
// apps/web's production server bundle, where `@careerhq/autoapply` is reachable
// from the application-detail server actions. Webpack leaves
// `import.meta.dirname` undefined there, so `path.resolve(undefined, …)` threw
// and every server action on `/applications/[id]` returned HTTP 500. Production
// code has no business reading test fixtures at all, so the read moved here,
// behind functions the tests call.
//
// Nothing in `src/index.ts` reaches this module, so it never enters a bundle.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashRawFormPage } from "../adapters/greenhouse.js";
import type { RawFormPage } from "../raw.js";

const FIXTURE_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "fixtures");

function loadFixture(name: string): RawFormPage {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as RawFormPage;
}

/** The committed `fixtures/greenhouse-page.json`, as captured by `scripts/write-fixture.ts`. */
export function loadGreenhouseFixture(): RawFormPage {
  return loadFixture("greenhouse-page.json");
}

/** The committed `fixtures/lever-page.json`, as captured by `scripts/write-fixture.ts lever`. */
export function loadLeverFixture(): RawFormPage {
  return loadFixture("lever-page.json");
}

/**
 * sha256 of the committed Greenhouse fixture — the parser-drift tripwire.
 * Compared in greenhouse.test.ts against a freshly-computed hash of the live
 * demo-ats helper output: if apps/demo-ats's Greenhouse markup drifts without
 * regenerating the fixture (`scripts/write-fixture.ts`), that test fails.
 */
export function readGreenhouseFixtureHash(): string {
  return hashRawFormPage(loadGreenhouseFixture());
}

/** Same tripwire for Lever; regenerate with `scripts/write-fixture.ts lever`. */
export function readLeverFixtureHash(): string {
  return hashRawFormPage(loadLeverFixture());
}
