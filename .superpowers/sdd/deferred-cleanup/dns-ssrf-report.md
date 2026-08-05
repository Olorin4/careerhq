# DNS-name SSRF — resolve-then-pin, and the allow-list origin

Branch `feature/deferred-cleanup`, worktree `.claude/worktrees/deferred-cleanup`,
baseline `7e47c63`. Closes the last open SSRF item carried out of P6, and the
allow-list-names-a-host item beside it.

## What was wrong

`refuseCaptureTarget` judged the **literal** host. `evil.example` with an A
record of `169.254.169.254` passed every layer — protocol, range table, and (in
a personal workspace) the allow-list, which does not run there at all — and the
driver then pointed Chromium at it. Proven at the driver level against real
public DNS, using the same `nip.io` trick the P6 review used.

## What was built

**One predicate, two questions.** `isInternalAddress` (new, in
`packages/autoapply/src/target-policy.ts`) judges a literal address through the
*same* `isInternalIpv4`/`isInternalIpv6` tables `isInternalHostname` uses. It
differs in one way only: it fails **closed** — a resolver answer that does not
parse as an address is refused, where an unparseable *host* is just an ordinary
DNS name. A zone id (`fe80::1%eth0`) is stripped before parsing, so a
link-local answer is judged as link-local rather than as "not an address".
`allowsResolvedAddress` wraps it with the workspace exemption. The
"one policy, one copy" source scan in `target-policy.test.ts` now pins the new
definitions too, so a second copy of any of this fails the suite.

**Resolve, then pin — inseparably** (`apps/worker/src/autoapply/pinned-navigation.ts`,
new). For every navigation the driver's route guard already sees (the initial
one and every redirect hop):

1. `resolveNavigationTarget` resolves the hostname with `dns.lookup` — the
   *system* resolver, because that is what Chromium would have used and what
   reads `/etc/hosts` — and refuses unless **every** A and AAAA answer passes.
   Not the first answer: which address a socket gets is resolver ordering,
   Happy Eyeballs and the attacker's choice, not ours.
2. `pinnedFetch` then makes the request itself over a socket whose `lookup`
   answers from that vetted list and never consults the resolver again. The URL
   keeps its hostname, so `Host`, TLS SNI and certificate verification are still
   the name's — only the dialled address is pinned.

Step 2 is why this exists at all. A check without a pin is a TOCTOU window
(DNS rebinding) wearing the costume of a fix. The guard already took main-frame
GET redirect chains away from Chromium, but it fetched them with `route.fetch`,
which runs in the **Playwright driver process**, where this process's resolver
cannot be substituted; that call is now an in-process request, which is the only
place the pin can be applied.

**Where the exemption lives.** `allowsResolvedAddress` exempts exactly what the
literal check already exempts: a sandbox workspace's one allow-listed origin.
That is not a hole — in a sandbox, layer 3 has already pinned every navigation
and every hop to an operator-configured origin, so no caller-supplied name
reaches the check. In a personal workspace, where the host *is* caller-supplied
and there is no allow-list, every resolved address is judged.

**`DriverDeps.isResolvedAddressAllowed` is optional; silence is the strict
direction.** A caller that passes nothing gets `defaultAddressPolicy`, which
refuses every internal address unless the caller's own predicate already allows
that address written literally, or the literal host is an allow-listed internal
name (`localhost`). Optional rather than required because
`apps/worker/src/jobs/autoapply.ts` is another agent's file this hour — see
"Disclosed" below.

**The allow-list is an origin comparison now.** `matchesSandboxAllowList`
compares scheme + host + port and accepts `demo-ats`, `demo-ats:3001` or
`http://demo-ats:3001`. The confirm-time gate (`sandboxTargetAllowed` in
`site-submission.ts`) uses the same predicate against `payload.url` instead of
comparing `payload.host`, so a port cannot slip past it either; the *retyped*
target is still a hostname, because a human retypes a hostname.

## Evidence

### The exploit, at the driver, against `git show 7e47c63:…/driver.ts`

The "before" column is the real shipped driver, restored verbatim from the
baseline commit into the tree for the run and deleted afterwards. A local HTTP
server on loopback served a secret; the target was `http://127-0-0-1.nip.io:PORT/secret`,
a real public hostname whose A record is `127.0.0.1`, in a **personal** workspace.

```
== the literal policy layer, unchanged ==
  refuseCaptureTarget: null (ALLOWED — the literal host is a public name)
  isInternalAddress('127.0.0.1'): true

== BEFORE (driver.ts @ 7e47c63) ==
  landed: http://127-0-0-1.nip.io:42261/secret
  bodyText contains the loopback-only secret: true
  requests the loopback server received: 1

== AFTER (resolve-then-pin) ==
  refused: refusing to open http://127-0-0-1.nip.io:42261/secret: it resolves to
           127.0.0.1, which is on an internal network
  requests the loopback server received: 0

== AFTER — a redirect HOP onto a private-resolving name ==
  refused: refusing to open http://127-0-0-1.nip.io:42261/secret: it resolves to
           127.0.0.1, which is on an internal network
  requests the loopback server received: 0

== AFTER — a legitimate public host over real TLS ==
  landed: https://example.com/
  bodyText mentions 'Example Domain': true
```

`internalHits: 0` is the load-bearing number, as in the P6 redirect suite: not
"we did not return the secret" but "we never asked for it".

Committed as `apps/worker/src/autoapply/pinned-navigation.test.ts` (17 tests),
which skips cleanly without Chromium or public DNS.

### The same exploit through a real `next start`

A green vitest run resolves through Node; Next compiles server actions through a
separate webpack pass, and two real bugs shipped through a fully green gate that
way in P6. So both halves were driven through the built app with Playwright,
against `TEST_DATABASE_URL` and the real `demo-ats` on 3001.

