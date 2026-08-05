# Security

CareerHQ acts on a job seeker's behalf: it stores personal facts, holds mailbox
credentials, sends email, and drives a browser against third-party application
forms. Every one of those is a way to do something irreversible to someone's
real job search. This document describes what protects them, what does not, and
what is deliberately left open.

## Reporting a vulnerability

Open a GitHub issue at <https://github.com/Olorin4/careerhq/issues> for anything
non-sensitive. For something exploitable, email **nick.kalas@proton.me** rather
than filing publicly, and please say "CareerHQ security" in the subject. This is
a single-maintainer portfolio project, not a funded programme: expect a reply
within a few days, and expect an honest answer about whether a fix is planned
rather than a silent triage queue.

Findings against the hosted demo at <https://careerhq.nickkalas.dev> are welcome.
It holds no personal data of any kind — the only real records in it are public
job advertisements, see "The hosted demo" below — so please do not spend effort
on data exfiltration there. The interesting questions are whether a visitor can
reach the outside world, escape the sandbox workspace, or cost the host more
than the demo's own caps allow.

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

**What the key does not protect against, stated as a non-goal.** Anyone with
host or root access to the machine the app runs on can read
`CAREERHQ_MASTER_KEY` out of the process environment and decrypt every stored
credential. This design defends data *at rest* against a leaked database — a
`pg_dump`, a copied volume, a stolen backup, a read-only DB credential — and
nothing else. It is not a defence against a compromised host, and there is no
HSM, no KMS and no OS keyring in the picture; ADR-0005 explains why none of
those is available in this project's actual deployment targets (a container
with no keyring, a headless VPS with no user-present session). If your host is
compromised, assume every credential on it is too.

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

The public demo is <https://careerhq.nickkalas.dev>. It runs with
`DEMO_MODE=true`, which resolves a sandbox workspace, refuses credential
creation server-side, rate-limits mutating actions, and rebuilds itself from a
fixed seed every six hours. Visitors cannot configure a real mailbox or reach a
real employer.

**The persona and everything attached to it are fictional.** "Alex Demo", the
applications and their companies, the facts, the CVs, the generated materials
and the mail are all invented for the seed. No real person's data has ever been
in that database, and the reset means nothing a visitor types survives six hours
either.

**One screen is deliberately not fictional: the discovery inbox.** The worker
runs `discovery.ingest` on the same six-hourly cron a self-hosted install uses,
against the same five keyless public feeds — Remotive, RemoteOK, Arbeitnow, We
Work Remotely and The Muse — so most of what a visitor sees scored and ranked at
`/jobs` is a **real, currently-advertised job at a real company**, sitting beside
the 30 seeded listings. That is the point: watching the scorer rank genuine
postings is worth more than uniformity, and it is the one part of the pipeline a
fixture cannot honestly stand in for. An earlier version of this section said
every record in the demo was fictional; for this screen that was false.

What that does *not* involve, stated plainly:

- **No personal data of any real person.** These feeds return public job
  advertisements — company, title, location, salary band, description, a link
  back to the posting. There is no applicant, no candidate and no named
  individual in them.
- **Read-only public GETs.** Ingestion issues HTTP `GET` to documented public
  endpoints and nothing else. It holds no account and no credential for any of
  them, posts nothing, and alters nothing. It identifies itself honestly as
  `CareerHQ/0.6 (+https://careerhq.nickkalas.dev)`
  (`packages/ingest/src/net.ts`) rather than impersonating a browser — the same
  boundary [ADR-0006](docs/adr/0006-scraping-and-tos-boundaries.md) draws.
- **Bounded, not accumulating.** Ingested listings are written into the demo
  workspace, and the six-hourly rebuild deletes that workspace row, which
  cascades to `jobs`, `companies` and `ingest_runs`. Measured locally against
  the real feeds: 39 job rows after a reset (30 seeded listings plus the nine
  jobs behind the seeded applications), 466 after one ingest run inserted 427,
  and 39 again after the next reset. A missed reset would not compound either —
  `jobs_workspace_source_external` is unique, so a second run over the same
  feeds updates rows rather than inserting them.

What a visitor **can** do: browse and edit everything, promote a discovered job,
generate grounded materials (from committed AI fixtures — `AI_MODE=replay`, with
no provider key deployed), run the whole auto-apply flow against the bundled
fictional ATS, tick a consent box, preview, confirm, and see the receipt.

