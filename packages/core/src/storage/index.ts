import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * The demo's disk guards — ONE orphan collector, shared by every store the app
 * writes files into.
 *
 * The shape this generalises was proved by the CV-upload leak (commit
 * `4871794`): an anonymous request writes bytes to the host's filesystem, the
 * six-hourly demo reset cascades the *rows* away and leaves the *files*
 * behind, so the store grows monotonically forever and any ceiling put on it
 * becomes a one-way door. The fix is always the same two halves —
 *
 *   1. a ceiling (bytes AND file count), so a loop cannot fill the disk; and
 *   2. reclamation of every file no database row points at, so the ceiling is
 *      given back at the next reset instead of bricking the feature,
 *
 * — plus a grace window so a file whose row has not committed yet is never the
 * victim. Two subtly different implementations of that is how the next leak
 * happens, so {@link pruneAndMeasure} is the only one: `cv-storage.ts` in
 * apps/web and {@link reserveEvidenceScreenshot} below both call it, and so
 * must anything added later.
 *
 * Everything here is demo-scoped at the call site. A personal, self-hosted
 * install owns its own disk, and its stored files are records of real
 * applications — nothing below ever runs against one.
 */

/**
 * How long an unreferenced file is left alone before it counts as garbage.
 *
 * Every writer in this app lands the file before it commits the row that
 * points at it, so a live file is briefly unreferenced by construction. A
 * collector with no grace window would delete another request's in-flight
 * write in exactly that gap. Five minutes is orders of magnitude longer than
 * the widest such gap (a browser submit plus a receipt write) and far shorter
 * than the six-hourly reset, so reclamation still happens on the first
 * request after a reset.
 */
export const ORPHAN_GRACE_MS = 5 * 60_000;

export interface StoreUsage {
  files: number;
  bytes: number;
}

const NOTHING: StoreUsage = { files: 0, bytes: 0 };

function plus(total: StoreUsage, one: StoreUsage): StoreUsage {
  return { files: total.files + one.files, bytes: total.bytes + one.bytes };
}

/** Rounded MB, for refusal text a human reads. */
export function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * One `readdir` + `stat` pass per directory that both collects garbage and
 * measures what is left, across as many directories as the store spans.
 *
 * Deleting first is what keeps a ceiling from becoming a one-way door: the
 * reset drops the demo workspace and every row that referenced these files,
 * but not the files, so without this pass every past visitor's bytes would
 * count against the ceiling forever.
 *
 * `keep` is compared on `path.resolve`d paths at both ends. `fileStorageDir`
 * is always absolute (`@careerhq/config` resolves it), so this only normalises
 * separators and `.` segments — but the failure mode of a mismatch is deleting
 * a live file, which is worth being literal about.
 *
 * Every unlink is best-effort: losing the race to another process's pass, or
 * to an operator with `rm`, means the file is already gone — the outcome this
 * wanted anyway. That is also what makes the pass safe to run from the web and
 * the worker concurrently: both derive `keep` from the same database, both
 * skip anything inside the grace window, and a doubly-deleted orphan is still
 * just a deleted orphan.
 */
export async function pruneAndMeasure(
  dirs: readonly string[],
  keep: ReadonlySet<string>,
  now: number,
): Promise<StoreUsage> {
  const resolved = new Set([...keep].map((p) => path.resolve(p)));
  const perDir = await Promise.all(dirs.map((dir) => pruneOneDir(dir, resolved, now)));
  return perDir.reduce(plus, NOTHING);
}

async function pruneOneDir(dir: string, keep: ReadonlySet<string>, now: number): Promise<StoreUsage> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return NOTHING;
    throw err;
  }

  const measured = await Promise.all(names.map(async (name): Promise<StoreUsage> => {
    const filePath = path.resolve(dir, name);
    let info;
    try {
      info = await stat(filePath);
    } catch {
      return NOTHING;
    }
    if (!info.isFile()) return NOTHING;
    if (!keep.has(filePath) && now - info.mtimeMs > ORPHAN_GRACE_MS) {
      await unlink(filePath).catch(() => undefined);
      return NOTHING;
    }
    return { files: 1, bytes: info.size };
  }));

  return measured.reduce(plus, NOTHING);
}

// ---------------------------------------------------------------------------
// The evidence-screenshot store
// ---------------------------------------------------------------------------

/**
 * The disk ceiling for auto-apply evidence screenshots.
 *
 * Two processes write confirmation-page PNGs, both reachable from the hosted
 * demo's single throttled confirm action: `apps/web`'s `site-driver.ts` (into
 * `site-screenshots/`, one file per successful submission) and
 * `apps/worker`'s `jobs/autoapply.ts` (into `autoapply/`, one file per
 * attempt). Neither had a ceiling and neither was ever reclaimed — the same
 * unbounded, monotonic disk write as the CV-upload leak, an order of magnitude
 * smaller per call, on a VPS that shares its disk with the owner's production
 * services.
 *
 * They are ONE store with two directories, not two stores: the number that
 * matters is what the box's disk sees, and either writer can fill it.
 *
 * Module constants rather than environment variables, for the same reason the
 * CV ceilings are: they are one deployment's safety margin against the box it
 * runs on, not a per-operator preference, and the operator dial that already
 * exists (`DEMO_RATE_LIMIT_PER_MIN`, which governs `confirmAndSubmitSite`)
 * governs the rate. Changing a ceiling means editing the three numbers below,
 * all in one place. Nothing outside demo mode reads any of them.
 */

