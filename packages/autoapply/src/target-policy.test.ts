import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  allowsCaptureTarget, effectiveWorkspaceKind, isInternalHostname, refuseCaptureTarget,
} from "./target-policy.js";

const SANDBOX_HOST = "demo-ats";

/**
 * The corner cases are the whole point of this module, so it is pinned as a
 * table rather than a handful of narrative tests — every row here is a URL an
 * anonymous demo visitor can post to `prepareSiteApplicationAction`.
 */

const INTERNAL_HOSTS: Array<[string, string]> = [
  ["localhost", "the RFC 6761 name"],
  ["LOCALHOST", "case-insensitively"],
  ["localhost.", "with a trailing root dot"],
  ["api.localhost", "and anything under .localhost"],
  ["127.0.0.1", "loopback"],
  ["127.255.255.254", "the rest of 127.0.0.0/8"],
  ["0.0.0.0", "the unspecified address"],
  ["0.1.2.3", "the rest of 0.0.0.0/8"],
  ["169.254.169.254", "link-local: the cloud metadata endpoint the review proved exploitable"],
  ["169.254.0.1", "the rest of 169.254.0.0/16"],
  ["10.0.0.1", "10.0.0.0/8"],
  ["10.255.255.255", "the top of 10.0.0.0/8"],
  ["172.16.0.1", "the bottom of 172.16.0.0/12"],
  ["172.31.255.255", "the top of 172.16.0.0/12"],
  ["192.168.1.1", "192.168.0.0/16"],
  ["[::1]", "IPv6 loopback"],
  ["[::]", "IPv6 unspecified"],
  ["[fc00::1]", "unique-local, bottom of fc00::/7"],
  ["[fdff::1]", "unique-local, top of fc00::/7"],
  ["[fe80::1]", "link-local, bottom of fe80::/10"],
  ["[febf::1]", "link-local, top of fe80::/10"],
  ["[::ffff:7f00:1]", "IPv4-mapped 127.0.0.1"],
  ["[::ffff:a9fe:a9fe]", "IPv4-mapped 169.254.169.254"],
  ["[::ffff:127.0.0.1]", "IPv4-mapped, written with a dotted quad"],
  ["[0:0:0:0:0:ffff:169.254.169.254]", "IPv4-mapped, written out in full"],
  ["[::7f00:1]", "IPv4-compatible 127.0.0.1"],
  ["", "an empty host"],
  // Added after the fix-wave review measured all six as ALLOWED (A1).
  ["100.64.0.1", "CGNAT, bottom of 100.64.0.0/10"],
  ["100.127.255.255", "CGNAT, top of 100.64.0.0/10"],
  ["198.18.0.1", "benchmarking, bottom of 198.18.0.0/15"],
  ["198.19.255.255", "benchmarking, top of 198.18.0.0/15"],
  ["192.0.0.1", "IETF protocol assignments 192.0.0.0/24"],
  ["[64:ff9b::a9fe:a9fe]", "NAT64 well-known prefix carrying the metadata address"],
  ["[64:ff9b::808:808]", "NAT64 is refused wholesale, public embedded quad or not"],
  ["[64:ff9b:1::1]", "the NAT64 local-use prefix too"],
  ["[2002:a9fe:a9fe::]", "6to4 carrying the metadata address"],
  ["[2002:808:808::]", "6to4 is refused wholesale too"],
  ["[::ffff:0:a9fe:a9fe]", "IPv4-translated 169.254.169.254"],
  ["[::ffff:0:127.0.0.1]", "IPv4-translated, written with a dotted quad"],
];

