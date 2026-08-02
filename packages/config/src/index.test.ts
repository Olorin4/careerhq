import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

const BASE = { DATABASE_URL: "postgres://u:p@localhost:5432/careerhq" };

describe("loadConfig", () => {
  it("requires DATABASE_URL", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
  it("explains a missing DATABASE_URL in prose, not as a raw ZodError", () => {
    expect(() => loadConfig({})).toThrow(/copy \.env\.example to \.env/);
  });
  it("rejects a non-postgres DATABASE_URL", () => {
    expect(() => loadConfig({ DATABASE_URL: "mysql://u:p@localhost:3306/careerhq" })).toThrow(/postgres:\/\//);
  });
  it("defaults every submission gate to OFF (spec §11)", () => {
    const cfg = loadConfig(BASE);
    expect(cfg.submissionsLiveEmail).toBe(false);
    expect(cfg.submissionsLiveCompanySite).toBe(false);
  });
  it("parses gates and follow-up override", () => {
    const cfg = loadConfig({ ...BASE, SUBMISSIONS_LIVE_EMAIL: "true", FOLLOW_UP_DAYS: "10" });
    expect(cfg.submissionsLiveEmail).toBe(true);
    expect(cfg.followUpDays).toBe(10);
  });
  it("rejects non-numeric FOLLOW_UP_DAYS", () => {
    expect(() => loadConfig({ ...BASE, FOLLOW_UP_DAYS: "soon" })).toThrow();
  });
  it("resolves a relative FILE_STORAGE_DIR against the repo root, not cwd", () => {
    // vitest runs with cwd = packages/config; the shared file tree is at the
    // repo root, so seed and web must agree on the same absolute directory.
    const dir = loadConfig(BASE).fileStorageDir;
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir).toBe(path.resolve(process.cwd(), "../..", "var/files"));
  });
  it("keeps an absolute FILE_STORAGE_DIR as given (the Docker volume path)", () => {
    expect(loadConfig({ ...BASE, FILE_STORAGE_DIR: "/app/var/files" }).fileStorageDir).toBe("/app/var/files");
  });

  it("defaults AI features off: no OPENROUTER_API_KEY → null", () => {
    expect(loadConfig(BASE).openrouterApiKey).toBeNull();
  });
  it("passes through OPENROUTER_API_KEY when set", () => {
    expect(loadConfig({ ...BASE, OPENROUTER_API_KEY: "sk-or-123" }).openrouterApiKey).toBe("sk-or-123");
  });
  // Compose sets `OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}`, so "" is the
  // live default in containers — it must mean "off", exactly like unset.
  it("treats an empty OPENROUTER_API_KEY as unset", () => {
    expect(loadConfig({ ...BASE, OPENROUTER_API_KEY: "" }).openrouterApiKey).toBeNull();
  });
  it("treats a whitespace-only OPENROUTER_API_KEY as unset", () => {
    expect(loadConfig({ ...BASE, OPENROUTER_API_KEY: "  " }).openrouterApiKey).toBeNull();
  });
  it("defaults aiFastModels to the free-tier fallback list", () => {
    expect(loadConfig(BASE).aiFastModels).toEqual([
      "google/gemini-2.0-flash-exp:free",
      "meta-llama/llama-3.3-70b-instruct:free",
    ]);
  });
  it("parses AI_FAST_MODELS as a comma list, trimming whitespace and dropping empties", () => {
    expect(loadConfig({ ...BASE, AI_FAST_MODELS: "a,b , c" }).aiFastModels).toEqual(["a", "b", "c"]);
  });
  it("drops empty entries from AI_FAST_MODELS (trailing comma, blank segments)", () => {
    expect(loadConfig({ ...BASE, AI_FAST_MODELS: "a,,b," }).aiFastModels).toEqual(["a", "b"]);
  });
  // Compose sets `AI_FAST_MODELS: ${AI_FAST_MODELS:-}`, so "" is the live
  // default in containers. An explicit "" bypasses zod's .default(), and an
  // empty model list would leave the fallback client with nothing to try.
  it("falls back to the default model list when AI_FAST_MODELS is empty", () => {
    expect(loadConfig({ ...BASE, AI_FAST_MODELS: "" }).aiFastModels).toEqual([
      "google/gemini-2.0-flash-exp:free",
      "meta-llama/llama-3.3-70b-instruct:free",
    ]);
  });
  it("falls back to the default model list when AI_FAST_MODELS holds only separators", () => {
    expect(loadConfig({ ...BASE, AI_FAST_MODELS: " , ," }).aiFastModels).toEqual([
      "google/gemini-2.0-flash-exp:free",
      "meta-llama/llama-3.3-70b-instruct:free",
    ]);
  });
  it("never returns an empty aiFastModels list", () => {
    expect(loadConfig({ ...BASE, AI_FAST_MODELS: "" }).aiFastModels.length).toBeGreaterThan(0);
  });
  it("defaults ingestCron to every 6 hours", () => {
    expect(loadConfig(BASE).ingestCron).toBe("0 */6 * * *");
  });
  it("passes through a custom INGEST_CRON", () => {
    expect(loadConfig({ ...BASE, INGEST_CRON: "*/15 * * * *" }).ingestCron).toBe("*/15 * * * *");
  });
});
