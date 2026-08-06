// The other half of resolve-then-pin: the connections this process does NOT
// make itself.
//
// THE GAP THIS CLOSES (the last two open SSRF paths, carried out of P6).
// `./pinned-navigation.ts` pins a main-frame GET because the navigation guard
// fetches that hop in-process. Two kinds of request were never pinned, because
// Chromium makes them:
//
//   1. a NON-GET navigation — in practice the submit POST. The guard checks the
//      policy and resolves the host, then hands the URL back to Chromium, which
//      RESOLVES IT AGAIN to open the socket. Two lookups with a gap between
//      them is a TOCTOU window, and an attacker who controls the zone chooses
//      what the second answer is (DNS rebinding).
//   2. every SUBRESOURCE — an image, a stylesheet, an XHR. These were not
//      host-checked at all. They cannot return a body to the app, so one
//      reaching an internal address is a blind request rather than a read, but
//      it is still an unintended outbound request to an internal address.
//
// WHY A PROXY RATHER THAN A PIN AT LAUNCH. The obvious alternative is
// Chromium's `--host-resolver-rules=MAP <host> <address>`, which forces its
// resolver to an address this process already vetted. It is cheaper, but it is
// a LAUNCH flag: the target would have to be known and resolved before the
// browser starts, and a host discovered mid-flight — a redirect hop, a
// subresource on a third host — would not be covered by a rule scoped to the
// original name. This proxy sees every connection Chromium opens, including
// those, and applies the same range table to each.
//
// WHAT MAKES IT A PIN AND NOT MERELY ANOTHER CHECK. When a proxy is configured,
// Chromium does not resolve the destination at all — it hands the NAME to the
// proxy. So this module performs the only lookup there is, judges every address
// it answers with, and dials one of exactly those addresses (`pinnedLookup`).
// One resolution, one connection, one process: there is no second answer for a
// rebinding response to land in.
//
// WHAT IT DELIBERATELY DOES NOT DO. It applies the ADDRESS policy
// (`isInternalAddress`, via the caller's `ResolvedAddressPolicy`) and not the
// workspace's navigation allow-list. A page's stylesheets, fonts and images
// legitimately live on hosts the workspace would never be allowed to NAVIGATE
// to, and refusing them would break rendering for no security gain — the gap
// being closed here is "an outbound request to an internal address", which is
// exactly what the address table answers. Navigations keep both layers: the
// guard in ./driver.ts still judges the allow-list per hop before anything is
// requested.
//
// It also never inspects TLS. An `https://` target arrives as `CONNECT
// host:443` and is tunnelled byte-for-byte once the address is vetted, so the
// certificate and SNI are still negotiated end to end between Chromium and the
// origin. Nothing here is a man in the middle; it is a socket with an opinion
// about where it may be dialled.
import type { LookupAddress } from "node:dns";
import {
  createServer, request as httpRequest,
  type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse,
} from "node:http";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { isInternalAddress } from "@careerhq/autoapply/policy";
import { pinnedLookup, resolveNavigationTarget, type ResolvedAddressPolicy } from "./pinned-navigation.js";

/**
 * A running proxy, and the handle the session uses to point it at the policy of
 * whatever call is currently driving the browser.
 */
export interface VettingProxy {
  /** `http://127.0.0.1:<port>` — what Playwright's `proxy.server` takes. */
  readonly server: string;
  /**
   * The address policy every connection is judged by from now on. The driver
   * sets it from the same expression its navigation guard uses, so the two
   * enforcement points cannot disagree about an address.
   */
  setPolicy(policy: ResolvedAddressPolicy): void;
  close(): Promise<void>;
}

/**
 * What a session that was never told a policy enforces: no internal address at
 * all. Silence is the STRICT direction here, exactly as it is for
 * `DriverDeps.isResolvedAddressAllowed` — a caller gains an exemption only by
 * asking for one.
 */
const REFUSE_INTERNAL: ResolvedAddressPolicy = (_url, address) => !isInternalAddress(address);

/**
 * How long an upstream connection may sit idle before it is abandoned. Not a
 * policy knob: it exists so a wedged origin cannot pin a socket (and a Chromium
 * request) open for the life of the session. Chromium applies its own,
 * shorter, budget to everything it asks for.
 */
const UPSTREAM_IDLE_MS = 60_000;

/**
 * Headers that describe THE HOP rather than the message, and must not be
 * forwarded. `content-length` is deliberately NOT here — unlike
 * `pinnedFetch`, which builds its own request, this forwards a body Chromium
 * framed, and dropping its length would re-frame it. `host` is dropped because
 * `http.request` re-derives it from the URL, which is the name, not the pinned
 * address.
 */
const HOP_BY_HOP = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