const EXTERNAL_HOSTS: Array<[string, string]> = [
  ["demo-ats", "the compose service name"],
  ["careers.northwind.example", "an ordinary public name"],
  ["8.8.8.8", "a public IPv4"],
  ["172.15.255.255", "just below 172.16.0.0/12"],
  ["172.32.0.1", "just above 172.16.0.0/12"],
  ["11.0.0.1", "just above 10.0.0.0/8"],
  ["9.255.255.255", "just below 10.0.0.0/8"],
  ["169.253.255.255", "just below 169.254.0.0/16"],
  ["169.255.0.1", "just above 169.254.0.0/16"],
  ["126.255.255.255", "just below 127.0.0.0/8"],
  ["128.0.0.1", "just above 127.0.0.0/8"],
  ["192.167.0.1", "just below 192.168.0.0/16"],
  ["192.169.0.1", "just above 192.168.0.0/16"],
  ["1.0.0.1", "just above 0.0.0.0/8"],
  ["[2001:db8::1]", "a documentation IPv6"],
  ["[fbff::1]", "just below fc00::/7"],
  ["[fec0::1]", "just above fe80::/10"],
  ["[::ffff:808:808]", "IPv4-mapped 8.8.8.8"],
  ["localhost.example.com", "a public name that merely starts with localhost"],
  ["not-localhost", "a public name that merely contains localhost"],
  ["100.63.255.255", "just below 100.64.0.0/10"],
  ["100.128.0.1", "just above 100.64.0.0/10"],
  ["198.17.255.255", "just below 198.18.0.0/15"],
  ["198.20.0.1", "just above 198.18.0.0/15"],
  ["192.0.1.1", "just above 192.0.0.0/24"],
  ["191.255.255.255", "just below 192.0.0.0/24's first octet"],
  ["[2001:db8::a9fe:a9fe]", "an ordinary IPv6 that merely embeds the metadata quad"],
  ["[::ffff:0:808:808]", "IPv4-translated 8.8.8.8 — judged on its embedded quad, like the mapped form"],
];

describe("isInternalHostname", () => {
  it.each(INTERNAL_HOSTS)("refuses %s (%s)", (hostname) => {
    expect(isInternalHostname(hostname)).toBe(true);
  });

  it.each(EXTERNAL_HOSTS)("allows %s (%s)", (hostname) => {
    expect(isInternalHostname(hostname)).toBe(false);
  });
});

describe("refuseCaptureTarget — protocol layer", () => {
  const personal = { workspaceKind: "personal", sandboxSiteAllowedHost: SANDBOX_HOST } as const;

  const NON_HTTP: string[] = [
    "file:///etc/passwd",
    "file://localhost/etc/passwd",
    "javascript:alert(1)",
    "javascript:fetch('http://169.254.169.254/')",
    "data:text/html,<script>alert(1)</script>",
    "blob:https://example.com/1234",
    "vbscript:msgbox(1)",
    "ftp://files.example.com/x",
    "chrome://settings",
    "view-source:http://example.com",
    "//example.com/protocol-relative",
    "/relative/path",
    "not a url at all",
    "",
    "   ",
  ];

  it.each(NON_HTTP)("refuses %j", (raw) => {
    expect(refuseCaptureTarget(raw, personal)).toMatch(/http\(s\)/);
  });

  it("allows an ordinary public http(s) URL outside a sandbox workspace", () => {
    expect(refuseCaptureTarget("https://careers.northwind.example/apply", personal)).toBeNull();
    expect(refuseCaptureTarget("http://careers.northwind.example/apply", personal)).toBeNull();
  });
});

describe("refuseCaptureTarget — internal-network layer", () => {
  const personal = { workspaceKind: "personal", sandboxSiteAllowedHost: SANDBOX_HOST } as const;

  // Not a demo-only rule: a personal, self-hosted install must not be usable
  // as an SSRF proxy either.
  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://[::ffff:169.254.169.254]/latest/meta-data/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://127.1/",
    "http://localhost:5432/",
    "http://10.0.0.5:8080/admin",
    "http://192.168.1.1/",
    "http://[::1]:3000/",
  ])("refuses %s even in a personal workspace", (raw) => {
    expect(refuseCaptureTarget(raw, personal)).toMatch(/internal network/);
  });

  it("still allows the configured sandbox host when it is itself a loopback name", () => {
    // The stack outside compose points SANDBOX_SITE_ALLOWED_HOST at localhost;
    // the private-range table must not make the demo itself unreachable.
    const local = { workspaceKind: "sandbox", sandboxSiteAllowedHost: "localhost" } as const;
    expect(refuseCaptureTarget("http://localhost:3001/greenhouse/jobs/eng-1", local)).toBeNull();
  });

  // Fix-wave review A3. The exemption above is what makes the outside-compose
  // demo reachable; honouring it in a PERSONAL workspace turned it into a
  // localhost port scanner, because layer 3 — the thing that pins a sandbox to
  // one host — does not run for a personal workspace at all.
  it("does not extend the loopback exemption to a personal workspace", () => {
    const local = { workspaceKind: "personal", sandboxSiteAllowedHost: "localhost" } as const;
    expect(refuseCaptureTarget("http://localhost:3001/greenhouse/jobs/eng-1", local))
      .toMatch(/internal network/);
    expect(refuseCaptureTarget("http://localhost:5432/", local)).toMatch(/internal network/);
    expect(refuseCaptureTarget("http://localhost:6379/", local)).toMatch(/internal network/);
  });
});

