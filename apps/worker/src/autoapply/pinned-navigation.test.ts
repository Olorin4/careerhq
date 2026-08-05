// Resolve-then-pin, proven the way the rest of the SSRF work was proven: by
// exploit, against real DNS and a real Chromium, not by reading the code.
//
// `*.nip.io` is a real public DNS zone that answers with the address spelled
// into the name, so `127-0-0-1.nip.io` is an ordinary public hostname — every
// literal layer of the capture policy passes it — whose A record is the
// loopback address. That is exactly the gap this closes, and it is the same
// name the P6 review used. Nothing here fakes a resolver.
//
// The load-bearing assertion in the refusal cases is `internalHits`, as in
// driver.test.ts's redirect suite: not "we did not return the secret" but "we
// never asked for it".
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { lookup } from "node:dns/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { allowsCaptureTarget, allowsResolvedAddress, type CaptureTargetPolicy } from "@careerhq/autoapply/policy";
import { capturePage, DriverError, openSession, type BrowserSession, type DriverDeps } from "./driver.js";
import { pinnedFetch, pinnedLookup, resolveNavigationTarget } from "./pinned-navigation.js";

/** Same probes as driver.test.ts: a missing browser or no DNS is a skip, not a failure. */
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
    const answer = await lookup("127-0-0-1.nip.io", { all: true });
    return answer.some((entry) => entry.address === "127.0.0.1");
  } catch {
    return false;
  }
}

const browserAvailable = await probeBrowser();
const dnsAvailable = await probeDns();
if (!browserAvailable || !dnsAvailable) {
  console.warn(
    `[pinned-navigation.test] live tests skipped — chromium: ${browserAvailable}, public DNS: ${dnsAvailable}`,
  );
}

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

const PERSONAL: CaptureTargetPolicy = { workspaceKind: "personal", sandboxSiteAllowedHost: "demo-ats" };
const allowAll = (): boolean => true;

// ---------------------------------------------------------------------------
// The pin itself, with no browser involved: the socket goes to the address it
// was handed, and the resolver is not consulted.
// ---------------------------------------------------------------------------
describe("pinnedLookup", () => {
  const addresses = [
    { address: "203.0.113.7", family: 4 },
    { address: "2001:db8::7", family: 6 },
  ];

  const ask = (options: object): Promise<unknown[]> =>
    new Promise((resolve) => {
      (pinnedLookup(addresses) as unknown as (
        host: string, opts: object, cb: (...args: unknown[]) => void,
      ) => void)("ignored.example", options, (...args) => resolve(args));
    });

  it("answers the single-address shape Node uses for a plain connect", async () => {
    expect(await ask({ family: 0, all: false })).toEqual([null, "203.0.113.7", 4]);
  });

  it("answers the list shape Node uses under autoSelectFamily", async () => {
    expect(await ask({ family: 0, all: true })).toEqual([null, addresses, 0]);
  });

  // Answering an A record to a request for AAAA produces a confusing connect
  // error rather than a connection, so a family constraint is honoured.
  it("filters to the requested family", async () => {
    expect(await ask({ family: 6, all: true })).toEqual([null, [addresses[1]], 0]);
    expect(await ask({ family: 4, all: false })).toEqual([null, "203.0.113.7", 4]);
  });

  it("fails rather than falling back when the family cannot be served", async () => {
    const v4Only = pinnedLookup([{ address: "203.0.113.7", family: 4 }]) as unknown as (
      host: string, opts: object, cb: (...args: unknown[]) => void,
    ) => void;
    const [err] = await new Promise<unknown[]>((resolve) => {
      v4Only("ignored.example", { family: 6, all: false }, (...args) => resolve(args));
    });
    expect(err).toBeInstanceOf(Error);
  });
});

