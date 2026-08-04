import { mkdir, mkdtemp, readdir, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEMO_MAX_EVIDENCE_SHOT_BYTES, DEMO_MAX_EVIDENCE_STORE_BYTES, DEMO_MAX_EVIDENCE_STORE_FILES,
  EVIDENCE_SCREENSHOT_DIRS, evidenceScreenshotDirs, ORPHAN_GRACE_MS, pruneAndMeasure,
  reserveEvidenceScreenshot,
} from "./index.js";

/** Stands in for `AppConfig.fileStorageDir`. */
let fileStorageDir: string;

const [WEB_DIR, WORKER_DIR] = EVIDENCE_SCREENSHOT_DIRS;

beforeEach(async () => {
  fileStorageDir = await mkdtemp(path.join(tmpdir(), "careerhq-evidence-store-"));
});

afterEach(async () => {
  await rm(fileStorageDir, { recursive: true, force: true });
});

const NOW = 1_000_000_000_000;

/**
 * A file of `bytes` in one of the store's directories, aged `ageMs` into the
 * past. Sparse (`truncate`), because these tests deal in tens of megabytes and
 * only `stat().size` is ever read.
 */
async function seedShot(dir: string, name: string, bytes: number, ageMs: number): Promise<string> {
  const dirPath = path.join(fileStorageDir, dir);
  await mkdir(dirPath, { recursive: true });
  const filePath = path.join(dirPath, name);
  await writeFile(filePath, "");
  if (bytes > 0) await truncate(filePath, bytes);
  const seconds = (NOW - ageMs) / 1000;
  await utimes(filePath, seconds, seconds);
  return filePath;
}

async function listShots(dir: string): Promise<string[]> {
  return (await readdir(path.join(fileStorageDir, dir))).sort();
}

function reserve(over: { referencedPaths?: string[]; demoMode?: boolean } = {}) {
  return reserveEvidenceScreenshot({
    fileStorageDir,
    referencedPaths: over.referencedPaths ?? [],
    demoMode: over.demoMode ?? true,
    now: NOW,
  });
}

describe("evidenceScreenshotDirs", () => {
  it("names both writers' directories — one store, two processes", () => {
    expect(evidenceScreenshotDirs("/app/var/files")).toEqual([
      "/app/var/files/site-screenshots",
      "/app/var/files/autoapply",
    ]);
  });
});

describe("reserveEvidenceScreenshot outside demo mode", () => {
  it("allows a submission and never touches the disk at all", async () => {
    const refusal = await reserveEvidenceScreenshot({
      fileStorageDir: "/nonexistent/does/not/matter",
      referencedPaths: [],
      demoMode: false,
      now: NOW,
    });
    expect(refusal).toBeNull();
  });

  // The requirement that makes this more than a flag check: a self-hoster's
  // evidence screenshots are the records of applications they really made. A
  // store far over the demo's ceiling, full of files no row points at because
  // this install simply never wrote those rows, must be left exactly as it is.
  it("neither refuses nor deletes when the store is over every demo bound", async () => {
    for (let i = 0; i < DEMO_MAX_EVIDENCE_STORE_FILES + 10; i += 1) {
      await seedShot(WEB_DIR, `real-${i}.png`, 1024, 30 * 24 * 60 * 60 * 1000);
    }
    await seedShot(WORKER_DIR, "huge.png", DEMO_MAX_EVIDENCE_STORE_BYTES, 30 * 24 * 60 * 60 * 1000);

    const refusal = await reserve({ demoMode: false });

    expect(refusal).toBeNull();
    expect(await listShots(WEB_DIR)).toHaveLength(DEMO_MAX_EVIDENCE_STORE_FILES + 10);
    expect(await listShots(WORKER_DIR)).toEqual(["huge.png"]);
  });
});