What a visitor **cannot** do: configure a mailbox (the form is replaced and both
server actions refuse), send mail anywhere but the internal Mailpit sink, drive
a browser at anything but the internal `demo-ats`, spend the owner's model
tokens, keep anything past the next reset, or reach Postgres, Mailpit or
`demo-ats` at all — only the web app is published, and only on loopback behind
the edge proxy.

**There is no login, and that is deliberate for the demo specifically.** It is a
public exhibit holding no personal data, with every mutating channel shut; an
authentication wall would add a secret to protect without protecting anything.
Do not read that as a property of CareerHQ itself — see the last bullet under
"Known limitations".

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

## Deliberate exclusions

Capabilities this project will not add. They are excluded on purpose, not
missing for lack of time, and a pull request implementing one will be declined.

- **No CAPTCHA solving, and no attempt to look like a human.** A CAPTCHA, a
  login wall, an identity-verification step or a coding assessment stops the
  auto-apply attempt as `BLOCKED` with a typed reason and hands control back.
  The driver does not defeat challenges, randomise timings to evade detection,
  or forge a browser fingerprint — it identifies itself honestly and stops when
  a site says stop.
- **No automation of restricted boards in the core.** LinkedIn, Indeed,
  Glassdoor, Google Jobs and ZipRecruiter are outside the keyless-public
  boundary (ADR-0006). The optional `services/restricted-ingest` connector is
  discovery-only, lives behind its own Compose profile plus an env gate plus a
  recorded in-app consent, is never part of the demo, and never holds a
  credential or applies to anything.
- **No credentialed access to anyone's account.** CareerHQ never logs into an
  ATS, a job board or a mailbox that is not the operator's own configured SMTP/
  IMAP connection.
- **No unattended applying.** Every external mutation needs a fresh preview, a
  single-use token and the exact target retyped by a human, per attempt. There
  is no "apply to everything matching this filter" mode, and adding one would
  break the receipt design rather than extend it.
- **No consent answered on the user's behalf.** Legal attestations,
  criminal-history questions, demographics, work authorization, salary — the
  model has no code path that can fill them, and a saved answer from another
  application never satisfies one.

## Known limitations

Stated plainly rather than omitted. Everything here is also carried in
[`docs/roadmap.md`](docs/roadmap.md) with its reasoning, so nothing is quietly
dropped between phases.

- **SSRF: the main-frame capture path is closed by resolve-then-pin; two
  narrower paths are not.** The auto-apply capture path refuses non-`http(s)`
  URLs and literal-IP hosts in the loopback, link-local, private, unspecified,
  CGNAT, benchmarking and IPv6-translation ranges; it resolves every navigation
  target's hostname and refuses it unless **every** address it answers with
  passes that same range table; and it applies both to *every* navigation — the
  submitted URL and each redirect hop, judged from the `Location` header before
  the hop is requested. For a main-frame `GET` the request is then made over a
  socket dialled at the addresses that were judged, so the name cannot be
  re-resolved between the check and the fetch (`packages/autoapply/src/target-policy.ts`,
  `apps/worker/src/autoapply/pinned-navigation.ts`).

  What that closes, proven rather than argued: `127-0-0-1.nip.io` is a real
  public hostname whose A record is `127.0.0.1`. Before the fix, a capture of
  it returned a loopback-only page's contents in `bodyText` — one request
  reached the loopback server. After it, the navigation is refused with
  *"resolves to 127.0.0.1, which is on an internal network"* and the loopback
  server receives **zero** requests, on the first navigation and on a redirect
  hop alike; `https://example.com/` still captures normally through the pinned
  fetch. The probe is committed as
  `apps/worker/src/autoapply/pinned-navigation.test.ts`.

  What remains, stated rather than implied:

  - **A non-`GET` navigation and every subresource are not pinned.** They are
    policy-checked and resolution-checked, but Chromium makes those connections
    itself and resolves the name again to do it, so a rebinding answer landing
    in that window would not be caught. The submit `POST` is also not
    chain-walked — it is backstopped by a landed-URL assertion *after* the
    click. Replaying a multipart POST to close either is the trade this project
    keeps refusing: it risks submitting an application twice.
  - **Subresources are not host-checked at all** (they never were): they are
    not navigations and cannot return a body to the app, so an internal address
    reached that way is a blind request, not a read.

  An earlier version of this entry said the hosted demo was unaffected by any
  of this because its host allow-list is a separate, earlier layer. That was
  **wrong**: until the redirect fix, one `302` from the allow-listed host to
  `127.0.0.1` walked straight through the allow-list, and it was proven doing
  so. The allow-list narrows which *first* target may be visited; it never
  constrained where that target could send the browser next. It does now,
  because the same policy is re-applied at each hop rather than once at the
  door.