describe("pinnedFetch", () => {
  let server: Server;
  let port = 0;
  let seenHost: string | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      seenHost = req.headers.host;
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "http://elsewhere.example/next" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "set-cookie": ["a=1", "b=2"] });
      res.end("<html><body>pinned</body></html>");
    });
    port = await listen(server);
  });

  afterAll(() => server?.close());

  /**
   * THE property, stated as a test: the URL names a host that resolves
   * somewhere else entirely, and the request still arrives at the pinned
   * address — with the NAME in its Host header, which is what keeps TLS SNI and
   * certificate verification honest. A rebinding answer between the check and
   * the fetch has nowhere to land, because there is no second lookup.
   */
  it("connects to the pinned address, not to what the name resolves to", async () => {
    const response = await pinnedFetch(`http://careers.northwind.example:${port}/`, {
      headers: { "user-agent": "probe" },
      addresses: [{ address: "127.0.0.1", family: 4 }],
      timeoutMs: 5_000,
    });
    expect(response.status).toBe(200);
    expect(response.body.toString()).toContain("pinned");
    expect(seenHost).toBe(`careers.northwind.example:${port}`);
  });

  it("does not follow a redirect — the caller judges the Location header first", async () => {
    const response = await pinnedFetch(`http://careers.northwind.example:${port}/redirect`, {
      headers: {},
      addresses: [{ address: "127.0.0.1", family: 4 }],
      timeoutMs: 5_000,
    });
    expect(response.status).toBe(302);
    expect(response.headers["location"]).toBe("http://elsewhere.example/next");
  });

  it("keeps every Set-Cookie line, joined the way route.fulfill takes them", async () => {
    const response = await pinnedFetch(`http://careers.northwind.example:${port}/`, {
      headers: {},
      addresses: [{ address: "127.0.0.1", family: 4 }],
      timeoutMs: 5_000,
    });
    expect(response.headers["set-cookie"]).toBe("a=1\nb=2");
    // Hop-by-hop headers describe a connection the browser is not making.
    expect(response.headers["connection"]).toBeUndefined();
    expect(response.headers["transfer-encoding"]).toBeUndefined();
  });
});

describe("resolveNavigationTarget", () => {
  it("needs no resolver for an IP literal, and still judges it", async () => {
    expect(await resolveNavigationTarget("http://93.184.216.34/", allowAll))
      .toEqual({ kind: "pinned", addresses: [{ address: "93.184.216.34", family: 4 }] });
    expect(await resolveNavigationTarget("http://[::1]/", (_url, address) => address !== "::1"))
      .toEqual({ kind: "refused", address: "::1" });
  });

  it("reports a name that does not resolve as unresolved, not as refused", async () => {
    expect(await resolveNavigationTarget("not a url", allowAll)).toEqual({ kind: "unresolved" });
    // A real NXDOMAIN, which can take a resolver a moment to say so.
    expect(await resolveNavigationTarget("http://nothing.invalid/", allowAll)).toEqual({ kind: "unresolved" });
  }, 20_000);

  const withDns = describe.skipIf(!dnsAvailable);

  withDns("against real public DNS", () => {
    it("refuses a public name whose A record is a private address", async () => {
      const outcome = await resolveNavigationTarget(
        "http://127-0-0-1.nip.io/",
        (url, address) => allowsResolvedAddress(url, address, PERSONAL),
      );
      expect(outcome).toEqual({ kind: "refused", address: "127.0.0.1" });
    }, 20_000);

    it("refuses the metadata endpoint reached through a name", async () => {
      const outcome = await resolveNavigationTarget(
        "http://169-254-169-254.nip.io/latest/meta-data/",
        (url, address) => allowsResolvedAddress(url, address, PERSONAL),
      );
      expect(outcome).toEqual({ kind: "refused", address: "169.254.169.254" });
    }, 20_000);

    /**
     * EVERY record, not the first. A name that answers with one public and one
     * private address must be refused: which of them a socket would have got is
     * the resolver's ordering, Happy Eyeballs and the attacker's choice, not
     * ours. Simulated over a real multi-address name by refusing its LAST
     * answer — if only the first were judged, this would pass as `pinned`.
     */
    it("judges every A and AAAA record, not just the first", async () => {
      const answers = await lookup("example.com", { all: true });
      expect(answers.length).toBeGreaterThan(1);
      const last = answers.at(-1)!.address;
      const outcome = await resolveNavigationTarget(
        "http://example.com/",
        (_url, address) => address !== last,
      );
      expect(outcome).toEqual({ kind: "refused", address: last });
    }, 20_000);

    it("pins a legitimate public name to the addresses it answered with", async () => {
      const outcome = await resolveNavigationTarget("http://example.com/", allowAll);
      expect(outcome.kind).toBe("pinned");
      expect(outcome.kind === "pinned" && outcome.addresses.length).toBeGreaterThan(0);
    }, 20_000);
  });
});