Personal workspace, `prepareSiteApplicationAction`, target
`http://127-0-0-1.nip.io:3001/greenhouse/jobs/eng-1` (a name resolving to the
loopback address demo-ats actually listens on):

```
the application page could not be read: refusing to open
http://127-0-0-1.nip.io:3001/greenhouse/jobs/eng-1: it resolves to 127.0.0.1,
which is on an internal network
```

Same server, `https://example.com/` — read fine, and paused on *parse failure*
("no fields found"), i.e. the pinned fetch fetched a real public HTTPS page:

```
Paused — Parse failure … (detected: no fields found at https://example.com/)
```

Sandbox workspace with the **origin-pinned** allow-list
(`SANDBOX_SITE_ALLOWED_HOST=http://localhost:3001`, `SANDBOX_FORCE_SAFE=true`,
`DEMO_MODE=true`), target `http://localhost:3001/greenhouse/jobs/eng-1`:

```
Reviewing http://localhost:3001/greenhouse/jobs/eng-1
17 fields · 11 need you
Step 1 of 3
```

The demo still works, on the strict spelling.

### Gate

Run against `postgres://careerhq:careerhq@localhost:5433/careerhq_dc1`, with
demo-ats up on 3001 and Chromium available, so nothing skipped:

| command | result |
| --- | --- |
| `pnpm typecheck` | 21 tasks, green |
| `pnpm lint` | 11 tasks, green |
| `pnpm test` | 21 tasks, **1132 tests, 0 failures** |
| `pnpm build` | 11 tasks, green |
| `pnpm depcruise` | no violations (717 modules, 2161 dependencies) |

Baseline was 1013. Of the +119, **94 are this branch's**: `target-policy.test.ts`
112 → 189 (measured by running the baseline file), plus 17 new in
`pinned-navigation.test.ts`. The remaining 25 belong to the other agent working
in this same tree. Suites that matter most, individually:
`@careerhq/worker` 144/144 (including `driver.test.ts`'s 48 — the live demo-ats
capture and the whole redirect-guard suite, both now running through the pinned
fetch), `@careerhq/web` 199/199 (including `site-e2e.test.ts`'s 9 real
db + real Chromium + real demo-ats flows), `@careerhq/autoapply` 256/256.

## Disclosed rather than silently resolved

1. **The worker's queue capture path gets the strict default, not the sandbox
   exemption.** `apps/worker/src/jobs/autoapply.ts` (another agent's file this
   hour) passes only `isNavigationAllowed`, so it falls back to
   `defaultAddressPolicy`. Under Compose, where the allow-listed target is the
   *name* `demo-ats` and its address is private by design, that path would now
   refuse. It is unreachable today — neither consumer is registered — and the
   fix is one line: pass `allowsResolvedAddress` beside `allowsCaptureTarget`,
   exactly as `apps/web/src/lib/site-driver.ts` does. Added to the carried list
   in `docs/roadmap.md`, next to the existing hard precondition on registering
   those consumers.
2. **Non-GET navigations and subresources are checked but not pinned.** Chromium
   makes those connections itself and resolves the name a second time, so a
   rebinding answer in that window is not caught. Closing it means replaying a
   multipart POST through the guard's own fetch, which risks submitting an
   application twice — the same trade the redirect walk already refused.
   Subresources are not host-checked at all (they never were); they cannot
   return a body to the app.
3. **The shipped Compose values still name a bare host.** The comparison is now
   an origin comparison, but `SANDBOX_SITE_ALLOWED_HOST=demo-ats` in both
   Compose files (and as the `packages/config` default) matches any port on that
   service. Rejecting the bare spelling would break every existing deployment,
   and `packages/config` — another agent's territory this hour — is where the
   default lives. `.env.example`, README's env table and the local demo recipe
   now show the port-pinned spelling, and `site-e2e.test.ts` runs it. The
   Compose files were left alone deliberately: a stricter value there is one
   this branch could not verify against a running stack, and the demo's
   `demo-ats` container publishes only 3001 anyway.
4. **Multiple `Set-Cookie` headers are newline-joined** into the single string
   `route.fulfill` accepts. `demo-ats` sets no cookies, so nothing in this repo
   exercises it; a real ATS that sets several cookies on a *navigation* response
   is the untested case.
5. **A response body is buffered in this process** (32 MB ceiling, then the
   request is abandoned) where Chromium would have streamed it. `route.fetch`
   buffered too, but in the Playwright driver process.
6. **Refusal text now names the resolved address** ("it resolves to 127.0.0.1"),
   which tells the person who supplied the name what their own name resolves to.
   Judged worth it for diagnosability; it says nothing about reachability.

## Files

- `packages/autoapply/src/target-policy.ts` — `isInternalAddress`,
  `matchesSandboxAllowList`, `allowsResolvedAddress`; layer 3 is an origin
  comparison; the module header documents layer 4 and why it lives elsewhere.
- `packages/autoapply/src/target-policy.test.ts` — +77 tests.
- `apps/worker/src/autoapply/pinned-navigation.ts` — new: resolve + pin.
- `apps/worker/src/autoapply/pinned-navigation.test.ts` — new: 17 tests.
- `apps/worker/src/autoapply/driver.ts` — the guard resolves and pins;
  `isResolvedAddressAllowed` and `defaultAddressPolicy`; refusal reasons.
- `apps/web/src/lib/site-driver.ts` — passes the policy-aware address predicate.
- `apps/web/src/lib/site-submission.ts` — `sandboxTargetAllowed` by origin.
- `apps/web/src/lib/site-e2e.test.ts` — runs the origin-pinned allow-list.
- `SECURITY.md`, `docs/roadmap.md`, `README.md`, `.env.example` — reconciled.