/** The two directories the store spans, relative to `FILE_STORAGE_DIR`. */
export const EVIDENCE_SCREENSHOT_DIRS = ["site-screenshots", "autoapply"] as const;

/**
 * Total bytes the demo's evidence screenshots may hold, across both
 * directories. 64 MB is the same budget the CV store gets (0.3% of the 23 GB
 * free on the box), which puts the demo's whole reclaimable file budget at a
 * round 128 MB. At the confirm action's 5/min throttle and a typical full-page
 * confirmation PNG, an abuse loop reaches this in roughly a quarter of an hour
 * and then stays flat forever instead of climbing.
 */
export const DEMO_MAX_EVIDENCE_STORE_BYTES = 64 * 1024 * 1024;

/**
 * And a file COUNT, because bytes alone bound neither the cost of the scan
 * above nor inodes: 64 MB of 8 KB PNGs is eight thousand files. 200 is far
 * more site submissions than a demo legitimately accumulates between
 * six-hourly resets — the seed makes one — while still leaving room for a
 * genuinely busy demo day.
 */
export const DEMO_MAX_EVIDENCE_STORE_FILES = 200;

/**
 * Headroom one reservation must find free.
 *
 * Unlike a CV upload, the size of a screenshot is not knowable before it is
 * taken — it does not exist until after the submit click, and refusing after
 * the click is not an option (the application is already in). So the check is
 * "is there room for a generous one?", made before anything is typed. 4 MB is
 * far above any confirmation page Playwright has produced here and keeps the
 * ceiling honest: the store cannot overshoot by more than one shot per
 * concurrent confirm, and concurrency is already capped at one browser.
 */
export const DEMO_MAX_EVIDENCE_SHOT_BYTES = 4 * 1024 * 1024;

/**
 * One refusal for both ceilings: which one was hit is not the visitor's
 * problem, and the honest instruction is that the demo reclaims it.
 */
export const EVIDENCE_STORE_FULL_REASON =
  `the demo's evidence-screenshot storage is full (${mb(DEMO_MAX_EVIDENCE_STORE_BYTES)} or `
  + `${DEMO_MAX_EVIDENCE_STORE_FILES} files) — it is reclaimed after the next demo reset, `
  + "so nothing was submitted and nothing was spent";

/** Absolute paths of the directories the evidence store spans. */
export function evidenceScreenshotDirs(fileStorageDir: string): string[] {
  return EVIDENCE_SCREENSHOT_DIRS.map((name) => path.join(fileStorageDir, name));
}

export interface EvidenceScreenshotRequest {
  /** `AppConfig.fileStorageDir` — always absolute. */
  fileStorageDir: string;
  /**
   * Every screenshot path the database still points at (`listEvidenceScreenshotPaths`).
   * Anything in the store that is not in here and is older than
   * {@link ORPHAN_GRACE_MS} is garbage. Read only in demo mode; pass an empty
   * list otherwise.
   */
  referencedPaths: Iterable<string>;
  demoMode: boolean;
  /** Injected in tests; defaults to `Date.now()`. */
  now?: number;
}

/**
 * Decides whether a submission that will produce one evidence screenshot may
 * proceed, and returns the reason it may not — never throws it.
 *
 * MUST be called before the submit click, and callers must treat a non-null
 * result as a refusal that leaves the attempt exactly as it was: the whole
 * point is that a full disk stops a submission from *starting*, because once
 * the click has landed the application is in and the only honest thing left to
 * do is store the evidence.
 *
 * Outside demo mode this is inert and touches no disk at all. A self-hoster's
 * evidence screenshots are the records of real applications they made; nothing
 * here deletes or refuses them.
 *
 * The measurement is a check, not a reservation — two confirms racing can both
 * see the same free space and overshoot by one screenshot each. Bounded by the
 * one-browser cap and the 5/min throttle, and the right trade against holding
 * a lock across a browser session.
 */
export async function reserveEvidenceScreenshot(
  request: EvidenceScreenshotRequest,
): Promise<string | null> {
  if (!request.demoMode) return null;

  const used = await pruneAndMeasure(
    evidenceScreenshotDirs(request.fileStorageDir),
    new Set(request.referencedPaths),
    request.now ?? Date.now(),
  );
  if (used.files >= DEMO_MAX_EVIDENCE_STORE_FILES) return EVIDENCE_STORE_FULL_REASON;
  if (used.bytes + DEMO_MAX_EVIDENCE_SHOT_BYTES > DEMO_MAX_EVIDENCE_STORE_BYTES) {
    return EVIDENCE_STORE_FULL_REASON;
  }
  return null;
}
