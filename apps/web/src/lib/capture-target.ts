import type { WorkspaceKind } from "@careerhq/contracts";
import type { AppConfig } from "@careerhq/config";
import { safeExternalHref } from "./safe-url.js";

/**
 * Who the auto-apply browser is allowed to visit.
 *
 * This module is pure — no db, no fs, no browser — so the rules can be
 * table-tested exhaustively. It exists because `prepareSiteApplication` drives
 * a real headless Chromium at a caller-supplied URL: the P6 review proved an
 * anonymous demo visitor could make the server fetch `file:///etc/passwd`
 * (contents came back in `bodyText`) and `http://169.254.169.254/…` (cloud
 * metadata) while demo mode and SANDBOX_FORCE_SAFE were both ON, because the
 * sandbox host allow-list was only ever consulted at *confirm* time.
 *
 * Three independent layers, deliberately not collapsed into one check:
 *   1. protocol — http(s) only, via `safeExternalHref` (T1's parser, with its
 *      own adversarial suite), so nothing else has to know about `file:`,
 *      `javascript:`, `data:`, `blob:` or protocol-relative forms;
 *   2. internal network — literal loopback / link-local / private / unspecified
 *      addresses are refused in EVERY mode, demo or not, because a personal
 *      install driving a browser at 169.254.169.254 is a bug in every
 *      deployment, not just the public one;
 *   3. sandbox allow-list — when the effective workspace kind is sandbox, the
 *      one configured host and nothing else. This is an *additional, earlier*
 *      layer; the confirm-time gate in `evaluateSubmissionGates` is unchanged
 *      and still the authority at submit time.
 */

/** RFC 6761: `localhost` and anything under `.localhost` always mean this machine. */
const LOOPBACK_NAMES = new Set(["localhost"]);

