import { mb, ORPHAN_GRACE_MS, pruneAndMeasure } from "@careerhq/core/storage";

/**
 * The orphan collector and the grace window are NOT defined here any more:
 * they live in `@careerhq/core/storage`, shared with the evidence-screenshot
 * store that `confirmAndSubmitSite` and the worker's submit job reserve
 * against. Two subtly different implementations of "delete what no row points
 * at, but never an in-flight write" is how the next leak happens. This module
 * is now only the CV store's numbers and its refusal.
 */
export { ORPHAN_GRACE_MS };

/**
 * The disk ceiling for CV uploads (spec P6 §3; P6 task-3 review advisory B,
 * restated as fixwave A5).
 *
 * `uploadCvAction` is the only path in the app that turns an anonymous request
 * into bytes on the host's filesystem, and the hosted demo has no login. The
 * rate limiter alone does not close this: it bounds how OFTEN a visitor may
 * upload, not how much they may accumulate, and at 5 uploads a minute a loop
 * still reaches gigabytes in a day on a VPS that shares its disk with the
 * owner's other production services. So demo mode gets a hard ceiling as well
 * as a rate — a number the store can never exceed no matter how long the loop
 * runs.
 *
 * These are module constants rather than environment variables on purpose:
 * they are one deployment's safety margin, not a per-operator setting, and the
 * operator dial that already exists (`DEMO_RATE_LIMIT_PER_MIN`) governs the
 * rate. Changing a ceiling means editing the four numbers below, all in one
 * place. Nothing outside demo mode reads any of them except {@link MAX_CV_BYTES}.
 */

/** Per-file hard cap, demo or not. Unchanged from the original action. */
export const MAX_CV_BYTES = 5 * 1024 * 1024;

/**
 * Per-file cap in demo mode. A real CV PDF is well under 1 MB — 2 MB is
 * generous for the demo's purpose and cuts the worst-case write per allowed
 * call to 2 MB, so the throttle's 5/min is at most 10 MB a minute.
 */
export const DEMO_MAX_CV_BYTES = 2 * 1024 * 1024;

/**
 * Total bytes the demo's `cvs/` directory may hold. 64 MB is 0.3% of the
 * 23 GB free on the box: large enough that a visitor can upload their own CV
 * and see it work, small enough that filling it costs the host nothing.
 */
export const DEMO_MAX_CV_STORE_BYTES = 64 * 1024 * 1024;

/**
 * And a file COUNT, because bytes alone do not bound the cost of the
 * collector's scan (or of inodes): 64 MB of 4 KB PDFs is sixteen thousand
 * files. A
 * hundred is far more CVs than a demo ever legitimately holds.
 */
export const DEMO_MAX_CV_STORE_FILES = 100;

/** One refusal for both ceilings: which one the visitor hit is not their problem. */
const STORE_FULL_REASON =
  `the demo's CV storage is full (${mb(DEMO_MAX_CV_STORE_BYTES)} or `
  + `${DEMO_MAX_CV_STORE_FILES} files) — it is reclaimed after the next demo reset`;

export interface CvUploadRequest {
  /** The `cvs/` directory the file would be written into. */
  dir: string;
  /** `File.size` — checked before the bytes are ever pulled into memory. */
  incomingBytes: number;
  /**
   * Every `cv_variants.file_path` the database knows about. Anything in `dir`
   * that is not in here and is older than {@link ORPHAN_GRACE_MS} is garbage.
   * Read only in demo mode; pass an empty list otherwise.
   */
  referencedPaths: Iterable<string>;
  demoMode: boolean;
  /** Injected in tests; defaults to `Date.now()`. */
  now?: number;
}

/**
 * Decides whether one upload may proceed, and returns the reason it may not —
 * never throws it. The caller reports it in the form, the same way every other
 * demo refusal in this app is reported.
 *
 * Outside demo mode only the 5 MB per-file cap applies: a personal,
 * self-hosted install owns its own disk and is never quota'd.
 *
 * The measurement is a check, not a reservation — two uploads racing can both
 * observe the same free space and overshoot by one file each. That is bounded
 * by the throttle (at most a handful of 2 MB files) and is the right trade
 * against holding a lock across a disk write.
 */
export async function reserveCvUpload(request: CvUploadRequest): Promise<string | null> {
  if (request.incomingBytes > MAX_CV_BYTES) return `PDF exceeds the ${mb(MAX_CV_BYTES)} limit`;
  if (!request.demoMode) return null;
  if (request.incomingBytes > DEMO_MAX_CV_BYTES) {
    return `the hosted demo accepts PDFs up to ${mb(DEMO_MAX_CV_BYTES)}`;
  }

  const used = await pruneAndMeasure(
    [request.dir],
    new Set(request.referencedPaths),
    request.now ?? Date.now(),
  );
  if (used.files >= DEMO_MAX_CV_STORE_FILES) return STORE_FULL_REASON;
  if (used.bytes + request.incomingBytes > DEMO_MAX_CV_STORE_BYTES) return STORE_FULL_REASON;
  return null;
}
