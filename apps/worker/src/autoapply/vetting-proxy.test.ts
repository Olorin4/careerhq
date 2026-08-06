// The vetting proxy on its own, with no browser in the picture: what it
// forwards, what it refuses, and — the load-bearing one — WHERE the bytes go
// when the name says one thing and the vetted address says another.
//
// The end-to-end proof through a real Chromium, including the rebinding probe
// for the submit POST, is ./rebinding-probe.test.ts.
import { createServer as createHttpServer, request as httpRequest, type Server } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startVettingProxy, type VettingProxy } from "./vetting-proxy.js";
import type { ResolvedAddressPolicy } from "./pinned-navigation.js";

async function probeDns(): Promise<boolean> {
  try {
    const answer = await lookup("127-0-0-1.nip.io", { all: true });
    return answer.some((entry) => entry.address === "127.0.0.1");
  } catch {
    return false;
  }
}
const dnsAvailable = await probeDns();

const listen = async (server: Server | TcpServer, host = "127.0.0.1"): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return (server.address() as AddressInfo).port;
};

const ALLOW_ALL: ResolvedAddressPolicy = () => true;

interface ProxiedResponse {
  status: number;
  body: string;
}

/** One request THROUGH the proxy, in the absolute-URI form a browser uses. */
function throughProxy(
  proxyPort: number,
  target: string,
  opts: { method?: string; body?: string } = {},
): Promise<ProxiedResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: proxyPort, method: opts.method ?? "GET", path: target },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe("the vetting proxy", () => {
  let proxy: VettingProxy;
  let proxyPort = 0;
  let origin: Server;
  let originPort = 0;
  let hits = 0;
  let seen: { host?: string; method?: string; body: string }[] = [];

  beforeAll(async () => {
    origin = createHttpServer((req, res) => {
      hits += 1;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({ host: req.headers.host, method: req.method, body: Buffer.concat(chunks).toString() });
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("origin");
      });
    });
    originPort = await listen(origin);
    proxy = await startVettingProxy();
    proxyPort = Number(new URL(proxy.server).port);
  });

  afterAll(async () => {
    await proxy?.close();
    origin?.close();
  });

  beforeEach(() => {
    hits = 0;
    seen = [];
    proxy.setPolicy(ALLOW_ALL);
  });

  it("forwards an allowed request and brings the response back", async () => {
    const response = await throughProxy(proxyPort, `http://127.0.0.1:${originPort}/page`);
    expect(response.status).toBe(200);
    expect(response.body).toBe("origin");
    expect(hits).toBe(1);
  });

  it("forwards the method and the body — nothing is replayed or rewritten", async () => {
    const response = await throughProxy(proxyPort, `http://127.0.0.1:${originPort}/apply`, {
      method: "POST",
      body: "name=ada&consent=",
    });
    expect(response.status).toBe(200);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.body).toBe("name=ada&consent=");
    // Exactly one request reached the origin: a proxy that retried a POST would
    // be the very failure the §11 protocol exists to prevent.
    expect(hits).toBe(1);
  });

  /**
   * THE assertion: not "we returned an error" but "we never asked". A
   * subresource pointed at an internal address is a blind request, and the only
   * way to close it is for the request not to happen.
   */
  it("refuses an off-policy address without contacting it", async () => {
    proxy.setPolicy((_url, address) => address !== "127.0.0.1");
    const response = await throughProxy(proxyPort, `http://127.0.0.1:${originPort}/secret`);
    expect(response.status).toBe(403);
    expect(response.body).toMatch(/on an internal network/);
    expect(hits).toBe(0);
  });

  /** A session that was never told a policy refuses every internal address. */
  it("refuses internal addresses by default, before any policy is set", async () => {
    const fresh = await startVettingProxy();
    try {
      const port = Number(new URL(fresh.server).port);
      const response = await throughProxy(port, `http://127.0.0.1:${originPort}/secret`);
      expect(response.status).toBe(403);
      expect(hits).toBe(0);
    } finally {
      await fresh.close();
    }
  });

  it("answers a name that does not resolve rather than connecting to nothing", async () => {
    const response = await throughProxy(proxyPort, "http://nothing.invalid/page");
    expect(response.status).toBe(403);
    expect(response.body).toMatch(/does not resolve/);
  }, 20_000);

  it("serves nothing on its own port — it only proxies absolute URLs", async () => {
    const response = await throughProxy(proxyPort, "/");
    expect(response.status).toBe(403);
  });

  const withDns = describe.skipIf(!dnsAvailable);

  withDns("against real public DNS", () => {
    /**
     * The pin, restated for the connections Chromium makes: the URL names a
     * host, the proxy resolves it ONCE, and the socket is dialled at what that
     * one lookup said — with the NAME still in the Host header, so TLS SNI and
     * certificate verification stay honest on the tunnelled path.
     */
    it("dials the address it vetted and keeps the name in the Host header", async () => {
      const response = await throughProxy(proxyPort, `http://127-0-0-1.nip.io:${originPort}/page`);
      expect(response.status).toBe(200);
      expect(seen[0]?.host).toBe(`127-0-0-1.nip.io:${originPort}`);
    }, 20_000);

    it("refuses a public name whose A record is a private address", async () => {
      // The shipped policy, not a test one: `127.0.0.1` is on the range table.
      proxy.setPolicy((_url, address) => address !== "127.0.0.1");
      const response = await throughProxy(proxyPort, `http://127-0-0-1.nip.io:${originPort}/secret`);
      expect(response.status).toBe(403);
      expect(response.body).toMatch(/resolves to 127\.0\.0\.1/);
      expect(hits).toBe(0);
    }, 20_000);
  });
});