// ---------------------------------------------------------------------------
// The exploit, end to end, through the real driver and a real browser.
// ---------------------------------------------------------------------------
const live = describe.skipIf(!browserAvailable || !dnsAvailable);

live("the driver refuses a DNS name that resolves privately", () => {
  const SECRET = "PINNED-NAV-SSRF-SECRET-7c31de";
  let session: BrowserSession;
  let internal: Server;
  let internalPort = 0;
  let internalHits = 0;

  const deps = (over: Partial<DriverDeps> = {}): DriverDeps => ({
    timeoutMs: 20_000,
    isNavigationAllowed: (url) => allowsCaptureTarget(url, PERSONAL),
    isResolvedAddressAllowed: (url, address) => allowsResolvedAddress(url, address, PERSONAL),
    ...over,
  });

  beforeAll(async () => {
    internal = createServer((_req, res) => {
      internalHits += 1;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body><h1>${SECRET}</h1><form><input id="e" name="e"></form></body></html>`);
    });
    internalPort = await listen(internal);
    session = await openSession();
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    internal?.close();
  });

  beforeEach(() => {
    internalHits = 0;
  });

  /** The whole gap in one line: the literal layers say yes, because the host is a public name. */
  it("is a target every literal layer allows", () => {
    expect(allowsCaptureTarget(`http://127-0-0-1.nip.io:${internalPort}/secret`, PERSONAL)).toBe(true);
  });

  it("refuses the navigation without contacting the address", async () => {
    const failure = await capturePage(session, `http://127-0-0-1.nip.io:${internalPort}/secret`, deps())
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DriverError);
    expect((failure as DriverError).kind).toBe("navigation");
    expect((failure as DriverError).message).toMatch(/resolves to 127\.0\.0\.1/);
    expect(internalHits).toBe(0);
  }, 60_000);

  /**
   * The same refusal one hop in. The chain starts at a host whose own address
   * is exempted here — standing in for the legitimate public ATS a real chain
   * starts at — and the hop onto the private-resolving name is refused before
   * it is requested, exactly like the literal-host hop in driver.test.ts.
   */
  it("refuses a redirect hop onto a private-resolving name, before requesting it", async () => {
    const redirector = createServer((_req, res) => {
      res.writeHead(302, { location: `http://127-0-0-1.nip.io:${internalPort}/secret` });
      res.end();
    });
    const redirectorPort = await listen(redirector);
    try {
      const failure = await capturePage(session, `http://127-0-0-1.nip.io:${redirectorPort}/go`, deps({
        isResolvedAddressAllowed: (url, address) =>
          new URL(url).port === String(redirectorPort) || allowsResolvedAddress(url, address, PERSONAL),
      })).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(DriverError);
      expect((failure as DriverError).message).toMatch(/resolves to 127\.0\.0\.1/);
      expect(internalHits).toBe(0);
    } finally {
      redirector.close();
    }
  }, 60_000);

  /**
   * The half that must not break — and the half a "refuse everything" fix would
   * fail. A real public host, over real TLS, through the pinned fetch.
   */
  it("still captures a legitimate public https page", async () => {
    const page = await capturePage(session, "https://example.com/", deps());
    expect(page.url).toBe("https://example.com/");
    expect(page.bodyText).toContain("Example Domain");
  }, 60_000);
});