describe("reserveEvidenceScreenshot in demo mode", () => {
  it("allows a submission into an empty store, and into one that does not exist yet", async () => {
    expect(await reserve()).toBeNull();
    await seedShot(WEB_DIR, "one.png", 200_000, 0);
    expect(await reserve({ referencedPaths: [path.join(fileStorageDir, WEB_DIR, "one.png")] })).toBeNull();
  });

  // The two directories are ONE store: the byte that matters is the one the
  // box's disk sees, and either writer can fill it. Neither directory alone is
  // over the ceiling here.
  it("refuses on total bytes summed across BOTH writers' directories", async () => {
    const half = DEMO_MAX_EVIDENCE_STORE_BYTES / 2;
    const live = [
      await seedShot(WEB_DIR, "web.png", half - DEMO_MAX_EVIDENCE_SHOT_BYTES, 0),
      await seedShot(WORKER_DIR, "worker.png", half - DEMO_MAX_EVIDENCE_SHOT_BYTES, 0),
    ];
    // 8 MB of headroom left, and a shot needs 4 MB: still room.
    expect(await reserve({ referencedPaths: live })).toBeNull();

    live.push(await seedShot(WEB_DIR, "web-2.png", 5 * 1024 * 1024, 0));
    const refusal = await reserve({ referencedPaths: live });
    expect(refusal).toMatch(/evidence-screenshot storage is full/);
    expect(refusal).toMatch(/reclaimed after the next demo reset/);
    // The refusal must not imply anything was spent — it lands pre-click.
    expect(refusal).toMatch(/nothing was submitted/);
  });

  it("refuses on the file count even when the bytes are trivial", async () => {
    const live: string[] = [];
    for (let i = 0; i < DEMO_MAX_EVIDENCE_STORE_FILES - 1; i += 1) {
      live.push(await seedShot(i % 2 === 0 ? WEB_DIR : WORKER_DIR, `tiny-${i}.png`, 16, 0));
    }
    expect(await reserve({ referencedPaths: live })).toBeNull();

    live.push(await seedShot(WEB_DIR, "tiny-last.png", 16, 0));
    expect(await reserve({ referencedPaths: live })).toMatch(/storage is full/);
  });

  // The property the whole change exists for: without reclamation the ceiling
  // is a one-way door. The six-hourly reset drops the workspace and cascades
  // every attempt and snapshot away, leaving the PNGs behind — so after a
  // reset every past visitor's screenshot is unreferenced, and the first
  // confirm reclaims all of it.
  it("reclaims what the reset orphaned, in both directories, and reopens a store that was full", async () => {
    const all: string[] = [];
    for (let i = 0; i < DEMO_MAX_EVIDENCE_STORE_FILES; i += 1) {
      all.push(await seedShot(
        i % 2 === 0 ? WEB_DIR : WORKER_DIR, `shot-${i}.png`, 512 * 1024, ORPHAN_GRACE_MS + 1000,
      ));
    }
    const seeded = await seedShot(WEB_DIR, "demo-seed-confirmation.png", 1024, ORPHAN_GRACE_MS + 1000);

    // While every row still points at them the store is genuinely full and the
    // demo refuses: 100 MB over a 64 MB ceiling, and one file over the count.
    // The ceiling is real, and nothing live is ever deleted to make room.
    expect(await reserve({ referencedPaths: [...all, seeded] })).toMatch(/storage is full/);
    expect(await listShots(WEB_DIR)).toHaveLength(DEMO_MAX_EVIDENCE_STORE_FILES / 2 + 1);
    expect(await listShots(WORKER_DIR)).toHaveLength(DEMO_MAX_EVIDENCE_STORE_FILES / 2);

    // Then the reset drops the demo workspace and cascades every attempt and
    // form snapshot away. The PNGs are still on disk and nothing points at
    // them but the freshly seeded receipt. The next confirm reclaims the lot,
    // and the store — which without this would have been bricked forever —
    // reopens.
    expect(await reserve({ referencedPaths: [seeded] })).toBeNull();
    expect(await listShots(WEB_DIR)).toEqual(["demo-seed-confirmation.png"]);
    expect(await listShots(WORKER_DIR)).toEqual([]);
  });

  it("keeps the seeded screenshot the demo's own receipt still points at", async () => {
    const seeded = await seedShot(WEB_DIR, "demo-seed-confirmation.png", 1024, ORPHAN_GRACE_MS + 1000);
    await seedShot(WEB_DIR, "garbage.png", 1024, ORPHAN_GRACE_MS + 1000);

    expect(await reserve({ referencedPaths: [seeded] })).toBeNull();
    expect(await listShots(WEB_DIR)).toEqual(["demo-seed-confirmation.png"]);
  });

  // The grace window's whole job. Both writers land the PNG before the row
  // that points at it commits — apps/web writes then `completeSubmission`s,
  // the worker writes then `updateRecoveryState`s — so a file that no row
  // names yet is the normal state of a legitimate in-flight submission, not
  // garbage. Deleting it would destroy the evidence of a real application
  // while the browser that produced it is still finishing.
  it("never deletes a legitimate in-flight write whose row has not committed", async () => {
    const inFlightWeb = await seedShot(WEB_DIR, "in-flight.png", 1024, ORPHAN_GRACE_MS - 1000);
    const inFlightWorker = await seedShot(WORKER_DIR, "in-flight.png", 1024, ORPHAN_GRACE_MS - 1000);
    await seedShot(WEB_DIR, "genuine-orphan.png", 1024, ORPHAN_GRACE_MS + 1000);

    // The other process's pass, with a live set that knows nothing of either.
    await reserve({ referencedPaths: [] });

    expect(await listShots(WEB_DIR)).toEqual(["in-flight.png"]);
    expect(await listShots(WORKER_DIR)).toEqual(["in-flight.png"]);
    expect(inFlightWeb).toBeTruthy();
    expect(inFlightWorker).toBeTruthy();
  });

  it("never deletes a referenced file however old it is", async () => {
    const live = await seedShot(WORKER_DIR, "ancient.png", 1024, 365 * 24 * 60 * 60 * 1000);
    await reserve({ referencedPaths: [live] });
    expect(await listShots(WORKER_DIR)).toEqual(["ancient.png"]);
  });

  // Both processes run this collector against the same disk. Interleaved
  // passes must not turn into a deletion of anything live: every unlink is
  // best-effort, so losing the race means the orphan was already gone.
  it("is safe to run concurrently from two processes", async () => {
    const live = await seedShot(WEB_DIR, "live.png", 1024, ORPHAN_GRACE_MS + 1000);
    for (let i = 0; i < 20; i += 1) {
      await seedShot(WORKER_DIR, `orphan-${i}.png`, 1024, ORPHAN_GRACE_MS + 1000);
    }

    const both = await Promise.all([
      reserve({ referencedPaths: [live] }),
      reserve({ referencedPaths: [live] }),
    ]);

    expect(both).toEqual([null, null]);
    expect(await listShots(WEB_DIR)).toEqual(["live.png"]);
    expect(await listShots(WORKER_DIR)).toEqual([]);
  });
});

