// Resolve-then-pin: the half of the capture policy that needs a resolver and a
// socket, and therefore cannot live in `@careerhq/autoapply/policy` with the
// rest of it.
//
// THE GAP THIS CLOSES (carried out of P6, and the last open SSRF item). The
// policy refuses non-http(s) URLs and literal private/loopback/link-local/
// CGNAT/benchmarking/IPv6-translation hosts, at every redirect hop. But it
// judges the LITERAL host, so `evil.example` with an A record of
// `169.254.169.254` walked straight through it and reached the cloud metadata
// endpoint.
//
// WHY A CHECK ALONE WOULD NOT BE A FIX. Resolving the name, judging the answer
// and then handing the URL back to something that resolves it again is a TOCTOU
// window: the second lookup is a second answer, and an attacker who controls
// the zone chooses what it is (DNS rebinding — short TTLs make it cheap and
// reliable). So the two halves are inseparable here:
//
//   1. resolve the name to EVERY address it has (A and AAAA both) and refuse
//      the navigation unless all of them pass the policy's range table;
//   2. make the request ourselves over a socket pinned to exactly those
//      addresses, by handing Node's connector a `lookup` that answers with the
//      vetted list and never consults the resolver again.
//
// Step 2 is why this module fetches at all. The driver's navigation guard
// already takes main-frame GET redirect chains away from Chromium (see
// `installNavigationGuard`) — it fetched each hop itself and fulfilled the
// response into the page. That fetch used to be `route.fetch`, which runs in
// the Playwright driver PROCESS, where our `lookup` cannot reach; the same hop
// fetched here, in-process, is the one place the pin can be applied.
//
// What this module does NOT pin: a non-GET navigation (the submit POST) and
// every subresource, because Chromium makes those connections and replaying a
// multipart POST through this fetch to take one away from it is the trade this
// project keeps refusing — it risks submitting an application twice.
//
// They are pinned all the same, one layer down. `./vetting-proxy.ts` is a
// loopback proxy the session launches Chromium behind: with a proxy configured
// Chromium does not resolve destinations at all, so that module performs the
// only lookup there is, judges every address with the caller's policy and
// dials one of exactly those — using `pinnedLookup` below. Nothing is replayed;
// the proxy sits on the live connection. Both halves therefore share this
// module's `resolveNavigationTarget`/`pinnedLookup`, which is the point of
// their living here rather than inside the guard.
import type { LookupAddress } from "node:dns";
import { lookup as resolveHost } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

/** What one navigation's hostname resolved to, and whether it may be visited. */
export type ResolveOutcome =
  /** Every address passed; connect to these and only these. */
  | { kind: "pinned"; addresses: LookupAddress[] }
  /** At least one address is off policy. `address` is the first one that was. */
  | { kind: "refused"; address: string }
  /** The name does not resolve. Not a policy answer — let the browser report it. */
  | { kind: "unresolved" };

/**
 * Whether a resolved address may be connected to for this URL. Bound by the
 * caller to its workspace policy — `allowsResolvedAddress` from
 * `@careerhq/autoapply/policy`.
 */
export type ResolvedAddressPolicy = (url: string, address: string) => boolean;

/**
 * Resolve `rawUrl`'s host and judge EVERY address it answers with.
 *
 * All of them, not the first: a name with one public and one private A record
 * is refused. Judging only the address we would have connected to leaves the
 * others reachable through nothing more than resolver ordering, Happy Eyeballs,
 * or a retry — the attacker picks which one the socket gets, not us.
 *
 * `dns.lookup` rather than `dns.resolve4`/`resolve6`, deliberately: this must
 * answer with what the SYSTEM resolver answers, because that is what Chromium
 * would have used. `resolve4` talks to the nameservers directly and would miss
 * `/etc/hosts` entirely — `localhost` would not resolve, and a hosts-file entry
 * pointing a public name at 127.0.0.1 would be judged on the wrong answer.
 * `all: true` returns both families; an IP literal is answered from the literal
 * itself without a query, which is what makes a literal host free here.
 */
export async function resolveNavigationTarget(
  rawUrl: string,
  isAddressAllowed: ResolvedAddressPolicy,
): Promise<ResolveOutcome> {
  let hostname: string;
  try {
    // An IPv6 hostname arrives bracketed from `URL`; the resolver wants it bare.
    hostname = new URL(rawUrl).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return { kind: "unresolved" };
  }

  let addresses: LookupAddress[];
  try {
    addresses = await resolveHost(hostname, { all: true, verbatim: true });
  } catch {
    return { kind: "unresolved" };
  }
  // An empty answer is not a licence to connect to nothing in particular.
  if (addresses.length === 0) return { kind: "unresolved" };

  for (const entry of addresses) {
    if (!isAddressAllowed(rawUrl, entry.address)) return { kind: "refused", address: entry.address };
  }
  return { kind: "pinned", addresses };
}