- **The sandbox allow-list is now an origin comparison, but its shipped value
  still names only a host.** `SANDBOX_SITE_ALLOWED_HOST` is compared as scheme
  + host + port, and accepts `demo-ats`, `demo-ats:3001` or
  `http://demo-ats:3001`. A value that names a port pins it — the fix for a
  sandbox pointed at `localhost` being able to reach Postgres, Redis and the
  app's own port on the same box — and one that names no port still matches any
  port on that host, which is what `demo-ats` (the default, and the value in
  both Compose files) does today. Pin the port explicitly for a sandbox on
  `localhost`; `.env.example` and README's env table now show that spelling.
- **Live-page re-verification now fails closed — with one hole left.** An
  earlier version of this document said re-verification "is not implemented".
  That is no longer true: before a single keystroke the driver refuses to fill a
  control unless it still has the same id, the same field-identity hash (the
  selector *and* the question beside it) and the same field kind it had when the
  user reviewed it, checked from both directions — over the live page's fields
  and over the reviewed ones. A mismatch throws pre-click, so the refusal costs
  the visitor nothing: the confirmation token is handed back unspent, the
  attempt returns to `PENDING_CONFIRMATION`, and the same token confirms again
  once the page is what was reviewed — rather than the attempt being parked as
  `NEEDS_RECONCILE`. A browser that never clicked cannot have submitted, and
  that is the whole warrant for undoing the confirmation: every *ambiguous*
  outcome still parks for a human with the token spent, because a retry there
  could produce a second application.

  What remains open: a control the user answered that **vanishes** is caught
  only within steps the page has actually rendered. "Rendered steps" is inferred
  from a single pre-click extraction, so a multi-step form whose later fields are
  *replaced* rather than revealed after "Next" would not be judged at all. The
  bundled `demo-ats` renders all its steps up front, so no committed test covers
  that shape — it is the gap most likely to matter against a real Greenhouse or
  Lever page, and no real ATS was available to probe this against.
- **Rate limiting is per-process and per-action, not per-visitor.** One
  aggressive visitor consumes the shared budget for everyone. The browser
  concurrency cap has the same shape: it is enforced per process, so the `web`
  and `worker` containers can each hold one Chromium open and the box can see
  two. A host-wide cap needs a lock outside both processes (a Postgres advisory
  lock is the obvious candidate — both already connect).
- **Eleven mutating server actions are still unthrottled**, across
  `applications/`, `facts/`, `inbox/` and `settings/actions.ts`. None is
  dangerous on a public URL: they write rows, which the six-hourly reset
  reclaims — unlike CV upload, which wrote files it did not, and is throttled.
  The gap is stated rather than papered over because a partial pass is worse
  than none: throttling one action and not its neighbour in the same file
  advertises a guarantee that file does not have.
- **Free-text fields have no length cap.** `notes`, `claim`, `detail` and the
  scoring textareas are bounded only by Next's server-action body limit — which
  this repo deliberately raised from 1 MB to 6 MB so the CV caps could be the
  ones that decide, so that implicit bound is now six times looser than it was.
- **The worker's auto-apply queue consumers must not be registered as they
  stand.** `autoapply.capture` and `autoapply.submit` are deliberately absent
  from `apps/worker/src/main.ts` (the §11 gate lives in `apps/web`, not in the
  jobs). Beyond that: in `runSubmitJob` a `writeFile` failure *after* the submit
  click throws, and pg-boss would retry the job — a second submission of an
  application that already went through. This is a hard precondition on ever
  registering those consumers, not a nice-to-have. Double submission is the
  exact failure the whole gated protocol exists to prevent.
- **A `NEEDS_RECONCILE` attempt's screenshot can be reclaimed out from under
  its own message.** The path is persisted to no row, so in demo mode the
  evidence collector deletes the file about five minutes later while the
  attempt's reason still tells the user to go and look at it. Demo-only — the
  collector does not run outside it — but it is evidence for the one outcome
  that exists because the result was ambiguous, which is when evidence matters
  most. The fix is to persist the path onto the snapshot's `recovery_state`,
  which the worker already does elsewhere.
- **There is no authentication.** CareerHQ assumes a single trusted operator on
  a private deployment. Do not expose an instance holding real data to the
  internet without putting your own authentication in front of it.
