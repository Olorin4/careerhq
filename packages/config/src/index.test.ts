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
});
