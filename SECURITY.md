# Security

CareerHQ acts on a job seeker's behalf: it stores personal facts, holds mailbox
credentials, sends email, and drives a browser against third-party application
forms. Every one of those is a way to do something irreversible to someone's
real job search. This document describes what protects them, what does not, and
what is deliberately left open.

## Reporting a vulnerability

Open a GitHub issue for anything non-sensitive. For something exploitable,
contact the maintainer directly rather than filing publicly.

## The credential master key

`CAREERHQ_MASTER_KEY` is a base64-encoded 32-byte key used with libsodium's
`crypto_secretbox` to seal SMTP/IMAP passwords at rest
(`packages/db/src/crypto.ts`). Sealed blobs are `nonce || box`, stored in
`credentials.ciphertext`.

**One key per deployment.** CareerHQ has no user accounts — it is single-user
and self-hosted — so the key is per *installation*, not per person. Generate
your own and never share it between installs:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

The key is what stands between your mailbox password and anyone holding a copy
of your database — not only a live one, but a `pg_dump`, an old backup, a copied
volume, or a snapshot on a disk you have thrown away. A shared or default key
would make every one of those artifacts readable by anyone with this repository.

Properties the implementation guarantees:

- **No default and no fallback.** Unset, `masterKey` is `null` and email
  connections are disabled outright. Nothing degrades to plaintext.
- **Length is validated twice, independently** — in `packages/config` against a
  plain 32-byte check, and again in `packages/db/src/crypto.ts` against
  libsodium's own `crypto_secretbox_KEYBYTES`, so the two cannot silently drift.
- **Opening never returns garbage.** A wrong key, a truncated payload, or a
  tampered ciphertext all raise `CryptoError`. Callers must not catch it and
  continue.

**Rotation is destructive.** `crypto_secretbox_open_easy` cannot distinguish a
wrong-but-well-formed key from tampering, so changing `CAREERHQ_MASTER_KEY`
makes every existing sealed credential permanently unopenable. To rotate, either
re-enter each connection's password afterwards, or run a migration that opens
every credential under the old key and re-seals it under the new one *before*
retiring the old key. Do not change this value casually.

### The hosted demo's key is public on purpose

The hosted demo ships with a fixed key:

```
OzZdiB1qt0pWEwQJz3gUO/NfITgm/7QA76cur9qI6cc=
```

This is published deliberately and is safe **only** because of what it protects:
a single fictional password for a Mailpit mailbox that cannot deliver to anyone,
inside a sandbox workspace, on a deployment where sending is gated off by three
independent mechanisms. It exists so the demo's email panel is explorable rather
than blank, and so this repository's encryption path is exercised by the demo
rather than stubbed out.

**Never reuse this key.** It is not an example to copy, and it must not appear in
any deployment that holds a real credential. Generate your own with the command
above.

## Acting on the outside world

Three independent mechanisms gate anything that leaves the machine. They are
deliberately redundant — each has caught a real bug during development.

1. **Environment gates**, default off. `SUBMISSIONS_LIVE_EMAIL` and
   `SUBMISSIONS_LIVE_SITE` must be explicitly enabled.
2. **Sandbox adapter blocks.** A sandbox workspace can only reach the configured
   safe destinations (Mailpit, the bundled fictional ATS). `SANDBOX_FORCE_SAFE`
   forces this path regardless of the workspace's own kind, as a hard override.
3. **Per-application confirmation.** A single-use, sha256-hashed token with a
   10-minute TTL, requiring the exact target retyped and a byte-identical
   payload fingerprint. A pending receipt is written transactionally *before*
   the mutation; a confirmed receipt only after evidence. Ambiguous outcomes
   become `NEEDS_RECONCILE` and are never retried automatically.

Consent fields (legal attestations, criminal-history questions) are never
answered by the model, never reused across applications, and never pre-ticked —
only the user's own click sets `source: "user"` into the fingerprinted payload.

## The hosted demo

