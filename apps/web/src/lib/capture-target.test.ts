import { describe, expect, it } from "vitest";
import { loadConfig } from "@careerhq/config";
import { effectiveWorkspaceKind, isInternalHostname, refuseCaptureTarget } from "./capture-target.js";

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
  const config = (over: Record<string, string> = {}) => loadConfig({
    DATABASE_URL: "postgres://u:p@localhost:5432/careerhq", ...over,
  });

  it("passes the workspace's own kind through when SANDBOX_FORCE_SAFE is off", () => {
    expect(effectiveWorkspaceKind(config(), "personal")).toBe("personal");
    expect(effectiveWorkspaceKind(config(), "sandbox")).toBe("sandbox");
  });

  it("forces sandbox for every workspace when SANDBOX_FORCE_SAFE is on", () => {
    const forced = config({ SANDBOX_FORCE_SAFE: "true" });
    expect(effectiveWorkspaceKind(forced, "personal")).toBe("sandbox");
    expect(effectiveWorkspaceKind(forced, "sandbox")).toBe("sandbox");
  });
});