/**
 * A `lookup` that answers from a vetted list instead of the resolver. THE pin:
 * the socket connects to an address this process already judged, and the name
 * is never resolved a second time.
 *
 * Both callback shapes are honoured because Node uses both — `net.connect`
 * asks with `all: false` for a plain connect and with `all: true` under
 * `autoSelectFamily` (Happy Eyeballs, on by default since Node 20). A `family`
 * constraint is filtered rather than ignored: answering an A record to a
 * request for AAAA produces a confusing connect error instead of a connection.
 */
export function pinnedLookup(addresses: LookupAddress[]): LookupFunction {
  return ((hostname, options, callback): void => {
    const wanted = typeof options === "number" ? options : (options.family ?? 0);
    const usable = wanted === 4 || wanted === 6
      ? addresses.filter((entry) => entry.family === wanted)
      : addresses;
    const first = usable[0];
    if (!first) {
      callback(new Error(`no pinned address for ${hostname}`), "", 0);
      return;
    }
    if (typeof options === "object" && options.all === true) {
      callback(null, usable as never, 0);
      return;
    }
    callback(null, first.address as never, first.family);
  }) as LookupFunction;
}

/** A response read in full, ready to be handed to `route.fulfill`. */
export interface PinnedResponse {
  status: number;
  /** Hop-by-hop headers removed; `set-cookie` collapsed to a newline-joined value. */
  headers: Record<string, string>;
  body: Buffer;
}

export interface PinnedFetchOptions {
  /** The requesting page's own headers, as Playwright reports them. */
  headers: Record<string, string>;
  /** The vetted addresses from `resolveNavigationTarget`. */
  addresses: LookupAddress[];
  timeoutMs: number;
}

/**
 * A response bigger than this is abandoned rather than buffered. A navigation
 * body lands in this process's heap, so an unbounded read is a remote party
 * choosing how much memory the demo box uses; the browser would have streamed
 * it. Generous enough that no real application page comes near it.
 */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * Headers that describe THIS connection rather than the message. Forwarding
 * them is how a proxy corrupts a request: `host` must be re-derived from the
 * URL (Node does that), and `accept-encoding` is dropped so the body we hand
 * the browser needs no decoding pass here.
 */
const HOP_BY_HOP = new Set([
  "host", "connection", "keep-alive", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length", "accept-encoding",
]);

/**
 * One request, one hop, over a socket pinned to `addresses`. No redirect is
 * followed: the caller judges the `Location` header first — that is the whole
 * design of the navigation guard, and following one here would walk past it.
 *
 * The URL keeps its hostname, so the `Host` header and the TLS SNI/certificate
 * check are still the name's. Only the ADDRESS the socket dials is pinned;
 * rewriting the URL to the IP instead would have meant either a wrong Host
 * header or a certificate that cannot be verified.
 */
export async function pinnedFetch(rawUrl: string, opts: PinnedFetchOptions): Promise<PinnedResponse> {
  const url = new URL(rawUrl);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;

  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(opts.headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
  }

  return await new Promise<PinnedResponse>((resolve, reject) => {
    const req = send(
      url,
      {
        method: "GET",
        headers,
        lookup: pinnedLookup(opts.addresses),
        timeout: opts.timeoutMs,
        // No connection pooling: a pooled socket is keyed by host and port, so
        // a later request could ride one opened for a different vetted answer.
        // Correct today either way — every socket in the pool was pinned to a
        // vetted address — but "correct because of how the agent happens to
        // key its pool" is not a property worth depending on.
        agent: false,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            res.destroy();
            reject(new Error(`response from ${rawUrl} exceeded ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: responseHeaders(res),
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`timed out opening ${rawUrl}`));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * `route.fulfill` takes one string per header, so multiple `Set-Cookie` lines
 * are joined with a newline — the spelling Chromium splits back into separate
 * cookies. `content-length` and the hop-by-hop headers are dropped: Playwright
 * recomputes the length from the body we hand it, and the rest describe a
 * connection the browser is not making.
 */
function responseHeaders(res: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    headers[name] = Array.isArray(value) ? value.join("\n") : value;
  }
  return headers;
}