The public demo runs with `DEMO_MODE=true`, which resolves a sandbox workspace,
refuses credential creation server-side, rate-limits mutating actions, and
rebuilds itself from a fixed seed every six hours. Visitors cannot configure a
real mailbox or reach a real employer.

CV upload is the one action that turns an anonymous request into bytes on the
host's disk, so it carries a ceiling as well as a rate: 2 MB per file and a
64 MB / 100-file cap on the demo's whole CV store, with unreferenced files
reclaimed on the next upload after a reset (`apps/web/src/lib/cv-storage.ts`).
A rate alone would bound how often a visitor writes, not how much they
accumulate. Outside demo mode only the 5 MB per-file cap applies — a
self-hosted install owns its own disk.

For those numbers to be the ones that decide, they have to sit *inside* the
framework's own request bound: Next rejects a server-action body over
`experimental.serverActions.bodySizeLimit` before any of this code runs, and
its default of 1 MB silently pre-empted both caps. That limit is set to 6 MB in
`apps/web/next.config.ts`, above the 5 MB per-file cap plus multipart overhead,
so an oversized CV comes back as a sentence in the upload form rather than as
an HTTP 413 and a blank error page. Raising a per-file cap means raising that
first.

Auto-apply evidence screenshots are the other disk write a visitor can reach,
from both the web app (`site-screenshots/`) and the worker's queue variant
(`autoapply/`). They share one 64 MB / 200-file ceiling, reserved *before* the
submit click so a full store refuses a submission rather than losing the
evidence of one, and reclaimed by the same collector — every file no attempt
receipt or form snapshot points at, aged past a five-minute grace window
(`packages/core/src/storage/index.ts`). Also demo-only: a self-hoster's
screenshots are the records of applications they really made, and nothing here
deletes them.

## Known limitations

Stated plainly rather than omitted.

- **DNS-name SSRF is not fully closed.** The auto-apply capture path refuses
  non-`http(s)` URLs and literal-IP hosts in the loopback, link-local, private,
  unspecified, CGNAT, benchmarking and IPv6-translation ranges, and it applies
  that policy to *every* navigation — the submitted URL and each redirect hop,
  judged from the `Location` header before the hop is requested. The check is
  on the *literal* host, so a DNS name that resolves to a private address still
  passes; `SANDBOX_SITE_ALLOWED_HOST` limits which names a sandbox workspace
  may use at all, but a personal install can be pointed at any name. Closing it
  properly requires resolve-then-pin: resolve the name, reject the resolved
  address, and connect to the pinned IP so it cannot be re-resolved in between.

  An earlier version of this entry said the hosted demo was unaffected because
  its host allow-list is a separate, earlier layer. That was **wrong**: until
  the redirect fix, one `302` from the allow-listed host to `127.0.0.1` walked
  straight through the allow-list, and it was proven doing so. The allow-list
  narrows which *first* host may be visited; it never constrained where that
  host could send the browser next. It does now, because the same policy is
  re-applied at each hop rather than once at the door.

  Two residual gaps in the same area, stated rather than implied:
  the redirect chain is walked for `GET` navigations only — a non-`GET`
  navigation (the submit POST) is policy-checked on its target and then
  backstopped by a landed-URL assertion *after* the click, so an off-policy
  redirect there is caught before any content is read but after the form was
  sent; and a sandbox workspace pointed at `localhost` by
  `SANDBOX_SITE_ALLOWED_HOST` may reach any *port* on that host, since the
  allow-list names a host and not an origin.
- **Live-page re-verification before typing is not implemented.** The driver
  fills from the form snapshot captured at review time and re-extracts at submit
  time, but does not verify that the field under a given selector still asks the
  question the user reviewed. A page edited between review and submit could
  receive an answer planned for a different field.
- **Rate limiting is per-process and per-action, not per-visitor.** One
  aggressive visitor consumes the shared budget for everyone.
- **There is no authentication.** CareerHQ assumes a single trusted operator on
  a private deployment. Do not expose an instance holding real data to the
  internet without putting your own authentication in front of it.