describe("pruneAndMeasure", () => {
  it("reads a directory that does not exist as empty rather than throwing", async () => {
    const used = await pruneAndMeasure(
      [path.join(fileStorageDir, "never-created")],
      new Set<string>(),
      NOW,
    );
    expect(used).toEqual({ files: 0, bytes: 0 });
  });

  // A live set that failed to match a stored file would DELETE it, so the
  // comparison is on resolved paths at both ends rather than raw strings.
  it("matches the live set on resolved paths, not raw strings", async () => {
    const live = await seedShot(WEB_DIR, "live.png", 4096, ORPHAN_GRACE_MS + 1000);
    const awkward = path.join(fileStorageDir, WEB_DIR, ".", "..", WEB_DIR, "live.png");

    const used = await pruneAndMeasure(
      [path.join(fileStorageDir, WEB_DIR)],
      new Set([awkward]),
      NOW,
    );

    expect(used).toEqual({ files: 1, bytes: 4096 });
    expect(await listShots(WEB_DIR)).toEqual(["live.png"]);
    expect(live).toBeTruthy();
  });

  it("ignores subdirectories rather than counting or deleting them", async () => {
    await mkdir(path.join(fileStorageDir, WEB_DIR, "nested"), { recursive: true });
    const used = await pruneAndMeasure([path.join(fileStorageDir, WEB_DIR)], new Set<string>(), NOW);
    expect(used).toEqual({ files: 0, bytes: 0 });
    expect(await listShots(WEB_DIR)).toEqual(["nested"]);
  });
});