/** A canonical dotted-quad, which is the only IPv4 shape a parsed URL's `hostname` can hold. */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4Octets(hostname: string): number[] | null {
  const match = IPV4_RE.exec(hostname);
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

/**
 * `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`,
 * `169.254.0.0/16` (link-local — the range that carries cloud metadata on AWS,
 * GCP, Azure and DigitalOcean alike) and `0.0.0.0/8` (unspecified / "this
 * network", which routes to loopback on Linux).
 *
 * Obfuscated spellings — `http://2130706433/`, `http://0x7f000001/`,
 * `http://0177.0.0.1/`, `http://127.1/` — need no special handling: the WHATWG
 * URL parser has already canonicalised every one of them to a dotted quad by
 * the time we see `hostname`. `capture-target.test.ts` pins that.
 */
function isInternalIpv4(octets: number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Expands an IPv6 literal (already stripped of its brackets) into eight
 * 16-bit hextets, or null if it is not one. Handles `::` compression and the
 * trailing-dotted-quad form; the parser hands us the compressed canonical
 * spelling, but accepting both keeps this testable on its own.
 */
function ipv6Hextets(hostname: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(hostname) || !hostname.includes(":")) return null;

  // Rewrite a trailing dotted quad as the two hextets it stands for, so the
  // rest of the parse only ever deals with colon-separated groups.
  let text = hostname;
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    const octets = ipv4Octets(text.slice(lastColon + 1));
    if (!octets) return null;
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const rest = halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : null;
  const fill = 8 - head.length - (rest?.length ?? 0);
  if (rest !== null && fill < 0) return null;
  const groups = rest === null ? head : [...head, ...Array<string>(fill).fill("0"), ...rest];

  const hextets: number[] = [];
  for (const group of groups) {
    if (group === "" || group.length > 4 || !/^[0-9a-f]+$/i.test(group)) return null;
    hextets.push(Number.parseInt(group, 16));
  }
  return hextets.length === 8 ? hextets : null;
}

/** `::1`, `::`, `fc00::/7` (unique-local) and `fe80::/10` (link-local), plus IPv4-mapped/compatible forms of any blocked v4 range. */
function isInternalIpv6(hextets: number[]): boolean {
  const first = hextets[0]!;
  if (hextets.every((h) => h === 0)) return true;
  if (hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;

  // `::ffff:a9fe:a9fe` and `::7f00:1` are 169.254.169.254 and 127.0.0.1 wearing
  // a different hat; the URL parser produces exactly these from
  // `[::ffff:169.254.169.254]` and `[::127.0.0.1]`.
  const leadingZeros = hextets.slice(0, 5).every((h) => h === 0);
  const mapped = leadingZeros && (hextets[5] === 0xffff || hextets[5] === 0);
  if (!mapped) return false;
  const high = hextets[6]!;
  const low = hextets[7]!;
  return isInternalIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
}

/**
 * Whether a URL's `hostname` names something on this machine or this private
 * network. Case- and trailing-dot-insensitive; IPv6 hostnames arrive bracketed.
 *
 * KNOWN LIMITATION — this checks the LITERAL host only. A DNS name that
 * resolves to a private address (`metadata.google.internal`, a `*.nip.io`
 * wildcard, an attacker-controlled record, or a DNS-rebinding answer that
 * changes between our check and Chromium's own lookup) still passes. Closing
 * that needs resolve-then-pin: resolve the name here, refuse the result by the
 * same table, and hand the browser the pinned IP with a Host header. That is
 * deliberately NOT attempted here — it is a separate change with its own
 * failure modes (multi-A records, IPv6 fallback, per-request DNS caching) and
 * is on the roadmap, not in this fix.
 */
export function isInternalHostname(raw: string): boolean {
  const hostname = raw.trim().toLowerCase().replace(/\.$/, "");
  if (hostname === "") return true;
  if (LOOPBACK_NAMES.has(hostname) || hostname.endsWith(".localhost")) return true;

  const octets = ipv4Octets(hostname);
  if (octets) return isInternalIpv4(octets);

  const bracketed = hostname.startsWith("[") && hostname.endsWith("]");
  const hextets = ipv6Hextets(bracketed ? hostname.slice(1, -1) : hostname);
  return hextets ? isInternalIpv6(hextets) : false;
}

/**
 * The workspace kind every safety decision must use — the one derivation, so
 * the prepare-time and confirm-time layers can never disagree about which
 * workspace this is. `SANDBOX_FORCE_SAFE` forces the sandbox path regardless
 * of what workspace resolution returned; it is deliberately independent of
 * `DEMO_MODE` (see `packages/config`).
 */
export function effectiveWorkspaceKind(config: AppConfig, workspaceKind: WorkspaceKind): WorkspaceKind {
  return config.sandboxForceSafe ? "sandbox" : workspaceKind;
}

/**
 * Whether the auto-apply browser may be pointed at `rawUrl`. Returns null when
 * it may, and a user-facing refusal reason when it may not — never throws, so
 * callers keep their existing failure shape, and never echoes anything about
 * whether the target was reachable (that distinction was itself a leak).
 */
export function refuseCaptureTarget(
  rawUrl: string,
  policy: { workspaceKind: WorkspaceKind; sandboxSiteAllowedHost: string },
): string | null {
  if (safeExternalHref(rawUrl) === null) {
    return "the application URL must be an http(s) address";
  }

  let hostname: string;
  try {
    hostname = new URL(rawUrl.trim()).hostname;
  } catch {
    return "the application URL must be an http(s) address";
  }

  // The configured sandbox host is exempt from the internal-network rule and
  // only from that rule: it is a Docker service name in compose (`demo-ats`)
  // but `localhost` when the stack runs outside compose, so the private-range
  // table would otherwise make the demo itself unreachable. Layer 3 below
  // still pins it to exactly that host in a sandbox workspace.
  if (hostname !== policy.sandboxSiteAllowedHost && isInternalHostname(hostname)) {
    return "that address is on an internal network and cannot be opened";
  }

  if (policy.workspaceKind === "sandbox" && hostname !== policy.sandboxSiteAllowedHost) {
    return `this workspace can only apply through ${policy.sandboxSiteAllowedHost}`;
  }

  return null;
}
