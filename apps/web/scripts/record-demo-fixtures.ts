/**
 * Records the hosted demo's *generation* replay fixtures (spec P6 §3, Task 8):
 * a cover letter and an email body for **every** seeded application, plus a
 * screening-question answer, each against the demo seed's exact prompt.
 *
 * Task 8 recorded only the walkthrough path (Wexford's cover letter,
 * Silvermark's email body). Task 12 then found the consequence on the live
 * demo: "Generate with AI" answered `replay_miss` on ten of the eleven other
 * applications, which is the first button a stranger presses. The case list is
 * now derived from the seeded applications themselves rather than hand-listed,
 * so a new seeded application gets a fixture on the next recording run instead
 * of silently becoming another miss.
 *
 * The demo deploys with `AI_MODE=replay` and no `OPENROUTER_API_KEY`, so every
 * AI answer a visitor sees comes out of `packages/ai/fixtures/replay/`. A
 * fixture is keyed by a hash of the prompt, and the generation prompt quotes
 * the selected facts' uuids — which is why `demo-seed.ts` pins them
 * (`demoFactId`). Re-record whenever a prompt, a seeded fact, or that pinning
 * changes; nothing else invalidates a fixture.
 *
 * Run it with a real key (never in CI), from the repo root:
 *
 *   DATABASE_URL=postgres://careerhq:careerhq@localhost:5433/careerhq \
 *   OPENROUTER_API_KEY=sk-or-... AI_MODE=record \
 *   pnpm --filter @careerhq/worker exec tsx ../web/scripts/record-demo-fixtures.ts
 *
 * (worker's `tsx` is only the runner — module resolution follows this file, so
 * apps/web's dependency tree is what loads. apps/web ships no dev runner of its
 * own and adding one would touch the lockfile.)
 *
 * Sibling: `apps/worker/scripts/record-demo-fixtures.ts` records the re-rank
 * and reply-classification fixtures, which live behind the worker's jobs.
 */
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { loadConfig } from "@careerhq/config";
import { makeFsReplayStore, replayKey } from "@careerhq/ai";
import {
  DEMO_WORKSPACE_NAME, applications, companies, createDb, jobs, seedDemoWorkspace, workspaces,
} from "@careerhq/db";
import { prepareGeneration, runGeneration, type GenerationArgs } from "../src/lib/generation.js";

const config = loadConfig();

if (config.aiMode !== "record") {
  throw new Error(`AI_MODE must be "record" to record fixtures (got "${config.aiMode}")`);
}
if (config.openrouterApiKey === null) {
  throw new Error("OPENROUTER_API_KEY must be set to record fixtures");
}

const db = createDb(config.databaseUrl);

/** Rebuilt first, so every prompt below is the one the demo actually produces. */
const { workspaceId } = await seedDemoWorkspace(db, {
  // A throwaway tree: recording only needs the rows, not the CV files.
  fileStorageDir: mkdtempSync(path.join(tmpdir(), "careerhq-record-")),
});

const [demoWorkspace] = await db.select().from(workspaces)
  .where(and(eq(workspaces.kind, "sandbox"), eq(workspaces.name, DEMO_WORKSPACE_NAME)));
if (!demoWorkspace || demoWorkspace.id !== workspaceId) {
  throw new Error("demo workspace missing after seed");
}

/**
 * Every seeded application, in the order `/applications` lists them
 * (`listApplications` sorts on `created_at`), with the company name the UI
 * shows. Derived, not hand-listed: the demo's twelve applications come from
 * three different code paths in the seed (promoted discovery listings,
 * `createApplication`, the site-submission story), and a hand-list would drift.
 */
async function seededApplications(): Promise<Array<{ id: string; company: string }>> {
  const rows = await db.select({ id: applications.id, company: companies.name })
    .from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(eq(applications.workspaceId, workspaceId))
    .orderBy(applications.createdAt, applications.id);
  if (rows.length === 0) throw new Error("no seeded applications");
  return rows;
}

const seeded = await seededApplications();
const wexford = seeded.find((a) => a.company === "Wexford Health")?.id;
if (!wexford) throw new Error("no seeded application for Wexford Health");

const cases: Array<{ label: string; args: GenerationArgs }> = [
  // Both document kinds on every application: the materials panel offers
  // "Generate with AI" for each, so any pair left unrecorded is a `replay_miss`
  // a visitor can reach in one click.
  ...seeded.flatMap(({ id, company }): Array<{ label: string; args: GenerationArgs }> => [
    { label: `cover letter — ${company}`, args: { workspaceId, applicationId: id, kind: "cover_letter" } },
    { label: `email body — ${company}`, args: { workspaceId, applicationId: id, kind: "email_body" } },
  ]),
  {
    label: "screening question",
    args: {
      workspaceId,
      applicationId: wexford,
      kind: "question",
      // The demo ATS's own screening field (`f-why` in `demoCanonicalForm`).
      question: "Why do you want to work here?",
    },
  },
];

const store = makeFsReplayStore(config.aiReplayDir);
/** `FORCE=1` re-records a case whose fixture is already committed. */
const force = process.env.FORCE === "1";

let failed = 0;
for (const { label, args } of cases) {
  // The fast-tier sensitivity tie-break is stubbed out: it has no replay
  // wrapper, so a keyless replay run skips it, and recording it would only
  // spend tokens on a call the demo never makes. It cannot change the prompt.
  const deps = { db, config, classifySensitive: async () => null };

  // Free-tier writing models fail a fair fraction of these calls (no JSON, a
  // schema-invalid body, an ungrounded answer that `validateGeneration` then
  // refuses). Skipping cases that already have a fixture makes the script
  // re-runnable until every case has one, instead of a good recording being
  // overwritten by the next run's bad one.
  const prepared = await prepareGeneration(deps, args);
  if (!prepared.ready) {
    failed += 1;
    console.error(`FAILED ${label}: prelude refused — ${JSON.stringify(prepared.outcome)}`);
    continue;
  }
  const key = replayKey("generate", prepared.prompt);
  if (!force && (await store.read(key)) !== null) {
    console.log(`kept ${label}: ${key}.json already recorded`);
    continue;
  }

  const outcome = await runGeneration(deps, args);
  if (outcome.status === "ok") {
    console.log(`recorded ${label} as ${key}: model=${outcome.model ?? "unknown"} facts=${outcome.factIds.length}`);
    continue;
  }

  failed += 1;
  console.error(`FAILED ${label}: ${JSON.stringify(outcome)}`);
  // `withReplay` records any result the *client* considered ok, including one
  // the grounding validator then refuses (unsupported claims, low confidence,
  // a clarification request). Keeping that on disk would pin the demo to an
  // answer it will reject on every replay, so it is removed: a missing
  // fixture is an honest `replay_miss`, a bad one is a permanent needs_facts.
  await rm(path.join(config.aiReplayDir, `${key}.json`), { force: true });
}

await db.$client.end();
if (failed > 0) process.exitCode = 1;