// ---------------------------------------------------------------------------
// CONNECT — how every https request arrives at a proxy, and the path that must
// stay a byte pipe so the certificate is negotiated end to end.
// ---------------------------------------------------------------------------
describe("the vetting proxy's CONNECT tunnel", () => {
  let proxy: VettingProxy;
  let proxyPort = 0;
  let echo: TcpServer;
  let echoPort = 0;
  let connections = 0;

  const connectThrough = (authority: string): Promise<{ line: string; socket: Socket | null }> =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: authority });
      req.on("connect", (res, socket) => resolve({ line: String(res.statusCode), socket }));
      // A refusal comes back as an ordinary response, not as a tunnel.
      req.on("response", (res) => {
        res.resume();
        resolve({ line: String(res.statusCode), socket: null });
      });
      req.on("error", reject);
      req.end();
    });

  beforeAll(async () => {
    echo = createTcpServer((socket) => {
      connections += 1;
      socket.pipe(socket);
    });
    echoPort = await listen(echo);
    proxy = await startVettingProxy();
    proxyPort = Number(new URL(proxy.server).port);
  });

  afterAll(async () => {
    await proxy?.close();
    echo?.close();
  });

  beforeEach(() => {
    connections = 0;
  });

  it("tunnels to a vetted address, passing bytes through untouched", async () => {
    proxy.setPolicy(ALLOW_ALL);
    const { line, socket } = await connectThrough(`127.0.0.1:${echoPort}`);
    expect(line).toBe("200");
    expect(socket).not.toBeNull();
    const echoed = await new Promise<string>((resolve) => {
      socket!.once("data", (chunk: Buffer) => resolve(chunk.toString()));
      socket!.write("ClientHello");
    });
    expect(echoed).toBe("ClientHello");
    socket!.destroy();
    expect(connections).toBe(1);
  });

  /**
   * Node raises `connect` for whatever a CONNECT is answered with, so the
   * status line is what says whether a tunnel exists — and `connections` is
   * what says whether the internal address was contacted, which is the
   * assertion that matters.
   */
  it("refuses an off-policy address without opening the tunnel", async () => {
    proxy.setPolicy((_url, address) => address !== "127.0.0.1");
    const { line, socket } = await connectThrough(`127.0.0.1:${echoPort}`);
    expect(line).toBe("403");
    expect(connections).toBe(0);
    socket?.destroy();
  });
});
