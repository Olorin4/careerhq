// DNS rebinding against the two paths the in-process pin never covered: the
// submit POST, and subresources. Measured before and after in the same file —
// the "before" browser is a Chromium launched exactly as this driver used to
// launch it, with no vetting proxy, and the "after" one is the shipped
// `openSession()`.
//
// ==> HOW THE REBINDING IS STAGED, AND WHY IT HAS TO BE <==
//
// A rebinding attack is two lookups of ONE name that answer differently: the
// benign address when the defender checks, the internal one when the browser
// connects. A test cannot own an attacker's zone, so one of the two answers has
// to be staged. This file stages OURS and leaves Chromium's real:
//
//   - the name is `127-0-0-1.nip.io`, a real public hostname whose real A
//     record is `127.0.0.1` — that is the answer Chromium's own resolver gets,
//     unstaged, and `internal` is the server sitting there;
//   - this process's resolver is made to answer `127.0.0.2` for that one name,
//     which the policy below treats as the allowed address — standing in for
//     the public answer an attacker would serve the defender. `decoy` is the
//     server sitting there.
//
// So a connection landing on `internal` is a connection made from Chromium's
// lookup, and one landing on `decoy` is a connection made from the address this
// process vetted. That is the whole measurement, and it is positive in both
// directions: not merely "the internal server was not hit" but "the request
// went to the address we pinned instead".
//
// Nothing about the POST is replayed to achieve this. The browser makes exactly
// one submit request, and each server counts what it received.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type * as DnsPromises from "node:dns/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseForm } from "@careerhq/autoapply";
import { chromium } from "playwright";
import { capturePage, fillAndSubmit, openSession, type BrowserSession, type DriverDeps } from "./driver.js";
import { resolveNavigationTarget, type ResolvedAddressPolicy } from "./pinned-navigation.js";
import { startVettingProxy } from "./vetting-proxy.js";

/** The one name whose answer is staged; everything else resolves for real. */
const REBIND_NAME = "127-0-0-1.nip.io";
/** What THIS process is told the name resolves to — the benign answer. */
const VETTED_ADDRESS = "127.0.0.2";

vi.mock("node:dns/promises", async (importActual) => {
  const actual = await importActual<typeof DnsPromises>();
  return {
    ...actual,
    lookup: (hostname: string, options?: unknown) =>
      hostname === REBIND_NAME
        ? Promise.resolve([{ address: VETTED_ADDRESS, family: 4 }])
        : (actual.lookup as (h: string, o?: unknown) => Promise<unknown>)(hostname, options),
  };
});

/** The genuine resolver, reached past this file's own mock — Chromium's answer. */
const { lookup: realLookup } = await vi.importActual<typeof DnsPromises>("node:dns/promises");

async function probeBrowser(): Promise<boolean> {
  try {
    const session = await openSession();
    await session.close();
    return true;
  } catch {
    return false;
  }
}

async function probeDns(): Promise<boolean> {
  try {
    // The REAL resolver, not the staged one: this is the answer Chromium gets.
    const answer = await realLookup(REBIND_NAME, { all: true });
    return answer.some((entry) => entry.address === "127.0.0.1");
  } catch {
    return false;
  }
}

const browserAvailable = await probeBrowser();
const dnsAvailable = await probeDns();
if (!browserAvailable || !dnsAvailable) {
  console.warn(
    `[rebinding-probe.test] live tests skipped — chromium: ${browserAvailable}, public DNS: ${dnsAvailable}`,
  );
}

const live = describe.skipIf(!browserAvailable || !dnsAvailable);

