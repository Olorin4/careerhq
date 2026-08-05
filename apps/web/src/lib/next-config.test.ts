import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config.js";
import { DEMO_MAX_CV_BYTES, MAX_CV_BYTES } from "./cv-storage.js";

/**
 * The composition seam the CV-cap tests cannot see (P6 t6 review, B1/B2).
 *
 * `actions.test.ts` calls `uploadCvAction(...)` directly, so it asserts
 * behaviour that a deployed request never reaches: Next rejects a server-action
 * body over `experimental.serverActions.bodySizeLimit` with an HTTP 413 raised
 * BEFORE the action function runs. With that field unset the default is 1 MB,
 * which is below both CV caps — so both were dead code, SECURITY.md published a
 * bound nobody enforced, and a routine 1.5 MB CV replaced the page with
 * "Application error: a server-side exception has occurred".
 *
 * A real HTTP assertion needs a real `next build` + `next start` and is done as
 * a live probe (see the t6 fix report). What belongs in the gate is the
 * invariant that makes the live behaviour possible: the framework's bound is
 * the OUTER one. Raise a cap without raising this and this test says so.
 */
describe("the server-action body limit leaves room for the app's own CV caps", () => {
  /** `"6mb"` → bytes. Mirrors the suffixes Next's `bytes` parser accepts. */
  function toBytes(limit: string | number): number {
    if (typeof limit === "number") return limit;
    const match = /^\s*([\d.]+)\s*(b|kb|mb|gb)?\s*$/i.exec(limit);
    if (!match) throw new Error(`unparseable bodySizeLimit: ${limit}`);
    const scale = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(match[2] ?? "b").toLowerCase()] ?? 1;
    return Number(match[1]) * scale;
  }

  const limit = nextConfig.experimental?.serverActions?.bodySizeLimit;

  it("is configured at all — the unset default of 1 MB is below both caps", () => {
    expect(limit).toBeDefined();
  });

  it("sits above the 5 MB per-file cap, with room for multipart overhead", () => {
    // A multipart body carries boundaries, the other form fields and base64-free
    // but still non-zero framing; 512 KB of headroom is generous for three
    // short text fields and one file part.
    expect(toBytes(limit!)).toBeGreaterThanOrEqual(MAX_CV_BYTES + 512 * 1024);
  });

  it("keeps the demo cap the first bound a visitor meets, not the framework's", () => {
    expect(DEMO_MAX_CV_BYTES).toBeLessThan(MAX_CV_BYTES);
    expect(MAX_CV_BYTES).toBeLessThan(toBytes(limit!));
  });

  /**
   * The other end of the same seam (P6 final review, BLOCKING 2). The hosted
   * demo sits behind the box's shared nginx, and its vhost carried
   * `client_max_body_size 8m` against this file's 6 MB — so every upload
   * between the two was forwarded by nginx and then 413'd by Next BEFORE
   * `uploadCvAction` ran, which the app cannot phrase and the visitor sees as
   * the "Application error" overlay. A 7 MB scanned CV was enough.
   *
   * The vhost is committed in this repo (infra/edge/), so the agreement is
   * checkable here rather than only on the box.
   */
  it("is not smaller than the edge vhost's client_max_body_size", () => {
    const vhost = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../infra/edge/careerhq.nickkalas.dev.conf",
    );
    const directive = /^\s*client_max_body_size\s+(\S+?);/m.exec(readFileSync(vhost, "utf8"));
    expect(directive).not.toBeNull();

    // nginx's size suffixes are `k`/`m`/`g` (or none), not Next's `kb`/`mb`.
    const size = /^(\d+)([kmg]?)$/i.exec(directive![1]!);
    expect(size).not.toBeNull();
    const scale = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[size![2]!.toLowerCase()]!;
    expect(Number(size![1]) * scale).toBeLessThanOrEqual(toBytes(limit!));
  });
});
