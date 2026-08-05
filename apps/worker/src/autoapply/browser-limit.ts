/**
 * How many headless Chromium instances this process may have open at once —
 * one, by default and by design (spec P6 §3, "Chromium runs one at a time,
 * globally").
 *
 * The hosted demo shares a 3.7 GB VPS with the owner's other production
 * services. A Chromium launch is the single most expensive thing CareerHQ does;
 * two or three concurrent visitors clicking "prepare" would not merely be slow,
 * they would take a neighbour's container down with the OOM killer. The rate
 * limiter (apps/web/src/lib/rate-limit.ts) bounds how OFTEN a browser may be
 * asked for; this bounds how many exist at the same instant, which is the
 * number the RAM budget is actually about.
 *
 * It does NOT queue. A refused acquirer gets `BrowserBusyError` immediately, so
 * a visitor sees an honest "the browser is busy, try again in a moment" rather
 * than a server action that hangs until some timeout expires — and, in the
 * confirm path, so the refusal happens while the confirmation token is still
 * unburned (apps/web/src/lib/site-submission.ts).
 *
 * The counter hangs off `globalThis` behind a registered symbol, NOT off a
 * module-level `let`. That distinction is the whole point, and it was learned
 * the expensive way in P6 task-3: Next.js emits a separate server bundle per
 * route entry, each with its own copy of every module it reaches, so a
 * module-level counter here would be per BUNDLE, not per process — and
 * `apps/web` is a consumer (`src/lib/site-driver.ts` drives the browser
 * in-process from server actions). Two bundles, two counters, and "one Chromium
 * at a time" is a lie. `Symbol.for` resolves through the cross-realm global
 * registry, so every bundle in the process reaches the same number.
 *
 * It is per PROCESS, not per host: `web` and `worker` are separate containers,
 * so the box can still see one browser per service. That is a deliberate,
 * disclosed limit — a host-wide cap would need a lock outside both processes
 * (an advisory lock in Postgres, which both already connect to, is the obvious
 * candidate) and is not what this module is.
 */

/** Thrown by an acquirer when every slot is taken. Never a failure of the browser — there just isn't room. */
export class BrowserBusyError extends Error {
  constructor(message: string) {
    super(message);
    // Set explicitly: apps/web recognises this failure structurally by `name`
    // rather than by `instanceof`, because that orchestrator is deliberately
    // browser-free and never imports this module's graph.
    this.name = "BrowserBusyError";
  }
}

/** Spec P6 §3's "one at a time" — the value that holds until someone configures otherwise. */
const DEFAULT_MAX_CONCURRENT = 1;

/**
 * The global-registry key the counter lives under. Exported so the test can
 * assert on the slot directly — if this module ever goes back to module scope,
 * `browser-limit.test.ts`'s cross-bundle test goes red.
 */
export const BROWSER_SLOTS_KEY = Symbol.for("careerhq.autoapply.browserSlots");

interface BrowserSlots {
  max: number;
  inUse: number;
}

type GlobalWithSlots = typeof globalThis & { [BROWSER_SLOTS_KEY]?: BrowserSlots };

function slots(): BrowserSlots {
  const globals = globalThis as GlobalWithSlots;
  const existing = globals[BROWSER_SLOTS_KEY];
  if (existing) return existing;
  const created: BrowserSlots = { max: DEFAULT_MAX_CONCURRENT, inUse: 0 };
  globals[BROWSER_SLOTS_KEY] = created;
  return created;
}

/**
 * Applied once at wiring time from `config.autoapplyMaxConcurrentBrowsers`
 * (apps/worker/src/main.ts and apps/web/src/lib/site-driver.ts). Throws on a
 * value that would disable the limit rather than quietly accepting it: an
 * unbounded browser count on the demo box is the failure this module exists to
 * prevent, so it must not be reachable by a typo.
 */
export function configureBrowserLimit(maxConcurrent: number): void {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError(
      `AUTOAPPLY_MAX_CONCURRENT_BROWSERS must be a positive integer, got ${maxConcurrent}`,
    );
  }
  slots().max = maxConcurrent;
}

/**
 * A held slot. Calling it gives the slot back, once — it is also the PROOF that
 * its holder has one, which is how a slot outlives the call that took it:
 * `openSession({ slot })` drives a browser on a slot its caller acquired, and
 * leaves giving it back to that caller (apps/web's `siteBrowserReservation`
 * holds one across a whole confirm, so a busy refusal cannot land after the
 * confirmation token is burned).
 */
export type BrowserSlot = () => void;

/**
 * Takes a slot or throws. Returns the release, which is idempotent — a session
 * closed twice (or closed inside a `finally` that also ran on the error path)
 * must not hand out a browser it never held.
 *
 * The acquire/release pair exists alongside `withBrowserSlot` because a browser
 * SESSION's lifetime is not a function scope: `openSession` takes the slot and
 * the returned handle's `close()` gives it back, whenever the caller gets there.
 */
export function acquireBrowserSlot(): BrowserSlot {
  const state = slots();
  if (state.inUse >= state.max) {
    throw new BrowserBusyError(
      "the auto-apply browser is busy with another application — try again in a moment",
    );
  }
  state.inUse += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Clamped, not just decremented: `resetBrowserLimit()` zeroes the counter
    // in place, so a release handed out before a reset would otherwise take it
    // NEGATIVE — and a negative count silently allows two concurrent browsers
    // for the rest of the process's life. The invariant is unconditional here
    // rather than conventional at the call sites.
    state.inUse = Math.max(0, state.inUse - 1);
  };
}

/** The scoped form: hold a slot for exactly the duration of `fn`, released on both paths. */
export async function withBrowserSlot<T>(fn: () => Promise<T>): Promise<T> {
  const release = acquireBrowserSlot();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Test hook: how many browsers the process currently believes it has open. */
export function browserSlotsInUse(): number {
  return slots().inUse;
}

/** Test hook: back to the shipped default, with nothing held, so suites cannot leak into each other. */
export function resetBrowserLimit(): void {
  const state = slots();
  state.max = DEFAULT_MAX_CONCURRENT;
  state.inUse = 0;
}
