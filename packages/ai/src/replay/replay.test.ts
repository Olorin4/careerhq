import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FallbackResult } from "../client/fallback.js";
import { makeFsReplayStore, replayKey, withReplay, type ReplayStore } from "./index.js";

/** In-memory ReplayStore stub for fast, isolated unit tests. */
function makeMemoryStore(initial: Record<string, string> = {}): ReplayStore {
  const data = new Map(Object.entries(initial));
  return {
    read: async (key) => data.get(key) ?? null,
    write: async (key, value) => {
      data.set(key, value);
    },
  };
}

const prompt = { system: "you are a helper", user: "write me a cover letter" };

const okResult: FallbackResult<{ answer: string }> = {
  ok: true,
  value: { answer: "hi" },
  model: "some/model",
  latencyMs: 42,
  status: 200,
  error: null,
  attempts: [{ model: "some/model", error: null, status: 200 }],
};

const failResult: FallbackResult<{ answer: string }> = {
  ok: false,
  value: null,
  model: "some/model",
  latencyMs: 10,
  status: 500,
  error: "http_500",
  attempts: [{ model: "some/model", error: "http_500", status: 500 }],
};

describe("replayKey", () => {
  it("is stable for the same taskId and prompt", () => {
    expect(replayKey("gen-cover-letter", prompt)).toBe(replayKey("gen-cover-letter", prompt));
  });

  it("differs when the prompt differs", () => {
    const a = replayKey("gen-cover-letter", prompt);
    const b = replayKey("gen-cover-letter", { ...prompt, user: "something else" });
    expect(a).not.toBe(b);
  });

  it("differs when the taskId differs", () => {
    const a = replayKey("gen-cover-letter", prompt);
    const b = replayKey("gen-email", prompt);
    expect(a).not.toBe(b);
  });

  it("is of the form `${taskId}-${16 hex chars}`", () => {
    const key = replayKey("gen-cover-letter", prompt);
    expect(key).toMatch(/^gen-cover-letter-[0-9a-f]{16}$/);
  });
});

describe("withReplay", () => {
  describe("live mode", () => {
    it("calls run() and returns its result unchanged", async () => {
      const run = vi.fn().mockResolvedValue(okResult);
      const store = makeMemoryStore();
      const result = await withReplay({ mode: "live", store, taskId: "t", prompt, run });
      expect(run).toHaveBeenCalledTimes(1);
      expect(result).toEqual(okResult);
    });

    it("does not write to the store", async () => {
      const run = vi.fn().mockResolvedValue(okResult);
      const store = makeMemoryStore();
      const writeSpy = vi.spyOn(store, "write");
      await withReplay({ mode: "live", store, taskId: "t", prompt, run });
      expect(writeSpy).not.toHaveBeenCalled();
    });
  });

  describe("record mode", () => {
    it("calls run() and returns its result unchanged", async () => {
      const run = vi.fn().mockResolvedValue(okResult);
      const store = makeMemoryStore();
      const result = await withReplay({ mode: "record", store, taskId: "t", prompt, run });
      expect(run).toHaveBeenCalledTimes(1);
      expect(result).toEqual(okResult);
    });

    it("persists {value, model} under the replay key when run() succeeds", async () => {
      const run = vi.fn().mockResolvedValue(okResult);
      const store = makeMemoryStore();
      const writeSpy = vi.spyOn(store, "write");
      await withReplay({ mode: "record", store, taskId: "t", prompt, run });
      const key = replayKey("t", prompt);
      expect(writeSpy).toHaveBeenCalledWith(key, JSON.stringify({ value: okResult.value, model: okResult.model }));
    });

    it("does not persist anything when run() fails", async () => {
      const run = vi.fn().mockResolvedValue(failResult);
      const store = makeMemoryStore();
      const writeSpy = vi.spyOn(store, "write");
      const result = await withReplay({ mode: "record", store, taskId: "t", prompt, run });
      expect(result).toEqual(failResult);
      expect(writeSpy).not.toHaveBeenCalled();
    });
  });

  describe("replay mode", () => {
    it("never calls run()", async () => {
      const run = vi.fn().mockResolvedValue(okResult);
      const store = makeMemoryStore();
      await withReplay({ mode: "replay", store, taskId: "t", prompt, run });
      expect(run).not.toHaveBeenCalled();
    });

    it("returns the stored value with model prefixed by replay: on a hit", async () => {
      const key = replayKey("t", prompt);
      const store = makeMemoryStore({ [key]: JSON.stringify({ value: { answer: "hi" }, model: "some/model" }) });
      const run = vi.fn().mockResolvedValue(okResult);
      const result = await withReplay({ mode: "replay", store, taskId: "t", prompt, run });
      expect(result).toEqual({
        ok: true,
        value: { answer: "hi" },
        model: "replay:some/model",
        latencyMs: 0,
        status: null,
        error: null,
        attempts: [],
      });
      expect(run).not.toHaveBeenCalled();
    });

    it("returns replay_miss without throwing when the key is absent", async () => {
      const store = makeMemoryStore();
      const run = vi.fn().mockResolvedValue(okResult);
      const result = await withReplay({ mode: "replay", store, taskId: "t", prompt, run });
      expect(result.ok).toBe(false);
      expect(result.error).toBe("replay_miss");
      expect(result.latencyMs).toBe(0);
      expect(result.status).toBeNull();
      expect(result.attempts).toEqual([]);
      expect(run).not.toHaveBeenCalled();
    });
  });
});

describe("makeFsReplayStore", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "careerhq-replay-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null for a key that has never been written (ENOENT)", async () => {
    const store = makeFsReplayStore(dir);
    expect(await store.read("missing-key")).toBeNull();
  });

  it("writes then reads back the same value", async () => {
    const store = makeFsReplayStore(dir);
    await store.write("some-key", JSON.stringify({ value: { answer: "hi" }, model: "m" }));
    expect(await store.read("some-key")).toBe(JSON.stringify({ value: { answer: "hi" }, model: "m" }));
  });

  it("writes to `${key}.json` under the given directory", async () => {
    const store = makeFsReplayStore(dir);
    await store.write("some-key", "payload");
    const raw = await readFile(path.join(dir, "some-key.json"), "utf8");
    expect(raw).toBe("payload");
  });

  it("creates the directory recursively when it does not yet exist", async () => {
    const nested = path.join(dir, "nested", "deeper");
    const store = makeFsReplayStore(nested);
    await store.write("some-key", "payload");
    const raw = await readFile(path.join(nested, "some-key.json"), "utf8");
    expect(raw).toBe("payload");
  });

  it("returns null on any read error, not just ENOENT", async () => {
    // Point the store at a path that is a file, not a directory, so the read
    // fails with ENOTDIR rather than ENOENT.
    const filePath = path.join(dir, "not-a-dir");
    await (await import("node:fs/promises")).writeFile(filePath, "x");
    const store = makeFsReplayStore(filePath);
    expect(await store.read("some-key")).toBeNull();
  });
});