live("a rebinding answer between our check and Chromium's connect", () => {
  const SECRET = "REBIND-PROBE-SECRET-9a4f01";

  /** 127.0.0.1 — where the REAL DNS answer points. Must receive nothing. */
  let internal: Server;
  /** 127.0.0.2 — the address this process vetted and must therefore dial. */
  let decoy: Server;
  /** The page the browser is actually on; its own address is allow-listed below. */
  let site: Server;
  let sharedPort = 0;
  let sitePort = 0;
  let internalHits = 0;
  let decoyHits = 0;

  /**
   * A Chromium launched the way this driver launched one BEFORE the vetting
   * proxy existed. Everything else about the session is identical, so the two
   * measurements differ by exactly one thing.
   */
  async function unproxiedSession(): Promise<BrowserSession> {
    const browser = await chromium.launch({ headless: true });
    return { newPage: () => browser.newPage(), close: () => browser.close() };
  }

  /**
   * `127.0.0.2` stands in for the public address the attacker's zone answers the
   * defender with; the page's own host is allowed so the form can be served at
   * all. `127.0.0.1` — the real answer — is allowed by neither.
   */
  const addressPolicy: ResolvedAddressPolicy = (url, address) =>
    address === VETTED_ADDRESS || new URL(url).port === String(sitePort);

  const deps: DriverDeps = {
    timeoutMs: 20_000,
    isNavigationAllowed: () => true,
    isResolvedAddressAllowed: addressPolicy,
  };

  const listen = async (server: Server, host: string, port = 0): Promise<number> => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    return (server.address() as AddressInfo).port;
  };

  const countingServer = (bump: () => void, body: string): Server =>
    createServer((_req, res) => {
      bump();
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body>${body}</body></html>`);
    });

  beforeAll(async () => {
    internal = countingServer(() => { internalHits += 1; }, `<h1>${SECRET}</h1>`);
    decoy = countingServer(() => { decoyHits += 1; }, "<h1>decoy</h1>");
    // The same port on both addresses: one URL, two possible answers, which is
    // exactly the ambiguity a rebinding answer creates.
    sharedPort = await listen(internal, "127.0.0.1");
    await listen(decoy, "127.0.0.2", sharedPort);

    site = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      if (req.url === "/subresource") {
        // A blocking classic script rather than an image, so the subresource is
        // resolved and fetched (or refused) BEFORE `domcontentloaded` and the
        // measurement cannot race the page being closed. What it is matters not
        // at all — only where the request goes.
        res.end(
          `<html><head><script src="http://${REBIND_NAME}:${sharedPort}/app.js"></script></head>`
          + `<body><h1>Apply</h1></body></html>`,
        );
        return;
      }
      res.end(
        `<html><body><h1>Apply</h1>`
        + `<form method="POST" action="http://${REBIND_NAME}:${sharedPort}/apply">`
        + `<input id="name" name="name" type="text">`
        + `<button id="btn_submit" type="submit">Submit</button>`
        + `</form></body></html>`,
      );
    });
    sitePort = await listen(site, "127.0.0.1");
  }, 60_000);

  afterAll(() => {
    internal?.close();
    decoy?.close();
    site?.close();
  });

  beforeEach(() => {
    internalHits = 0;
    decoyHits = 0;
  });

  /** One capture + one submit click, on whichever session is handed in. */
  async function submitThrough(session: BrowserSession): Promise<void> {
    const url = `http://127.0.0.1:${sitePort}/form`;
    const raw = await capturePage(session, url, deps);
    await fillAndSubmit(session, { url, form: parseForm(raw), answers: [], files: {}, deps });
  }

  /** The staging itself, asserted rather than assumed: the two lookups disagree. */
  it("is a name whose two lookups genuinely answer differently", async () => {
    const real = await realLookup(REBIND_NAME, { all: true });
    expect(real.map((entry) => entry.address)).toContain("127.0.0.1");
    expect(await resolveNavigationTarget(`http://${REBIND_NAME}/`, () => true))
      .toEqual({ kind: "pinned", addresses: [{ address: VETTED_ADDRESS, family: 4 }] });
  }, 30_000);

  // -------------------------------------------------------------------------
  // The submit POST.
  // -------------------------------------------------------------------------
  it("BEFORE: an unproxied Chromium re-resolves the name and posts to the internal address", async () => {
    const session = await unproxiedSession();
    try {
      await submitThrough(session);
    } finally {
      await session.close();
    }
    expect(internalHits).toBeGreaterThan(0);
    expect(decoyHits).toBe(0);
  }, 90_000);

  it("AFTER: the shipped session posts to the address it vetted, and the internal server gets nothing", async () => {
    const session = await openSession();
    try {
      await submitThrough(session);
    } finally {
      await session.close();
    }
    expect(internalHits).toBe(0);
    expect(decoyHits).toBeGreaterThan(0);
  }, 90_000);

  // -------------------------------------------------------------------------
  // Subresources.
  //
  // ==> WHAT MEASURING THIS FIRST TURNED UP, AND WHY THE SHAPE IS WHAT IT IS <==
  //
  // The obvious probe — a page captured by `capturePage`, with a script tag
  // pointing at the rebound name — shows ZERO hits on the internal server even
  // BEFORE this change, and not for any reason CareerHQ can take credit for.
  // A main-frame GET is fulfilled from `pinnedFetch`, so Chromium never made a
  // network connection for that document and gives it no address space; a
  // subresource from it into the loopback space is then refused by Chromium's
  // own private-network rule, verbatim:
  //
  //   "Access to script at '…' from origin '…' has been blocked by CORS
  //    policy: Permission was denied for this request to access the `loopback`
  //    address space."
  //
  // That is a browser rule, subject to a browser's release notes, and it stops
  // covering the request the moment the document is one Chromium DID fetch —
  // measured: the same script, in an iframe whose document came off the network,
  // loads and reaches the loopback server. An ATS application form served inside
  // an iframe is not an exotic shape; it is the normal one.
  //
  // So the probe below drives the page directly rather than through
  // `capturePage`: the document is one Chromium fetched, which is the case the
  // browser's own rule does not cover and the case the guard never looked at.
  // -------------------------------------------------------------------------
  const subresourceUrl = (): string => `http://127.0.0.1:${sitePort}/subresource`;

  it("BEFORE: an unproxied Chromium pulls a subresource straight off the rebound address", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(subresourceUrl(), { waitUntil: "load", timeout: 30_000 });
    } finally {
      await browser.close();
    }
    expect(internalHits).toBeGreaterThan(0);
    expect(decoyHits).toBe(0);
  }, 90_000);

  it("AFTER: the shipped session's subresource goes to the vetted address instead", async () => {
    const session = await openSession();
    session.useAddressPolicy?.(addressPolicy);
    try {
      const page = await session.newPage();
      await page.goto(subresourceUrl(), { waitUntil: "load", timeout: 30_000 });
      // The document itself still loads — a fix that broke rendering would pass
      // the assertions below for the wrong reason.
      expect(await page.textContent("h1")).toBe("Apply");
    } finally {
      await session.close();
    }
    expect(internalHits).toBe(0);
    expect(decoyHits).toBeGreaterThan(0);
  }, 90_000);

  /**
   * And with no stand-in at all: when every answer the name has is off policy,
   * nothing is dialled. `decoyHits` is 0 here too — a refusal, not a
   * redirection.
   */
  it("AFTER: refuses the subresource outright when no answer passes the policy", async () => {
    const session = await openSession();
    session.useAddressPolicy?.((url) => new URL(url).port === String(sitePort));
    try {
      const page = await session.newPage();
      await page.goto(subresourceUrl(), { waitUntil: "load", timeout: 30_000 });
    } finally {
      await session.close();
    }
    expect(internalHits).toBe(0);
    expect(decoyHits).toBe(0);
  }, 90_000);

  /**
   * A `startVettingProxy` handed to a browser directly behaves the same way —
   * the property belongs to the proxy, not to anything else `openSession` does.
   */
  it("AFTER: the same result when the proxy is attached to a bare browser", async () => {
    const proxy = await startVettingProxy();
    proxy.setPolicy(addressPolicy);
    const browser = await chromium.launch({ headless: true, proxy: { server: proxy.server } });
    const session: BrowserSession = {
      newPage: () => browser.newPage(),
      close: () => browser.close(),
      useAddressPolicy: (policy) => proxy.setPolicy(policy),
    };
    try {
      await submitThrough(session);
    } finally {
      await session.close();
      await proxy.close();
    }
    expect(internalHits).toBe(0);
    expect(decoyHits).toBeGreaterThan(0);
  }, 90_000);
});