describe("refuseCaptureTarget — sandbox allow-list layer", () => {
  const sandbox = { workspaceKind: "sandbox", sandboxSiteAllowedHost: SANDBOX_HOST } as const;

  it("allows the configured sandbox host, port and path included", () => {
    expect(refuseCaptureTarget(`http://${SANDBOX_HOST}:3001/greenhouse/jobs/eng-1`, sandbox)).toBeNull();
  });

  it("refuses a public host that is not the sandbox host, naming what is allowed", () => {
    expect(refuseCaptureTarget("https://careers.northwind.example/apply", sandbox))
      .toBe(`this workspace can only apply through ${SANDBOX_HOST}`);
  });

  it("is not defeated by a lookalike host", () => {
    expect(refuseCaptureTarget(`http://${SANDBOX_HOST}.evil.example/`, sandbox)).not.toBeNull();
    expect(refuseCaptureTarget(`http://evil.example/?h=${SANDBOX_HOST}`, sandbox)).not.toBeNull();
    expect(refuseCaptureTarget(`http://user@evil.example/`, sandbox)).not.toBeNull();
  });
});

describe("effectiveWorkspaceKind", () => {
  it("passes the workspace's own kind through when SANDBOX_FORCE_SAFE is off", () => {
    expect(effectiveWorkspaceKind({ sandboxForceSafe: false }, "personal")).toBe("personal");
    expect(effectiveWorkspaceKind({ sandboxForceSafe: false }, "sandbox")).toBe("sandbox");
  });

  it("forces sandbox for every workspace when SANDBOX_FORCE_SAFE is on", () => {
    expect(effectiveWorkspaceKind({ sandboxForceSafe: true }, "personal")).toBe("sandbox");
    expect(effectiveWorkspaceKind({ sandboxForceSafe: true }, "sandbox")).toBe("sandbox");
  });
});

describe("allowsCaptureTarget", () => {
  const sandbox = { workspaceKind: "sandbox", sandboxSiteAllowedHost: SANDBOX_HOST } as const;

  // The driver's per-hop guard asks the question this way round. It must be
  // the SAME question — a predicate that drifted from the refusal reason is
  // exactly the second copy of the policy this module exists to prevent.
  it.each([
    `http://${SANDBOX_HOST}:3001/greenhouse/jobs/eng-1`,
    "http://127.0.0.1:9100/secret",
    "https://careers.northwind.example/apply",
    "file:///etc/passwd",
    "http://169.254.169.254/latest/meta-data/",
  ])("agrees with refuseCaptureTarget about %s", (raw) => {
    expect(allowsCaptureTarget(raw, sandbox)).toBe(refuseCaptureTarget(raw, sandbox) === null);
  });
});

/**
 * The structural half of the fix (fix-wave review A2). The policy used to live
 * in `apps/web/src/lib/capture-target.ts`, where `.dependency-cruiser.cjs`
 * makes it unreachable from apps/worker — so the worker's queue capture path
 * had no host gate at all and could not have had one without a second copy of
 * these rules. A second copy is the failure mode this test exists to catch:
 * two tables drift, and the one that drifts is the one nobody is attacking.
 *
 * Deliberately a source scan and not a mocking trick, because the thing being
 * pinned is "there is one definition in the repository", which no amount of
 * runtime assertion can establish.
 */
describe("one policy, one copy", () => {
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".git", ".turbo", "var"]);
  /** The definitions that ARE the policy — each may exist exactly once, here. */
  const DEFINITIONS = [
    /function\s+isInternalHostname\s*\(/,
    /function\s+isInternalIpv4\s*\(/,
    /function\s+isInternalIpv6\s*\(/,
    /function\s+ipv6Hextets\s*\(/,
    /function\s+refuseCaptureTarget\s*\(/,
    /function\s+effectiveWorkspaceKind\s*\(/,
    /function\s+safeExternalHref\s*\(/,
  ];

  function sourceFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) sourceFiles(full, found);
      else if (/\.tsx?$/.test(entry)) found.push(full);
    }
    return found;
  }

  it.each(DEFINITIONS)("defines %s in exactly one file", (pattern) => {
    const owners = sourceFiles(path.join(REPO_ROOT, "apps"))
      .concat(sourceFiles(path.join(REPO_ROOT, "packages")))
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(REPO_ROOT, file));
    expect(owners).toEqual([
      pattern.source.includes("safeExternalHref")
        ? path.join("packages", "autoapply", "src", "safe-url.ts")
        : path.join("packages", "autoapply", "src", "target-policy.ts"),
    ]);
  });
});