function forwardableHeaders(headers: IncomingMessage["headers"]): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

/** A refusal Chromium renders as an ordinary failed request, with no body worth reading. */
function refuse(res: ServerResponse, reason: string): void {
  res.writeHead(403, { "content-type": "text/plain" });
  res.end(reason);
}

/**
 * Start a proxy on the loopback interface. The port is ephemeral and the
 * address is 127.0.0.1 — it is reachable only by the browser this process
 * launched, and only for as long as that browser lives.
 */
export async function startVettingProxy(): Promise<VettingProxy> {
  let policy: ResolvedAddressPolicy = REFUSE_INTERNAL;
  // Every socket the proxy owns, so `close()` can end them: `server.close()`
  // waits for open connections, and a tunnelled CONNECT is open by definition.
  const sockets = new Set<Socket>();
  const track = (socket: Socket): void => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };

  /** Resolve, judge every address, and hand back the vetted list — or why not. */
  const vet = async (
    rawUrl: string,
  ): Promise<{ ok: true; addresses: LookupAddress[] } | { ok: false; reason: string }> => {
    const outcome = await resolveNavigationTarget(rawUrl, policy);
    if (outcome.kind === "pinned") return { ok: true, addresses: outcome.addresses };
    if (outcome.kind === "refused") {
      return { ok: false, reason: `${rawUrl} resolves to ${outcome.address}, which is on an internal network` };
    }
    return { ok: false, reason: `${rawUrl} does not resolve` };
  };

  const server = createServer();

  // --- plain http: an absolute-URI request this proxy forwards itself --------
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const rawUrl = req.url ?? "";
      // A proxy is only ever sent absolute URIs. An origin-form path means
      // something addressed this port directly, which is not a thing to serve.
      if (!/^https?:\/\//i.test(rawUrl)) {
        refuse(res, "this port only proxies absolute http(s) URLs");
        return;
      }

      const vetted = await vet(rawUrl);
      if (!vetted.ok) {
        refuse(res, vetted.reason);
        return;
      }

      const upstream = httpRequest(rawUrl, {
        method: req.method,
        headers: forwardableHeaders(req.headers),
        // THE pin: the socket is dialled at an address judged a moment ago in
        // this process, and the name is never resolved again.
        lookup: pinnedLookup(vetted.addresses),
        // No pooling: a pooled socket is keyed by host and port, so a later
        // request could ride one opened for a different vetted answer.
        agent: false,
      });
      upstream.setTimeout(UPSTREAM_IDLE_MS, () => upstream.destroy(new Error("upstream timed out")));
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end();
      });
      upstream.on("response", (upstreamRes: IncomingMessage) => {
        res.writeHead(upstreamRes.statusCode ?? 502, forwardableHeaders(upstreamRes.headers));
        upstreamRes.pipe(res);
      });
      req.on("error", () => upstream.destroy());
      req.pipe(upstream);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end();
    });
  });

  // --- https (and anything else tunnelled): CONNECT host:port ---------------
  server.on("connect", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    track(clientSocket);
    clientSocket.on("error", () => clientSocket.destroy());
    void (async () => {
      let target: URL;
      try {
        // CONNECT carries an authority, not a URL; the scheme is only there so
        // the policy sees the shape it judges (an https origin, with its port).
        target = new URL(`https://${req.url ?? ""}`);
      } catch {
        clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        return;
      }

      const vetted = await vet(target.toString());
      if (!vetted.ok) {
        clientSocket.end(`HTTP/1.1 403 Forbidden\r\n\r\n${vetted.reason}`);
        return;
      }

      const upstream = netConnect({
        host: target.hostname.replace(/^\[|\]$/g, ""),
        port: Number(target.port === "" ? "443" : target.port),
        lookup: pinnedLookup(vetted.addresses),
      });
      track(upstream);
      upstream.setTimeout(UPSTREAM_IDLE_MS, () => upstream.destroy());
      upstream.on("error", () => {
        clientSocket.destroy();
        upstream.destroy();
      });
      upstream.on("connect", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        // From here this is a pipe: the TLS handshake inside it is Chromium's
        // and the origin's, so SNI and certificate verification are untouched.
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      clientSocket.on("close", () => upstream.destroy());
    })().catch(() => clientSocket.destroy());
  });

  // A websocket handshake sent in origin form rather than through CONNECT is
  // not something an application form needs, and tunnelling it would mean a
  // second, differently-shaped connection path to keep honest.
  server.on("upgrade", (_req: IncomingMessage, socket: Socket) => {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });

  server.on("connection", track);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    server: `http://127.0.0.1:${port}`,
    setPolicy: (next: ResolvedAddressPolicy) => {
      policy = next;
    },
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
        sockets.clear();
      });
    },
  };
}
