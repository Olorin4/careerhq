import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_MAX_CV_BYTES, DEMO_MAX_CV_STORE_BYTES, DEMO_MAX_CV_STORE_FILES,
  cvSizeLimit, MAX_CV_BYTES, ORPHAN_GRACE_MS, reserveCvUpload,
} from "./cv-storage.js";

let dir: string;

beforeEach(async () => {
  dir = path.join(await mkdtemp(path.join(tmpdir(), "careerhq-cv-store-")), "cvs");
});

afterEach(async () => {
  await rm(path.dirname(dir), { recursive: true, force: true });
});

const NOW = 1_000_000_000_000;

/** Writes `bytes` bytes at `name`, aged `ageMs` in the past. */
async function seedFile(name: string, bytes: number, ageMs: number): Promise<string> {
  const filePath = path.join(dir, name);
  await writeFile(filePath, Buffer.alloc(bytes));
  const seconds = (NOW - ageMs) / 1000;
  await utimes(filePath, seconds, seconds);
  return filePath;
}

async function mkStore(): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * The browser-side half of the CV cap (P6 final review, BLOCKING 2). The upload
 * form checks `file.size` before it submits, because above the framework's
 * server-action body limit Next answers 413 before `uploadCvAction` runs and the
 * visitor gets the "Application error" overlay instead of a sentence. The form
 * cannot import this module (it reads the filesystem), so it is handed
 * `cvSizeLimit`'s two fields — and they have to be the cap and the wording the
 * server would use, or the two halves disagree about what is allowed.
 */
describe("cvSizeLimit is the cap reserveCvUpload enforces", () => {
  for (const demoMode of [false, true]) {
    it(`refuses one byte over its own cap, with its own words (demoMode: ${demoMode})`, async () => {
      const limit = cvSizeLimit(demoMode);
      expect(await reserveCvUpload({
        dir, incomingBytes: limit.maxBytes, referencedPaths: [], demoMode, now: NOW,
      })).toBeNull();
      expect(await reserveCvUpload({
        dir, incomingBytes: limit.maxBytes + 1, referencedPaths: [], demoMode, now: NOW,
      })).toBe(limit.reason);
    });
  }

  it("is the tighter demo cap in demo mode, and the global one otherwise", () => {
    expect(cvSizeLimit(true).maxBytes).toBe(DEMO_MAX_CV_BYTES);
    expect(cvSizeLimit(false).maxBytes).toBe(MAX_CV_BYTES);
  });
});

describe("reserveCvUpload outside demo mode", () => {
  it("allows anything under the 5 MB per-file cap and never reads the store", async () => {
    const refusal = await reserveCvUpload({
      dir: "/nonexistent/does/not/matter",
      incomingBytes: MAX_CV_BYTES,
      referencedPaths: [],
      demoMode: false,
      now: NOW,
    });
    expect(refusal).toBeNull();
  });

  it("still refuses a file over the 5 MB cap", async () => {
    const refusal = await reserveCvUpload({
      dir,
      incomingBytes: MAX_CV_BYTES + 1,
      referencedPaths: [],
      demoMode: false,
      now: NOW,
    });
    expect(refusal).toMatch(/exceeds the 5 MB limit/);
  });

  it("does not apply the demo per-file cap — a self-hoster's own disk is not quota'd", async () => {
    const refusal = await reserveCvUpload({
      dir, incomingBytes: DEMO_MAX_CV_BYTES + 1, referencedPaths: [], demoMode: false, now: NOW,
    });
    expect(refusal).toBeNull();
  });
});

describe("reserveCvUpload in demo mode", () => {
  it("accepts an ordinary CV into an empty store", async () => {
    const refusal = await reserveCvUpload({
      dir, incomingBytes: 200_000, referencedPaths: [], demoMode: true, now: NOW,
    });
    expect(refusal).toBeNull();
  });

  it("refuses a file over the tighter demo per-file cap", async () => {
    const refusal = await reserveCvUpload({
      dir, incomingBytes: DEMO_MAX_CV_BYTES + 1, referencedPaths: [], demoMode: true, now: NOW,
    });
    expect(refusal).toMatch(/accepts PDFs up to 2 MB/);
  });

  it("refuses once the stored bytes plus the incoming file would pass the ceiling", async () => {
    await mkStore();
    // Two live files that between them leave less than 1 MB of headroom.
    const a = await seedFile("a.pdf", DEMO_MAX_CV_STORE_BYTES / 2, 0);
    const b = await seedFile("b.pdf", DEMO_MAX_CV_STORE_BYTES / 2 - 512 * 1024, 0);

    const fits = await reserveCvUpload({
      dir, incomingBytes: 400 * 1024, referencedPaths: [a, b], demoMode: true, now: NOW,
    });
    expect(fits).toBeNull();

    const refusal = await reserveCvUpload({
      dir, incomingBytes: 600 * 1024, referencedPaths: [a, b], demoMode: true, now: NOW,
    });
    expect(refusal).toMatch(/storage is full/);
  });

  it("refuses on the file count even when the bytes are trivial", async () => {
    await mkStore();
    const kept: string[] = [];
    for (let i = 0; i < DEMO_MAX_CV_STORE_FILES; i += 1) {
      kept.push(await seedFile(`tiny-${i}.pdf`, 16, 0));
    }
    const refusal = await reserveCvUpload({
      dir, incomingBytes: 16, referencedPaths: kept, demoMode: true, now: NOW,
    });
    expect(refusal).toMatch(/storage is full/);
  });

  it("reclaims unreferenced files past the grace window, so a reset reopens the store", async () => {
    await mkStore();
    // What the six-hourly reset leaves behind: the PDFs are still on disk, but
    // the workspace and every cv_variants row pointing at them are gone.
    for (let i = 0; i < DEMO_MAX_CV_STORE_FILES; i += 1) {
      await seedFile(`orphan-${i}.pdf`, 64 * 1024, ORPHAN_GRACE_MS + 1000);
    }
    const live = await seedFile("seeded.pdf", 1024, ORPHAN_GRACE_MS + 1000);

    const refusal = await reserveCvUpload({
      dir, incomingBytes: 200_000, referencedPaths: [live], demoMode: true, now: NOW,
    });
    expect(refusal).toBeNull();
    expect(await readdir(dir)).toEqual(["seeded.pdf"]);
  });

  it("leaves a just-written unreferenced file alone — its row may still be committing", async () => {
    await mkStore();
    await seedFile("in-flight.pdf", 1024, ORPHAN_GRACE_MS - 1000);

    await reserveCvUpload({ dir, incomingBytes: 1024, referencedPaths: [], demoMode: true, now: NOW });
    expect(await readdir(dir)).toContain("in-flight.pdf");
  });

  it("never deletes a referenced file however old it is", async () => {
    await mkStore();
    const live = await seedFile("live.pdf", 1024, 30 * 24 * 60 * 60 * 1000);

    await reserveCvUpload({ dir, incomingBytes: 1024, referencedPaths: [live], demoMode: true, now: NOW });
    expect(await readdir(dir)).toEqual(["live.pdf"]);
  });

  it("treats a store directory that does not exist yet as empty", async () => {
    const refusal = await reserveCvUpload({
      dir: path.join(dir, "not-created-yet"),
      incomingBytes: 1024,
      referencedPaths: [],
      demoMode: true,
      now: NOW,
    });
    expect(refusal).toBeNull();
  });
});
