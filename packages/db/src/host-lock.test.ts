import { afterEach, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  createHostBrowserSlotLock, HostBrowserBusyError, type HostBrowserSlotLock,
} from "./host-lock.js";

/**
 * The seam this module exists for is TWO CONNECTIONS contending — `web`'s
 * process and `worker`'s. Two `acquire` calls on one lock object would prove
 * nothing about that: they share a session, and advisory locks are re-entrant
 * within a session. So every contention test here stands up a second
 * `createHostBrowserSlotLock`, which is a second Postgres backend, and the
 * refusals below are refusals across a real process boundary in every respect
 * except that both ends happen to live in this test's runtime.
 *
 * The classid is randomised per run (see `lockClass`): turbo runs this package's
 * test task at the same time as `@careerhq/web`'s, both against one
 * `TEST_DATABASE_URL`, and on the shipped key a slot the other suite held for
 * two milliseconds would make "the second acquirer is refused" pass for
 * entirely the wrong reason.
 */
const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

// Distinct per run AND per file, so a re-run that overlaps a previous one's
// stragglers cannot inherit its slots either.
const lockClass = 900_000_000 + Math.floor(Math.random() * 100_000_000);

const opened: HostBrowserSlotLock[] = [];

/** A lock on its own connection — the stand-in for "another process on this host". */
function lock(): HostBrowserSlotLock {
  const created = createHostBrowserSlotLock(url!, { lockClass });
  opened.push(created);
  return created;
}

beforeAll(() => {
  // A guard, not decoration: every assertion below is about a lock that is
  // free at the start, and a leaked classid would make them meaningless.
  expect(lockClass).toBeGreaterThan(0);
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((l) => l.close()));
});

d("the host-wide browser cap, across two connections", () => {
  it("refuses the second connection instead of queueing it", async () => {
    const web = lock();
    const worker = lock();

    const held = await web.acquire(1);
    expect(web.heldSlots()).toEqual([0]);

    // Timed, because "refused" and "queued" are only distinguishable by when.
    // A blocking `pg_advisory_lock` here would sit until `held()` ran, which is
    // after this assertion — so a pass means the call really did return, not
    // that it was fast.
    const startedAt = Date.now();
    await expect(worker.acquire(1)).rejects.toBeInstanceOf(HostBrowserBusyError);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(worker.heldSlots()).toEqual([]);

    // …and the holder still holds it. A refusal that also dropped the winner's
    // slot would satisfy the assertion above and be far worse than no cap.
    expect(web.heldSlots()).toEqual([0]);
    await held();
  });

  it("frees the slot for the other connection when the holder finishes", async () => {
    const web = lock();
    const worker = lock();

    const held = await web.acquire(1);
    await expect(worker.acquire(1)).rejects.toBeInstanceOf(HostBrowserBusyError);

    await held();
    expect(web.heldSlots()).toEqual([]);

    const second = await worker.acquire(1);
    expect(worker.heldSlots()).toEqual([0]);
    await second();
  });

  it("frees a killed holder's slot without anyone releasing it", async () => {
    const web = lock();
    const worker = lock();

    await web.acquire(1);
    const pid = await web.backendPid();
    await expect(worker.acquire(1)).rejects.toBeInstanceOf(HostBrowserBusyError);

    // What a `docker kill`, an OOM kill or a segfault does to the holder, done
    // from outside on a third connection: the backend goes away with the slot
    // still held and no release ever runs. This is the property that makes a
    // session advisory lock usable as a cap at all — anything with a lease or a
    // heartbeat would leave the slot dead for however long the timeout is.
    const executioner = postgres(url!, { max: 1 });
    try {
      await executioner`select pg_terminate_backend(${pid})`;
    } finally {
      await executioner.end({ timeout: 5 });
    }

    // Postgres releases on backend exit, which is not synchronous with
    // `pg_terminate_backend` returning.
    const regained = await eventually(() => worker.acquire(1));
    expect(worker.heldSlots()).toEqual([0]);
    await regained();
  });

  it("counts a configured cap of N as N host-wide slots, not N per connection", async () => {
    const web = lock();
    const worker = lock();
    const third = lock();

    const a = await web.acquire(2);
    const b = await worker.acquire(2);
    expect([...web.heldSlots(), ...worker.heldSlots()].sort()).toEqual([0, 1]);

    await expect(third.acquire(2)).rejects.toBeInstanceOf(HostBrowserBusyError);

    await a();
    // The freed slot is the one `web` had, and it is the one `third` gets.
    const c = await third.acquire(2);
    expect(third.heldSlots()).toEqual([0]);
    await Promise.all([b(), c()]);
  });

  it("does not hand one connection the same slot twice", async () => {
    // Advisory locks are re-entrant per session, so without the held-set the
    // second call here would succeed and the cap would be a per-connection
    // fiction. Both slots go to this connection; a third call has nothing left.
    const web = lock();
    const first = await web.acquire(2);
    const second = await web.acquire(2);
    expect(web.heldSlots()).toEqual([0, 1]);
    await expect(web.acquire(2)).rejects.toBeInstanceOf(HostBrowserBusyError);
    await first();
    await second();
    expect(web.heldSlots()).toEqual([]);
  });

  it("releases once, however many times the release is called", async () => {
    const web = lock();
    const worker = lock();
    const held = await web.acquire(1);
    await held();
    // The second call must not unlock the slot `worker` now holds.
    const other = await worker.acquire(1);
    await held();
    expect(worker.heldSlots()).toEqual([0]);
    await other();
  });

  it("refuses a cap that would disable the limit rather than accepting it", async () => {
    const web = lock();
    await expect(web.acquire(0)).rejects.toBeInstanceOf(RangeError);
    await expect(web.acquire(1.5)).rejects.toBeInstanceOf(RangeError);
  });
});

/** Retries `attempt` for up to a second — for the one assertion whose subject is the server's own cleanup, not ours. */
async function eventually<T>(attempt: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 1_000;
  for (;;) {
    try {
      return await attempt();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
