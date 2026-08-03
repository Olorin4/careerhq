import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import type { AiMode } from "@careerhq/contracts";
import type { FallbackResult } from "../client/fallback.js";

/**
 * Persistence for recorded AI calls, keyed by `replayKey`. The default
 * implementation is filesystem-backed (see `makeFsReplayStore`); tests inject
 * an in-memory stub instead.
 */
export interface ReplayStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}

/**
 * Filesystem-backed `ReplayStore` rooted at `dir`. Each key is stored as
 * `${dir}/${key}.json`. `write` creates `dir` (and any missing parents) on
 * demand so callers never need to provision the fixtures directory up front.
 * `read` treats every failure — missing file, missing directory, a `dir` that
 * is actually a file, permission errors — as a cache miss (`null`) rather
 * than surfacing the underlying error, since a corrupt or absent fixture
 * should fall through to `replay_miss`, not crash the caller.
 */
export function makeFsReplayStore(dir: string): ReplayStore {
  const filePath = (key: string): string => path.join(dir, `${key}.json`);
  return {
    async read(key) {
      try {
        return await readFile(filePath(key), "utf8");
      } catch {
        return null;
      }
    },
    async write(key, value) {
      await mkdir(dir, { recursive: true });
      await writeFile(filePath(key), value, "utf8");
    },
  };
}

/**
 * Deterministic cache key for a prompt under a given task: the task id plus
 * the first 16 hex characters of the sha256 of `system + "\n" + user`. Stable
 * across runs for the same prompt, distinct across tasks and across prompt
 * variations, so recordings can be replayed byte-for-byte in CI/dev without a
 * live API key.
 */
export function replayKey(taskId: string, prompt: { system: string; user: string }): string {
  const hash = createHash("sha256")
    .update(`${prompt.system}\n${prompt.user}`)
    .digest("hex")
    .slice(0, 16);
  return `${taskId}-${hash}`;
}

/** Shape persisted to the store on a successful `record` run. */
interface RecordedCall<T> {
  value: T;
  model: string;
}

/** The failure result returned for both a store miss and a corrupt/malformed fixture. */
function replayMiss<T>(): FallbackResult<T> {
  return {
    ok: false,
    value: null,
    model: "",
    latencyMs: 0,
    status: null,
    error: "replay_miss",
    attempts: [],
  };
}

/**
 * Parses and shape-checks a stored fixture. A fixture is only ever written by
 * this module (see the `record` branch below), but the file on disk can
 * still be hand-edited, truncated, or left over from an incompatible format,
 * so this never trusts it blindly: invalid JSON or a missing/wrong-typed
 * `value`/`model` is treated as absent (`null`), collapsing to the same
 * `replay_miss` outcome as a file that was never written — never a thrown
 * exception out of `withReplay`.
 */
function parseRecordedCall<T>(raw: string): RecordedCall<T> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (!("value" in candidate) || typeof candidate.model !== "string") return null;
  return { value: candidate.value as T, model: candidate.model };
}

/**
 * Wraps an AI call with record/replay semantics driven by `mode`:
 * - `live`: runs `run()` and returns its result untouched.
 * - `record`: runs `run()` and, only when it succeeds, persists
 *   `{value, model}` under `replayKey(taskId, prompt)` for later replay.
 *   Failures pass through without being recorded. Persistence is
 *   best-effort: a `store.write` failure is caught and logged, and the good
 *   `run()` result is still returned rather than being discarded.
 * - `replay`: never calls `run()`. A stored hit is returned as an ok result
 *   with `model` prefixed `"replay:"` and zeroed-out timing/attempt fields
 *   (a replay isn't a live call, so those fields have no truthful value). A
 *   miss — or a fixture that exists but is corrupt (invalid JSON, or valid
 *   JSON missing `value`/a string `model`) — returns `error: "replay_miss"`
 *   rather than throwing, so a missing or malformed fixture degrades to a
 *   normal failure result instead of crashing whatever is running the
 *   replay suite. When `schema` is given, a hit whose `value` fails
 *   `schema.safeParse` is treated exactly the same way — a fixture recorded
 *   under an older/incompatible shape must never reach the caller as if it
 *   were a good result.
 */
export async function withReplay<T>(args: {
  mode: AiMode;
  store: ReplayStore;
  taskId: string;
  prompt: { system: string; user: string };
  run: () => Promise<FallbackResult<T>>;
  /**
   * Validated against a replay hit's `value`; a mismatch degrades to
   * `replay_miss`. The input type param is widened to `unknown` (matching
   * `chat-json.ts`'s `validateJson`): schemas with defaults (e.g.
   * `generationResultSchema`'s `.default([])` fields) have an input type
   * narrower than their output `T`, and this guard only ever runs
   * `safeParse` on an already-parsed `unknown` value, never `parse`-as-input,
   * so that contravariant slot carries no real type safety to preserve.
   */
  schema?: z.ZodType<T, z.ZodTypeDef, unknown>;
}): Promise<FallbackResult<T>> {
  const { mode, store, taskId, prompt, run, schema } = args;

  if (mode === "live") {
    return run();
  }

  if (mode === "record") {
    const result = await run();
    if (result.ok) {
      const key = replayKey(taskId, prompt);
      try {
        await store.write(key, JSON.stringify({ value: result.value, model: result.model }));
      } catch (error) {
        // Persistence is best-effort: a good result must still reach the
        // caller even if the fixture couldn't be written (e.g. read-only
        // disk, permissions). Losing the recording just means the next
        // replay run will miss for this key, not that this call failed.
        console.warn(`withReplay: failed to persist recording for key "${key}":`, error);
      }
    }
    return result;
  }

  // mode === "replay": run() must never be called.
  const key = replayKey(taskId, prompt);
  const raw = await store.read(key);
  if (raw === null) {
    return replayMiss<T>();
  }

  const recorded = parseRecordedCall<T>(raw);
  if (recorded === null) {
    return replayMiss<T>();
  }

  if (schema && !schema.safeParse(recorded.value).success) {
    return replayMiss<T>();
  }

  return {
    ok: true,
    value: recorded.value,
    model: `replay:${recorded.model}`,
    latencyMs: 0,
    status: null,
    error: null,
    attempts: [],
  };
}
