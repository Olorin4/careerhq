#!/usr/bin/env -S pnpm exec tsx
// Regenerates a committed adapter regression fixture
// (packages/autoapply/fixtures/<adapter>-page.json) from the demo-ats page
// builders, using the SAME job/url each adapter's test suite hashes
// against (see e.g. src/adapters/greenhouse.test.ts).
//
// Run via: pnpm --filter @careerhq/autoapply exec tsx scripts/write-fixture.ts <adapter>
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { greenhousePage, leverPage, type DemoJob } from "@careerhq/demo-ats";
import { rawPageFromHtml } from "../src/testing/from-html.js";

const JOB: DemoJob = { id: "eng-1", title: "Senior Robotics Engineer", company: "Northwind Robotics" };

const BUILDERS: Record<string, { html: () => string; url: string }> = {
  greenhouse: {
    html: () => greenhousePage(JOB),
    url: "https://northwind.example/greenhouse/jobs/eng-1",
  },
  lever: {
    html: () => leverPage(JOB),
    url: "https://northwind.example/lever/jobs/eng-1",
  },
};

const adapter = process.argv[2];
const config = adapter ? BUILDERS[adapter] : undefined;
if (!config) {
  console.error(`Usage: tsx scripts/write-fixture.ts <${Object.keys(BUILDERS).join("|")}>`);
  process.exit(1);
}

const page = rawPageFromHtml(config.html(), config.url);

const outDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures");
const outFile = path.join(outDir, `${adapter}-page.json`);
writeFileSync(outFile, `${JSON.stringify(page, null, 2)}\n`, "utf8");
console.log(`Wrote ${outFile}`);
