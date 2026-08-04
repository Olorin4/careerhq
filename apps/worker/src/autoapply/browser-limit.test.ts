import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireBrowserSlot, BROWSER_SLOTS_KEY, BrowserBusyError, browserSlotsInUse,
  configureBrowserLimit, resetBrowserLimit, withBrowserSlot,
} from "./browser-limit.js";

describe("withBrowserSlot", () => {
  beforeEach(() => resetBrowserLimit());

  it("serialises: a second concurrent acquirer is refused, not queued", async () => {
    configureBrowserLimit(1);
    let release!: () => void;
    const held = withBrowserSlot(() => new Promise<void>((r) => { release = r; }));
    await expect(withBrowserSlot(async () => "second")).rejects.toBeInstanceOf(BrowserBusyError);
    release();
    await held;
    await expect(withBrowserSlot(async () => "third")).resolves.toBe("third");
  });

  it("releases the slot even when the body throws", async () => {
    configureBrowserLimit(1);
    await expect(withBrowserSlot(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(withBrowserSlot(async () => "ok")).resolves.toBe("ok");
  });

  it("refuses immediately rather than waiting for the slot to free up", async () => {
    configureBrowserLimit(1);
    let release!: () => void;
    const held = withBrowserSlot(() => new Promise<void>((r) => { release = r; }));
    // Nothing has yielded to the holder yet: if the refusal queued, this would
    // still be pending here instead of already rejected.
    const refused = await withBrowserSlot(async () => "second").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(BrowserBusyError);
    expect((refused as Error).message).toMatch(/busy/i);
    release();
    await held;
  });

  it("lets a configured limit above 1 run that many at once, and no more", async () => {
    configureBrowserLimit(2);
    const releases: Array<() => void> = [];
    const hold = () => withBrowserSlot(() => new Promise<void>((r) => releases.push(r)));
    const first = hold();
    const second = hold();
    await expect(hold()).rejects.toBeInstanceOf(BrowserBusyError);
    for (const release of releases) release();
    await Promise.all([first, second]);
    expect(browserSlotsInUse()).toBe(0);
  });
});

describe("configureBrowserLimit", () => {
  beforeEach(() => resetBrowserLimit());

  it("defaults to one browser at a time when never configured", async () => {
    const release = acquireBrowserSlot();
    expect(() => acquireBrowserSlot()).toThrow(BrowserBusyError);
    release();
  });

  it("refuses a limit that is not a positive integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => configureBrowserLimit(bad)).toThrow(RangeError);
    }
  });
});

describe("acquireBrowserSlot", () => {
  beforeEach(() => resetBrowserLimit());

  it("releases at most once, however often the release is called", () => {
    configureBrowserLimit(1);
    const release = acquireBrowserSlot();
    release();
    release();
    expect(browserSlotsInUse()).toBe(0);
    // A double release that decremented twice would have made the counter
    // negative and handed out an extra browser here.
    const second = acquireBrowserSlot();
    expect(() => acquireBrowserSlot()).toThrow(BrowserBusyError);
    second();
  });
});

describe("cross-bundle state", () => {
  beforeEach(() => resetBrowserLimit());

  it("keeps the counter on globalThis, not in module scope", () => {
    const globals = globalThis as typeof globalThis & {
      [BROWSER_SLOTS_KEY]?: { max: number; inUse: number };
    };
    const release = acquireBrowserSlot();
    expect(globals[BROWSER_SLOTS_KEY]?.inUse).toBe(1);
    release();
    expect(globals[BROWSER_SLOTS_KEY]?.inUse).toBe(0);
  });

  it("counts a second module instance's slots against the first one's limit", async () => {
    vi.resetModules();
    const bundleA = await import("./browser-limit.js");
    vi.resetModules();
    const bundleB = await import("./browser-limit.js");
    // Two genuinely different module instances, as Next.js's per-route server
    // bundles are — not the same object handed back twice.
    expect(bundleA).not.toBe(bundleB);

    bundleA.configureBrowserLimit(1);
    const release = bundleA.acquireBrowserSlot();
    // With a module-level counter this succeeded: bundle B had its own slot,
    // and "one Chromium at a time" was a lie on a 3.7 GB box.
    expect(() => bundleB.acquireBrowserSlot()).toThrow(bundleB.BrowserBusyError);
    release();
    // …and the sharing goes both ways: A's release freed B's slot too.
    bundleB.acquireBrowserSlot()();
  });
});
