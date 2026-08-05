/**
 * The host-wide half of the browser cap (roadmap, "Carried beyond P6 →
 * Operational": *the browser cap … is per process, so `web` and `worker` can
 * each hold one Chromium*).
 *
 * `apps/worker/src/autoapply/browser-limit.ts` counts browsers inside ONE
 * process, on `globalThis`. That is the right shape for what it can see, and it
 * stays — but the number the demo box's RAM budget is actually about is how
 * many Chromiums exist on the HOST, and `web` and `worker` are two processes in
 * two containers. Two counters, each honestly reporting "one", is two browsers:
 * the 900 MB and 1200 MB `mem_limit`s in `infra/docker-compose.demo.yml` were
 * sized against a bounded browser count, and `careerhq-web` already idles at
 * ~47% of its share.
 *
 * The only thing both processes already share is Postgres, so the outer bound
 * is a Postgres advisory lock. This module is that bound, and nothing else: the
 * in-process counter is still taken first at every call site (it is cheaper,
 * and it is the one that survives a database that is briefly unreachable).
 *
 * ----------------------------------------------------------------- why these
 *
 * **`pg_try_advisory_lock`, not `pg_advisory_lock`.** The try form returns
 * false instead of waiting. Refusing immediately is a property the in-process
 * cap already has and that the visitor-facing behaviour depends on: a confirm
 * that cannot get a browser must fail *now*, while its confirmation token is
 * still unburned, rather than queue behind another visitor's five-minute
 * Playwright run and time out somewhere less recoverable. A blocking lock here
 * would silently convert an honest "busy, try again" into a hang.
 *
 * **Session-level, not `_xact_`.** The hold spans a whole confirm — probe,
 * `beginSubmission`, fill, click, screenshot — which is minutes of browser
 * work, not a transaction. Holding an open transaction across it would park an
 * `idle in transaction` backend for the duration, pinning vacuum's xmin
 * horizon on a 400 MB Postgres. A session lock has the release semantics that
 * matter anyway: the server drops every lock the *connection* held the moment
 * the connection dies, so a `docker kill`, an OOM kill or a segfault cannot
 * strand the slot. Nothing has to notice the crash and nothing has to expire.
 *
 * **A dedicated connection, not the app's pool.** `createDb` pools ten
 * connections and hands out whichever is free. A session lock taken through
 * that pool would be released by whatever connection the `pg_advisory_unlock`
 * query happened to land on — usually not the one holding it — and the lock
 * would ride, invisibly, on a connection the pool then gives to a page render.
 * The lock needs a connection whose lifetime IS the lock's, so it gets one.
 *
 * **The two-int key form.** `pg_try_advisory_lock(int4, int4)` and
 * `pg_advisory_xact_lock(bigint)` occupy different lock spaces (`objsubid` 2
 * and 1), so these keys cannot collide with `DEMO_SEED_LOCK_KEY`'s even by
 * arithmetic accident. The second int is the slot index, so a configured cap of
 * N is N distinct keys and the cap is genuinely N host-wide rather than one.
 *
 * ------------------------------------------------------------ what it is not
 *
 * It is not a fence against a second HOST. Two boxes pointed at one database
 * would share these slots, which is the correct behaviour for this lock and the
 * wrong assumption for a RAM budget; the demo is one box and this is stated
 * rather than solved.
 *
 * And a silent reconnect between acquire and release drops the lock server-side
 * while this process still believes it holds one. `max_lifetime: null` removes
 * the one routine cause (postgres-js recycles connections after 30–60 minutes
 * by default), `onclose` clears the bookkeeping when it happens anyway, and the
 * release reports an unlock the server says it never held. The failure mode is
 * bounded on purpose: losing the outer bound degrades to the per-process cap,
 * which is exactly the behaviour that shipped before this module existed.
 */
import postgres from "postgres";

/** The `classid` half of every key here. Arbitrary but fixed — changing it would let an old process and a new one hold the same slot. */
export const HOST_BROWSER_LOCK_CLASS = 620_260_806;

/**
 * Thrown when every host-wide slot is taken. Recognised structurally by `name`
 * in `apps/web/src/lib/site-submission.ts`, beside `BrowserBusyError`, by the
 * same convention and for the same reason: that orchestrator takes its driver
 * by injection and never imports either module's graph.
 */
export class HostBrowserBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostBrowserBusyError";
  }
}

