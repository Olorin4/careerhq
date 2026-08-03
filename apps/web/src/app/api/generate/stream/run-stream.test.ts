import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type * as AiModule from "@careerhq/ai";
import type { FallbackOptions, GenerateInput } from "@careerhq/ai";
import { loadConfig, type AppConfig } from "@careerhq/config";
import {
  createApplication, createDb, createFact, jobs as jobsTable, listDocuments, workspaces, type Db,
} from "@careerhq/db";
import type { GenerationDeps } from "../../../../lib/generation.js";
import { createSseWriter, type SseController } from "./sse-writer.js";
import { runStream } from "./run-stream.js";

// `runStream` calls `streamChatJson` directly (not injected via `deps`, since
// it's a real network round-trip in the non-test path) — mocked here the
// same way `apps/worker/src/jobs/ingest.test.ts` mocks `rerankJobs`, so the
// "stream attempt failed" branch can be forced without a live API key. Note
// vitest hoists `vi.mock` above all imports in this file at transform time,
// so `runStream` above still resolves against the mocked `@careerhq/ai`.
const { streamChatJsonMock } = vi.hoisted(() => ({ streamChatJsonMock: vi.fn() }));
vi.mock("@careerhq/ai", async (importOriginal) => ({
  ...await importOriginal<typeof AiModule>(),
  streamChatJson: streamChatJsonMock,
}));

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

const BASE_ENV = {
  DATABASE_URL: url ?? "postgres://u:p@localhost:5432/careerhq",
  OPENROUTER_API_KEY: "sk-or-test",
  AI_REPLAY_DIR: mkdtempSync(path.join(tmpdir(), "careerhq-stream-replay-")),
};

function config(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...BASE_ENV, ...overrides });
}

let db: Db;
let workspaceId: string;
let applicationId: string;
let freshFactId: string;

const YEAR = 365 * 24 * 60 * 60 * 1000;

/** A controller stub that always throws — exactly what a disconnected client's
 *  `ReadableStreamDefaultController` does on `enqueue`/`close`. */
function makeDisconnectedController(): SseController {
  return {
    enqueue: () => {
      throw new Error("Controller is already closed");
    },
    close: () => {
      throw new Error("Controller is already closed");
    },
  };
}

/** A `generate` stub matching `generation.test.ts`'s convention. */
function stubGenerate(
  result: { answer: string; factIds: string[]; confidence: number; unsupportedClaims: string[] },
) {
  return vi.fn<(input: GenerateInput, opts: FallbackOptions) => Promise<{
    ok: true; value: typeof result; model: string; latencyMs: number; status: number; error: null;
    attempts: [];
  }>>(async () => ({
    ok: true, value: result, model: "fallback/stub-model", latencyMs: 1, status: 200, error: null, attempts: [],
  }));
}

beforeAll(async () => {
  if (!url) return;
  db = createDb(url);
  const [ws] = await db.insert(workspaces).values({ name: `t-stream-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;
  const app = await createApplication(db, {
    workspaceId, companyName: "Streamline Inc", jobTitle: "Backend Engineer",
  });
  applicationId = app.id;
  await db.update(jobsTable)
    .set({ descriptionMd: "<p>Backend engineering role.</p>" })
    .where(eq(jobsTable.id, app.jobId));
  freshFactId = (await createFact(db, {
    workspaceId, category: "experience", claim: "5 years backend engineering",
    detail: "Node and Postgres", reviewBy: new Date(Date.now() + YEAR),
  })).id;
});

afterAll(async () => {
  if (!url) return;
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.$client.end();
});

d("runStream — client disconnect during the fallback path", () => {
  it("still runs the non-streaming fallback and persists a draft when send() can never reach the client", async () => {
    // Force the streaming attempt to fail so runStream takes the fallback
    // branch (send({type:"fallback"}) then await runGeneration(...)).
    streamChatJsonMock.mockResolvedValue({
      ok: false, value: null, model: "m", latencyMs: 1, status: null, error: "timeout",
    });

    const writer = createSseWriter(makeDisconnectedController(), (e) => JSON.stringify(e));
    const generate = stubGenerate({
      answer: "Fallback draft written after the client vanished.",
      factIds: [freshFactId], confidence: 0.9, unsupportedClaims: [],
    });

    const deps: GenerationDeps = { db, config: config(), generate };
    const before = (await listDocuments(db, applicationId)).length;

    // The bug this fixes: previously `send({type:"fallback"})` threw on an
    // already-closed controller, aborting runStream before `runGeneration`
    // ever ran — so nothing was persisted despite the mandated fallback.
    await expect(
      runStream(deps, { workspaceId, applicationId, kind: "cover_letter" }, writer.send),
    ).resolves.toBeUndefined();

    expect(generate).toHaveBeenCalledTimes(1);
    const after = await listDocuments(db, applicationId);
    expect(after.length).toBe(before + 1);
    const persisted = after.find((row) => row.contentMd.includes("Fallback draft written"));
    expect(persisted).toBeDefined();
    expect(persisted!.origin).toBe("ai");
    expect(persisted!.sourceFactIds).toEqual([freshFactId]);
  });
});
