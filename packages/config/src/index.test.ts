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
  it("defaults emailSyncCron to every 15 minutes", () => {
    expect(loadConfig(BASE).emailSyncCron).toBe("*/15 * * * *");
  });
  it("passes through a custom EMAIL_SYNC_CRON", () => {
    expect(loadConfig({ ...BASE, EMAIL_SYNC_CRON: "*/5 * * * *" }).emailSyncCron).toBe("*/5 * * * *");
  });

  it("defaults aiMode to live", () => {
    expect(loadConfig(BASE).aiMode).toBe("live");
  });
  it("accepts record and replay as valid AI_MODE values", () => {
    expect(loadConfig({ ...BASE, AI_MODE: "record" }).aiMode).toBe("record");
    expect(loadConfig({ ...BASE, AI_MODE: "replay" }).aiMode).toBe("replay");
  });
  it("throws a prose error for an invalid AI_MODE", () => {
    expect(() => loadConfig({ ...BASE, AI_MODE: "bogus" })).toThrow(/AI_MODE/);
  });

  it("defaults aiWritingModels to the free-tier writing-tier fallback list", () => {
    expect(loadConfig(BASE).aiWritingModels).toEqual([
      "deepseek/deepseek-chat:free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "google/gemini-2.0-flash-001",
    ]);
  });
  it("parses AI_WRITING_MODELS as a comma list, trimming whitespace and dropping empties", () => {
    expect(loadConfig({ ...BASE, AI_WRITING_MODELS: "a,b , c" }).aiWritingModels).toEqual(["a", "b", "c"]);
  });
  it("falls back to the default writing model list when AI_WRITING_MODELS is empty", () => {
    expect(loadConfig({ ...BASE, AI_WRITING_MODELS: "" }).aiWritingModels).toEqual([
      "deepseek/deepseek-chat:free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "google/gemini-2.0-flash-001",
    ]);
  });
  it("falls back to the default writing model list when AI_WRITING_MODELS holds only separators", () => {
    expect(loadConfig({ ...BASE, AI_WRITING_MODELS: " , ," }).aiWritingModels).toEqual([
      "deepseek/deepseek-chat:free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "google/gemini-2.0-flash-001",
    ]);
  });
  it("never returns an empty aiWritingModels list", () => {
    expect(loadConfig({ ...BASE, AI_WRITING_MODELS: "" }).aiWritingModels.length).toBeGreaterThan(0);
  });

  // Recorded fixtures are committed under packages/ai/fixtures/replay and are
  // read by the web app (cwd apps/web) and the worker alike, so the default
  // must resolve against the repo root exactly like FILE_STORAGE_DIR.
  it("defaults aiReplayDir to the committed fixtures dir, resolved against the repo root", () => {
    const dir = loadConfig(BASE).aiReplayDir;
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir).toBe(path.resolve(process.cwd(), "../..", "packages/ai/fixtures/replay"));
  });
  it("resolves a relative AI_REPLAY_DIR against the repo root, not cwd", () => {
    const dir = loadConfig({ ...BASE, AI_REPLAY_DIR: "var/replay" }).aiReplayDir;
    expect(dir).toBe(path.resolve(process.cwd(), "../..", "var/replay"));
  });
  it("keeps an absolute AI_REPLAY_DIR as given (the container path)", () => {
    expect(loadConfig({ ...BASE, AI_REPLAY_DIR: "/app/fixtures" }).aiReplayDir).toBe("/app/fixtures");
  });

  it("defaults masterKey to null: email connections disabled with no key configured", () => {
    expect(loadConfig(BASE).masterKey).toBeNull();
  });
  // Compose sets `CAREERHQ_MASTER_KEY: ${CAREERHQ_MASTER_KEY:-}`, so "" is the
  // live default in containers — it must mean "unset", exactly like the other
  // optional secrets (OPENROUTER_API_KEY).
  it("treats an empty CAREERHQ_MASTER_KEY as unset", () => {
    expect(loadConfig({ ...BASE, CAREERHQ_MASTER_KEY: "" }).masterKey).toBeNull();
  });
  it("treats a whitespace-only CAREERHQ_MASTER_KEY as unset", () => {
    expect(loadConfig({ ...BASE, CAREERHQ_MASTER_KEY: "   " }).masterKey).toBeNull();
  });
  it("rejects a CAREERHQ_MASTER_KEY that isn't a base64 32-byte key, naming the var in prose", () => {
    expect(() => loadConfig({ ...BASE, CAREERHQ_MASTER_KEY: "too-short" })).toThrow(/CAREERHQ_MASTER_KEY/);
  });
  it("rejects a CAREERHQ_MASTER_KEY of the wrong decoded length even if valid base64", () => {
    const wrongLength = Buffer.from(new Uint8Array(16)).toString("base64");
    expect(() => loadConfig({ ...BASE, CAREERHQ_MASTER_KEY: wrongLength })).toThrow(/CAREERHQ_MASTER_KEY/);
  });
  it("round-trips a valid base64 32-byte CAREERHQ_MASTER_KEY", () => {
    const key = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
    expect(loadConfig({ ...BASE, CAREERHQ_MASTER_KEY: key }).masterKey).toBe(key);
  });

  // The sandbox_blocked gate compares a connection's SMTP host against this
  // value, so it must never come back empty — an empty allow-list entry would
  // match nothing (or, worse, an empty host) rather than the local sink.
  it("defaults sandboxSmtpAllowedHost to the compose mailpit service", () => {
    expect(loadConfig(BASE).sandboxSmtpAllowedHost).toBe("mailpit");
  });
  it("takes an explicit SANDBOX_SMTP_ALLOWED_HOST", () => {
    expect(loadConfig({ ...BASE, SANDBOX_SMTP_ALLOWED_HOST: "localhost" }).sandboxSmtpAllowedHost).toBe("localhost");
  });
  it("trims SANDBOX_SMTP_ALLOWED_HOST", () => {
    expect(loadConfig({ ...BASE, SANDBOX_SMTP_ALLOWED_HOST: " mailpit " }).sandboxSmtpAllowedHost).toBe("mailpit");
  });
  it("treats an empty SANDBOX_SMTP_ALLOWED_HOST as unset, not as an empty host", () => {
    expect(loadConfig({ ...BASE, SANDBOX_SMTP_ALLOWED_HOST: "" }).sandboxSmtpAllowedHost).toBe("mailpit");
    expect(loadConfig({ ...BASE, SANDBOX_SMTP_ALLOWED_HOST: "   " }).sandboxSmtpAllowedHost).toBe("mailpit");
  });

  // The company-site twin of the SMTP allow-list: it gates a sandbox
  // workspace's auto-apply target by hostname, so it must never come back
  // empty either — an empty value would compare equal to nothing at all.
  it("defaults sandboxSiteAllowedHost to the compose demo-ats service", () => {
    expect(loadConfig(BASE).sandboxSiteAllowedHost).toBe("demo-ats");
  });
  it("takes an explicit SANDBOX_SITE_ALLOWED_HOST", () => {
    expect(loadConfig({ ...BASE, SANDBOX_SITE_ALLOWED_HOST: "localhost" }).sandboxSiteAllowedHost).toBe("localhost");
  });
  it("trims SANDBOX_SITE_ALLOWED_HOST", () => {
    expect(loadConfig({ ...BASE, SANDBOX_SITE_ALLOWED_HOST: " demo-ats " }).sandboxSiteAllowedHost).toBe("demo-ats");
  });
  it("treats an empty SANDBOX_SITE_ALLOWED_HOST as unset, not as an empty host", () => {
    expect(loadConfig({ ...BASE, SANDBOX_SITE_ALLOWED_HOST: "" }).sandboxSiteAllowedHost).toBe("demo-ats");
    expect(loadConfig({ ...BASE, SANDBOX_SITE_ALLOWED_HOST: "   " }).sandboxSiteAllowedHost).toBe("demo-ats");
  });

  // Both submission gates default OFF: an environment that was never told
  // otherwise cannot mutate the outside world through either channel.
  it("defaults both submission gates to off", () => {
    expect(loadConfig(BASE).submissionsLiveEmail).toBe(false);
    expect(loadConfig(BASE).submissionsLiveCompanySite).toBe(false);
  });
  it("opens the company-site gate only for SUBMISSIONS_LIVE_COMPANY_SITE=true", () => {
    expect(loadConfig({ ...BASE, SUBMISSIONS_LIVE_COMPANY_SITE: "true" }).submissionsLiveCompanySite).toBe(true);
    expect(loadConfig({ ...BASE, SUBMISSIONS_LIVE_COMPANY_SITE: "false" }).submissionsLiveCompanySite).toBe(false);
  });

  // Auto-apply (spec §10): the Playwright driver's per-action budget and the
  // demo ATS it targets. Both are read by the worker in containers, where
  // Compose passes `${VAR:-}` for anything the user never set.
  it("defaults autoapplyBrowserTimeoutMs to 45s", () => {
    expect(loadConfig(BASE).autoapplyBrowserTimeoutMs).toBe(45_000);
  });
  it("takes an explicit AUTOAPPLY_BROWSER_TIMEOUT_MS", () => {
    expect(loadConfig({ ...BASE, AUTOAPPLY_BROWSER_TIMEOUT_MS: "12000" }).autoapplyBrowserTimeoutMs).toBe(12_000);
  });
  it("rejects a non-positive AUTOAPPLY_BROWSER_TIMEOUT_MS", () => {
    expect(() => loadConfig({ ...BASE, AUTOAPPLY_BROWSER_TIMEOUT_MS: "0" })).toThrow(/AUTOAPPLY_BROWSER_TIMEOUT_MS/);
    expect(() => loadConfig({ ...BASE, AUTOAPPLY_BROWSER_TIMEOUT_MS: "-1" })).toThrow(/AUTOAPPLY_BROWSER_TIMEOUT_MS/);
  });

  it("defaults demoAtsUrl to the compose demo-ats service", () => {
    expect(loadConfig(BASE).demoAtsUrl).toBe("http://demo-ats:3001");
  });
  it("takes an explicit DEMO_ATS_URL", () => {
    expect(loadConfig({ ...BASE, DEMO_ATS_URL: "http://localhost:3001" }).demoAtsUrl).toBe("http://localhost:3001");
  });
  // The driver joins paths onto this ("/greenhouse/jobs/eng-1"), so a trailing
  // slash would produce a double slash in every captured URL.
  it("strips trailing slashes from DEMO_ATS_URL", () => {
    expect(loadConfig({ ...BASE, DEMO_ATS_URL: "http://localhost:3001//" }).demoAtsUrl).toBe("http://localhost:3001");
  });
  it("treats an empty DEMO_ATS_URL as unset, like the other compose-passed vars", () => {
    expect(loadConfig({ ...BASE, DEMO_ATS_URL: "" }).demoAtsUrl).toBe("http://demo-ats:3001");
    expect(loadConfig({ ...BASE, DEMO_ATS_URL: "   " }).demoAtsUrl).toBe("http://demo-ats:3001");
  });
  it("rejects a DEMO_ATS_URL that isn't a URL, naming the var in prose", () => {
    expect(() => loadConfig({ ...BASE, DEMO_ATS_URL: "demo-ats:3001" })).toThrow(/DEMO_ATS_URL/);
  });
});