/** A held host-wide slot. Calling it gives the slot back, once. */
export type HostBrowserSlot = () => Promise<void>;

/**
 * One dedicated lock connection and the slots it currently holds. Separable
 * from the process-wide singleton below so a test can stand up two of these and
 * contend for real — two connections is the seam this module exists for, and
 * two calls in one process would prove nothing about it.
 */
export interface HostBrowserSlotLock {
  /** Takes the lowest free slot below `maxConcurrent`, or throws {@link HostBrowserBusyError}. Never waits. */
  acquire: (maxConcurrent: number) => Promise<HostBrowserSlot>;
  /** Test hook: which slot indices this connection believes it holds. */
  heldSlots: () => number[];
  /** Test hook: the server-side pid of the lock connection, so a test can kill it the way a crash would. */
  backendPid: () => Promise<number>;
  /** Closes the connection, releasing every slot it held. */
  close: () => Promise<void>;
}

export interface HostBrowserSlotLockOptions {
  /**
   * The `classid` half of every key. Defaults to {@link HOST_BROWSER_LOCK_CLASS}
   * and is overridden by exactly one kind of caller: a test suite, with a
   * per-run value.
   *
   * Not a tuning knob and not configurable from the environment. It exists
   * because several suites contend for these slots against ONE shared
   * `TEST_DATABASE_URL`, and turbo runs `@careerhq/db`'s and `@careerhq/web`'s
   * test tasks at the same time — on the shipped classid, one suite holding a
   * slot for two milliseconds would make the other's refusal assertions
   * intermittently true for the wrong reason. Production never passes it, so
   * `web` and `worker` always meet on the same key.
   */
  lockClass?: number;
}

export function createHostBrowserSlotLock(
  databaseUrl: string,
  options: HostBrowserSlotLockOptions = {},
): HostBrowserSlotLock {
  const lockClass = options.lockClass ?? HOST_BROWSER_LOCK_CLASS;
  const held = new Set<number>();
  const sql = postgres(databaseUrl, {
    // One connection, and one only: a second would hold locks this module
    // cannot address, since a release must run on the connection that acquired.
    max: 1,
    // postgres-js recycles a connection after 30–60 minutes by DEFAULT, which
    // would drop a held lock mid-confirm without anyone asking it to. `null`
    // switches the lifetime timer off entirely — the value postgres-js's own
    // `sql.reserve()` uses for the same reason; only its published types are
    // narrower than what it accepts, hence the cast.
    max_lifetime: null as unknown as number,
    // `idle_timeout` is deliberately left at its default of "never": an idle
    // lock connection is exactly what holding a slot across a five-minute
    // browser run looks like from the driver's side.
    //
    // Bounded, because this call sits in front of a visitor-facing refusal: an
    // unreachable database must surface as a refusal, not as a hang.
    connect_timeout: 10,
    // The connection dropped — the server has already released everything it
    // held, so the bookkeeping must not keep claiming those slots are ours.
    onclose: () => held.clear(),
    // Names this connection in `pg_stat_activity`, so an operator staring at a
    // long-lived backend can tell what is holding it.
    connection: { application_name: "careerhq-browser-slot" },
  });

  return {
    acquire: async (maxConcurrent: number): Promise<HostBrowserSlot> => {
      assertPositiveInteger(maxConcurrent);
      for (let slot = 0; slot < maxConcurrent; slot += 1) {
        // Advisory locks are re-entrant within a session: asking twice for a
        // key this connection already holds would SUCCEED and quietly hand out
        // a slot that does not exist. Skipping what we hold is what makes a
        // configured cap above 1 correct.
        if (held.has(slot)) continue;
        const rows = await sql<Array<{ locked: boolean }>>`
          select pg_try_advisory_lock(${lockClass}::int4, ${slot}::int4) as locked
        `;
        if (!rows[0]?.locked) continue;
        held.add(slot);
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          held.delete(slot);
          const unlocked = await sql<Array<{ unlocked: boolean }>>`
            select pg_advisory_unlock(${lockClass}::int4, ${slot}::int4) as unlocked
          `;
          if (!unlocked[0]?.unlocked) {
            // The server says this session never held it — i.e. the connection
            // dropped and came back during the hold. Worth saying out loud: for
            // that window the host-wide bound was not in force and only the
            // per-process cap was. Not thrown: the browser work is already done
            // and the caller has nothing to do about it.
            console.warn(
              `host browser slot ${slot} was already gone at release — the lock connection reconnected mid-hold`,
            );
          }
        };
      }
      throw new HostBrowserBusyError(
        "the auto-apply browser is busy with another application — try again in a moment",
      );
    },
    heldSlots: () => [...held],
    backendPid: async () => {
      const rows = await sql<Array<{ pid: number }>>`select pg_backend_pid() as pid`;
      return rows[0]!.pid;
    },
    close: async () => {
      held.clear();
      await sql.end({ timeout: 5 });
    },
  };
}

