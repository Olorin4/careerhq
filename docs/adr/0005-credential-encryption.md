# ADR-0005: App-level libsodium secretbox for stored mail credentials, not an OS keyring

**Status:** Accepted
**Date:** 2026-08-03
**Phase:** P4

## Context

P4 (spec §11) is the first feature that asks Career HQ to hold a real secret at rest: an SMTP/IMAP password for a connected mailbox, stored so the worker can send and poll on the user's behalf between requests. Spec §13's threat model is explicit about what this app can and cannot promise a self-hosted, source-available deployment: there is no dedicated secrets-management infrastructure, and the deployment targets are a `docker compose up` on someone's own machine or VPS and, later, a shared hosted demo — both of which run as a normal OS user inside a normal container, not behind an HSM or a managed KMS.

An early (spec-v0.2-era) idea was to lean on the host OS's keyring (macOS Keychain, GNOME Keyring, Windows Credential Manager) instead of encrypting anything in the app. That is infeasible for this project on its own terms: a Docker container has no keyring to talk to, a web server process serving requests to a browser has no user-present session to authorize keyring access, and a VPS running headless has no desktop session at all. Any design that depends on an OS keyring simply does not run in this project's actual deployment targets, so the credential has to be protected as *application state*, not delegated to the platform.

## Decision

Encrypt every stored mailbox credential with `crypto_secretbox` (libsodium, `packages/db/src/crypto.ts`'s `sealSecret`/`openSecret`) under a single symmetric key supplied at runtime by `CAREERHQ_MASTER_KEY` (`packages/config`) — never generated or stored by the app itself, and never committed. `generateMasterKeyB64` / the documented `node -e "crypto.randomBytes(32)..."` one-liner are the only way to obtain one. The `credentials` table stores only a nonce-prefixed ciphertext blob (`sealSecret`'s `nonce || box`, a bytea column) and nothing plaintext-adjacent — no password hint, no last-four, no recoverable fragment. Decoding a credential requires the exact runtime key; a wrong key or a tampered blob both surface as the same `CryptoError` (`crypto_secretbox_open_easy` cannot distinguish the two), so the code path never falls back to trusting a partially-verified payload.

Every surface that can expose adapter or transport errors — the settings connection test, IMAP sync's health-status write, the SMTP send failure path — routes through `redactError` (`packages/email/src/redact.ts`) before the message is stored or rendered: every secret the caller knows about is string-scrubbed, plus two structural heuristics (`AUTH PLAIN`/`AUTH LOGIN` blobs, any other long base64-looking run) catch a credential a caller didn't think to name explicitly. Disconnecting a mailbox (`deleteEmailConnection`, `packages/db/src/repos/email-connections.ts`) deletes the connection row and both its credential rows in one transaction — there is no "soft disconnect" that leaves a decryptable secret behind with nothing pointing at it.

## Consequences

- **Positive:** a database dump, backup file, or read-only DB credential leak is worthless without `CAREERHQ_MASTER_KEY` — the ciphertext-only design means the most likely leak vector (the Postgres volume) discloses nothing on its own.
- **Positive:** no partial-trust code path exists — `openSecret` either returns the exact plaintext or throws; nothing decrypts to garbage that gets treated as a password.
- **Trade-off, accepted:** the master key is one env var protecting every credential in the workspace; a stronger design (per-credential keys, key rotation, an external KMS) was rejected as disproportionate to a single-owner, self-hosted app and deferred past P4.
- **Honest scope — what this does NOT protect against:** anyone with host or root access to the machine `CAREERHQ_MASTER_KEY` runs on can read it from the process environment and decrypt every stored credential; this ADR defends the data at rest against a leaked database, not against a compromised host. That is the correct scope for spec §13's threat model, not a claimed-but-undelivered guarantee.
- **Risk to watch:** losing `CAREERHQ_MASTER_KEY` makes every stored credential permanently unrecoverable (by design — there is no recovery path around the key); the settings UI already treats an unset key as "email disabled" rather than crashing, and rotation is a manual disconnect/reconnect per mailbox, not yet a first-class operation.