function assertPositiveInteger(maxConcurrent: number): void {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError(
      `host browser slots must be a positive integer, got ${maxConcurrent}`,
    );
  }
}

/**
 * The process-wide lock connection, on a registered global symbol rather than a
 * module-level `let` — the same lesson as the rate limiter's counters and the
 * browser counter (P6 task-3): Next.js emits a separate server bundle per route
 * entry, so a module-level connection here would be one per BUNDLE. That would
 * not break the cap (distinct connections cannot hold the same advisory key),
 * but it would open a lock connection per route that ever drives a browser, and
 * `re-entrancy` bookkeeping split across bundles is a bug waiting for a
 * configured cap above 1.
 */
const HOST_BROWSER_LOCK_KEY = Symbol.for("careerhq.db.hostBrowserSlotLock");
interface LockHolder { url: string; lockClass: number; lock: HostBrowserSlotLock }
type GlobalWithLock = typeof globalThis & {
  [HOST_BROWSER_LOCK_KEY]?: LockHolder;
  [HOST_BROWSER_LOCK_CLASS_KEY]?: number;
};

const HOST_BROWSER_LOCK_CLASS_KEY = Symbol.for("careerhq.db.hostBrowserSlotLockClass");

/**
 * Test hook, and the process-wide twin of {@link HostBrowserSlotLockOptions.lockClass}:
 * points {@link acquireHostBrowserSlot} at a per-run classid so a suite driving
 * the real production path cannot collide with another suite on a shared
 * `TEST_DATABASE_URL`. Takes effect on the next acquire — the current lock
 * connection is dropped, releasing anything it holds.
 */
export async function configureHostBrowserLockClass(lockClass: number): Promise<void> {
  const globals = globalThis as GlobalWithLock;
  globals[HOST_BROWSER_LOCK_CLASS_KEY] = lockClass;
  await resetHostBrowserSlots();
}

function processLock(databaseUrl: string): HostBrowserSlotLock {
  const globals = globalThis as GlobalWithLock;
  const lockClass = globals[HOST_BROWSER_LOCK_CLASS_KEY] ?? HOST_BROWSER_LOCK_CLASS;
  const existing = globals[HOST_BROWSER_LOCK_KEY];
  // A changed URL means a different database, and a lock connection to the old
  // one proves nothing about the new one. Dropped rather than reused; the old
  // connection is closed in the background because nothing is waiting on it.
  if (existing && (existing.url !== databaseUrl || existing.lockClass !== lockClass)) {
    void existing.lock.close().catch(() => undefined);
    delete globals[HOST_BROWSER_LOCK_KEY];
  } else if (existing) {
    return existing.lock;
  }
  const created: LockHolder = {
    url: databaseUrl,
    lockClass,
    lock: createHostBrowserSlotLock(databaseUrl, { lockClass }),
  };
  globals[HOST_BROWSER_LOCK_KEY] = created;
  return created.lock;
}

/**
 * Takes one of the host's `maxConcurrent` browser slots, or throws
 * {@link HostBrowserBusyError} immediately. The returned release is idempotent.
 *
 * Callers take their own process's slot FIRST and this one second (see
 * `apps/web/src/lib/site-driver.ts`): the cheap local refusal should not cost a
 * database round trip, and a process that is already busy should not spend a
 * host slot for the microseconds before it discovers that. Neither lock ever
 * waits, so the ordering cannot deadlock in either direction.
 */
export function acquireHostBrowserSlot(databaseUrl: string, maxConcurrent: number): Promise<HostBrowserSlot> {
  return processLock(databaseUrl).acquire(maxConcurrent);
}

/** Test hook: drops the process-wide lock connection, releasing anything it holds. */
export async function resetHostBrowserSlots(): Promise<void> {
  const globals = globalThis as GlobalWithLock;
  const existing = globals[HOST_BROWSER_LOCK_KEY];
  delete globals[HOST_BROWSER_LOCK_KEY];
  if (existing) await existing.lock.close();
}
