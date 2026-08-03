# CareerHQ P4 — Email Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first live external mutation channel of spec v0.3: encrypted mailbox credentials (§13), the full three-layer gated submission protocol (§11) with preview-fingerprint + retype-target confirmation and pending/confirmed receipts, SMTP application sending with attachments (§9.4), IMAP reply sync with header threading and retention (§9.5), AI reply classification with a suggestion review queue, plus the carried P3 backlog — Phase P4 of `docs/roadmap.md`.

**Architecture:** Gate *decisions* are pure functions in `packages/core/src/gates/` (canonical payload + fingerprint, the gate-evaluation matrix, token hashing). Crypto (libsodium secretbox) and the receipt state machine live in `packages/db` (credentials repo, email-attempt repo built on `canAttemptTransition`). New `packages/email` wraps nodemailer/imapflow behind injectable interfaces (SMTP verify/send with FAILED-vs-NEEDS_RECONCILE error mapping; IMAP normalization + pure threading matcher). `apps/web` orchestrates draft → preview → confirm → execute; `apps/worker` runs scheduled IMAP sync, retention purge, and `classifyReply` with auto-ack only at ≥ `AUTO_ACK_CONFIDENCE`. The UI can display gate state but can never open a gate.

**Tech Stack:** additions — `nodemailer` (SMTP), `imapflow` + `mailparser` (IMAP), `libsodium-wrappers` (secretbox). Existing: Node 22, TS strict ESM, Drizzle/Postgres, pg-boss, Zod 3, Vitest 3, Next.js 15, Mailpit (compose).

## Global Constraints

- Gated submission (spec §11, NORMATIVE): three independent server-side layers — (1) `SUBMISSIONS_LIVE_EMAIL` env gate default OFF (channel works fully through preview, then blocks); (2) sandbox hard block at the adapter layer (sandbox workspaces may only target the configured Mailpit host); (3) per-application confirmation — single-use token (sha256-hashed at rest, `CONFIRMATION_TTL_MS = 10 * 60_000`), user retypes the EXACT target address, fingerprint must recompute identically (any edit invalidates), no confirmed attempt exists, no attempt in flight. Pending receipt written transactionally BEFORE the send; confirmed receipt only after SMTP acceptance evidence (Message-ID); failure before mutation → FAILED with redacted reason; uncertainty after the DATA phase → NEEDS_RECONCILE, surfaced, never auto-retried.
- Duplicate protection is the DB partial unique index (`attempts_one_submitted_per_application`, shipped P1) — the gate matrix re-checks it but the constraint is the backstop.
- Application state: `→ SUBMITTED` only via trigger `attempt` with `hasConfirmedAttempt: true` (P1 machine, unchanged). Auto-ack: classification `ack` with confidence ≥ `AUTO_ACK_CONFIDENCE` (0.9, core) transitions via trigger `classification`; ALL other classifications and states only ever SUGGEST (review queue, user confirms with trigger `user`) — spec §6.2/§9.5.
- Credentials (spec §13): libsodium secretbox with `CAREERHQ_MASTER_KEY` (base64, 32 bytes) env; ciphertext-only in Postgres (`credentials.ciphertext bytea`); plaintext NEVER in logs, error messages, API responses, or client code; redaction helper applied to every SMTP/IMAP error surfaced; disconnect deletes the ciphertext row. No master key configured → email connections cannot be created (clear UI state), everything else works.
- Retention (spec §9.5): per-connection setting `metadata_only` (headers + ≤300-char snippet, DEFAULT) | `full_local` (body on the file volume via `body_ref`) | `days_limited` (body purged after N days by the sync job).
- Threading (spec §9.5): `In-Reply-To`/`References`/Message-ID matching FIRST (→ hard link, `match_method: "headers"`); sender-domain heuristic SECOND (→ link with `match_method: "sender"` and a pending suggestion, never silent); semantic matching is OUT of P4.
- No automatic replies, ever (spec §9.5).
- Carried P3 backlog IN SCOPE (Task 3): real `hasMaterials` check (approved document exists AND CV selected — includes adding the CV selector UI, which email attachments need anyway), replay fixture schema-guard, sensitivity tie-break after scoping, ProvenanceChips extraction, two-workspace `listReusableAnswers` test.
- Repo conventions: TS strict, no `any`; ESM `.js` specifiers; established harnesses (db skipIf TEST_DATABASE_URL on this host's `postgres://careerhq:careerhq@localhost:5433/careerhq`, throwaway workspace + afterAll cleanup; ai/email tests inject transports/clients — NO live network in tests; Mailpit integration tests hit `localhost:1025`/`localhost:8025` which IS allowed — Mailpit is part of the compose stack, treat it like Postgres); P1 action conventions; conventional commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; dep-adding commits include the lockfile; compose env plumbing for every new var in the SAME task that introduces it (P2/P3 final-review lesson — never defer the YAML).
- New env vars (all wired into `.env.example` AND `infra/docker-compose.yml` in their introducing task): `CAREERHQ_MASTER_KEY` (web+worker), `EMAIL_SYNC_CRON` default `*/15 * * * *` (worker), `SANDBOX_SMTP_ALLOWED_HOST` default `mailpit` (web+worker).

---

### Task 1: Contracts — email channel schemas

**Files:**
- Modify: `packages/contracts/src/index.ts` (append)
- Test: `packages/contracts/src/email.test.ts`

**Interfaces:**
- Produces (appended to `@careerhq/contracts`):
```ts
export const EMAIL_DIRECTIONS = ["inbound", "outbound"] as const;
export type EmailDirection = (typeof EMAIL_DIRECTIONS)[number];
export const emailDirectionSchema = z.enum(EMAIL_DIRECTIONS);

export const MATCH_METHODS = ["headers", "sender", "semantic", "manual"] as const;
export type MatchMethod = (typeof MATCH_METHODS)[number];
export const matchMethodSchema = z.enum(MATCH_METHODS);

export const REPLY_CLASSIFICATIONS = ["ack", "recruiter", "interview", "rejection", "offer", "unrelated"] as const;
export type ReplyClassification = (typeof REPLY_CLASSIFICATIONS)[number];
export const replyClassificationSchema = z.enum(REPLY_CLASSIFICATIONS);

export const SUGGESTION_STATES = ["pending", "accepted", "dismissed"] as const;
export type SuggestionState = (typeof SUGGESTION_STATES)[number];
export const suggestionStateSchema = z.enum(SUGGESTION_STATES);

export const RETENTION_MODES = ["metadata_only", "full_local", "days_limited"] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];
export const retentionSettingSchema = z.object({
  mode: z.enum(RETENTION_MODES).default("metadata_only"),
  days: z.number().int().positive().optional(),
}).refine((r) => r.mode !== "days_limited" || r.days != null, { message: "days required for days_limited" });
export type RetentionSetting = z.infer<typeof retentionSettingSchema>;

export const TLS_MODES = ["starttls", "implicit", "none"] as const;
export const smtpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  username: z.string().min(1),
  tls: z.enum(TLS_MODES).default("starttls"),
});
export type SmtpConfig = z.infer<typeof smtpConfigSchema>;
export const imapConfigSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  username: z.string().min(1),
  tls: z.enum(TLS_MODES).default("implicit"),
  folders: z.array(z.string().min(1)).min(1).default(["INBOX"]),
});
export type ImapConfig = z.infer<typeof imapConfigSchema>;

export const emailDraftSchema = z.object({
  to: z.string().email(),
  subject: z.string().trim().min(1),
  body: z.string().trim().min(1),
  cvVariantId: z.string().uuid().optional(),
});
export type EmailDraft = z.infer<typeof emailDraftSchema>;

export const classifyReplyResultSchema = z.object({
  classification: replyClassificationSchema,
  confidence: z.number().min(0).max(1),
  suggestedState: applicationStateSchema.optional(),
  quotedEvidence: z.string().default(""),
});
export type ClassifyReplyResult = z.infer<typeof classifyReplyResultSchema>;
```

- [ ] **Step 1: Write the failing test** — `packages/contracts/src/email.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  classifyReplyResultSchema, emailDraftSchema, imapConfigSchema,
  retentionSettingSchema, smtpConfigSchema,
} from "./index.js";

describe("email contracts (spec §9)", () => {
  it("retention days_limited requires days; default is metadata_only", () => {
    expect(retentionSettingSchema.safeParse({ mode: "days_limited" }).success).toBe(false);
    expect(retentionSettingSchema.parse({}).mode).toBe("metadata_only");
    expect(retentionSettingSchema.parse({ mode: "days_limited", days: 30 }).days).toBe(30);
  });
  it("smtp defaults starttls, imap defaults implicit + INBOX", () => {
    const s = smtpConfigSchema.parse({ host: "smtp.x.example", port: "587", username: "u" });
    expect(s.tls).toBe("starttls");
    expect(s.port).toBe(587);
    const i = imapConfigSchema.parse({ host: "imap.x.example", port: 993, username: "u" });
    expect(i.folders).toEqual(["INBOX"]);
  });
  it("draft requires valid recipient and non-empty subject/body", () => {
    expect(emailDraftSchema.safeParse({ to: "not-an-email", subject: "s", body: "b" }).success).toBe(false);
    expect(emailDraftSchema.safeParse({ to: "hr@acme.example", subject: " ", body: "b" }).success).toBe(false);
  });
  it("classification result bounds confidence and allows suggestedState", () => {
    const r = classifyReplyResultSchema.parse({ classification: "interview", confidence: 0.8, suggestedState: "INTERVIEW" });
    expect(r.quotedEvidence).toBe("");
    expect(classifyReplyResultSchema.safeParse({ classification: "spam", confidence: 0.5 }).success).toBe(false);
  });
});
```
- [ ] **Step 2: FAIL run.** **Step 3: Append the block verbatim.** **Step 4: PASS + build + full contracts suite.**
- [ ] **Step 5: Commit** — `feat(contracts): email channel schemas`

---

### Task 2: DB schema v4 — credentials, connections, messages, confirmations

**Files:**
- Modify: `packages/db/src/schema/index.ts`, `packages/db/src/index.ts`
- Create (generated): `packages/db/migrations/0003_*.sql`

**Interfaces:**
- Produces (tables + inferred types `Credential`, `EmailConnection`, `EmailMessage`, `AttemptConfirmation` and `New*` variants; `application_attempts` gains `draft_payload jsonb`):
```ts
export const credentials = pgTable("credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),                       // "smtp" | "imap" (free text; app-level)
  ciphertext: customType<{ data: Uint8Array; driverData: Buffer }>({
    dataType() { return "bytea"; },
  })("ciphertext").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const emailConnections = pgTable("email_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  fromAddress: text("from_address").notNull(),
  displayName: text("display_name"),
  smtp: jsonb("smtp").notNull(),                      // SmtpConfig (no password)
  imap: jsonb("imap"),                                // ImapConfig | null
  retention: jsonb("retention").notNull(),            // RetentionSetting
  smtpCredentialId: uuid("smtp_credential_id").notNull().references(() => credentials.id, { onDelete: "restrict" }),
  imapCredentialId: uuid("imap_credential_id").references(() => credentials.id, { onDelete: "restrict" }),
  health: text("health").notNull().default("untested"), // "untested" | "ok" | "error"
  healthDetail: text("health_detail"),                // redacted reason
  syncState: jsonb("sync_state"),                     // { [folder]: lastUid }
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const emailMessages = pgTable("email_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").references(() => emailConnections.id, { onDelete: "set null" }),
  direction: emailDirection("direction").notNull(),
  messageId: text("message_id").notNull(),
  inReplyTo: text("in_reply_to"),
  referencesIds: text("references_ids").array().notNull().default(sql`'{}'::text[]`),
  fromAddr: text("from_addr").notNull(),
  toAddrs: text("to_addrs").array().notNull().default(sql`'{}'::text[]`),
  subject: text("subject").notNull().default(""),
  snippet: text("snippet").notNull().default(""),
  bodyRef: text("body_ref"),
  applicationId: uuid("application_id").references(() => applications.id, { onDelete: "set null" }),
  matchMethod: matchMethod("match_method"),
  classification: replyClassification("classification"),
  classificationConfidence: real("classification_confidence"),
  suggestedTransition: applicationState("suggested_transition"),
  suggestionState: suggestionState("suggestion_state"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("email_messages_workspace_message_id").on(t.workspaceId, t.messageId),
  index("email_messages_application").on(t.applicationId, t.receivedAt),
  index("email_messages_suggestions").on(t.suggestionState, t.receivedAt),
]);

export const attemptConfirmations = pgTable("attempt_confirmations", {
  id: uuid("id").primaryKey().defaultRandom(),
  attemptId: uuid("attempt_id").notNull().references(() => applicationAttempts.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  payloadFingerprint: text("payload_fingerprint").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("attempt_confirmations_attempt").on(t.attemptId, t.createdAt)]);
```
New pg enums from contracts arrays: `email_direction`, `match_method`, `reply_classification`, `suggestion_state`. `applicationAttempts` gains `draftPayload: jsonb("draft_payload")`.

- [ ] **Step 1: Extend the schema** (imports: `customType` from drizzle-orm/pg-core; the new contracts arrays).
- [ ] **Step 2: Generate + inspect migration** — `pnpm --filter @careerhq/db db:generate`; QUOTE in report: 4 CREATE TYPE, 4 CREATE TABLE, 1 ALTER TABLE application_attempts ADD COLUMN, the email_messages unique index. Apply on 5433; `\d email_messages` proof.
- [ ] **Step 3: Typecheck + full db suite + lint; export inferred types.**
- [ ] **Step 4: Commit** — `feat(db): schema v4 — credentials, email connections/messages, attempt confirmations`

---

### Task 3: P3 carried backlog burn-down (+ CV selector)

**Files:**
- Modify: `apps/web/src/app/(dashboard)/applications/actions.ts`, `apps/web/src/lib/generation.ts`, `packages/ai/src/replay/index.ts`, `apps/web/src/app/(dashboard)/applications/[id]/page.tsx`
- Create: `apps/web/src/app/(dashboard)/applications/[id]/cv-select.tsx` (client), `apps/web/src/components/provenance-chips.tsx`
- Test: extend `packages/db/src/repos/answers.test.ts`, `packages/ai/src/replay/replay.test.ts`, `apps/web/src/lib/generation.test.ts`

**Interfaces:**
- Produces:
  1. **Real `hasMaterials`** (spec §6.2 "materials exist for chosen channel"): `transitionApplicationAction` computes `hasMaterials` for target `READY_FOR_REVIEW` as: at least one APPROVED `generated_documents` row for the application AND `applications.cv_variant_id` is set. Add db helper `hasApprovedMaterials(db, applicationId): Promise<boolean>` in `packages/db/src/repos/documents.ts` (approved doc exists) — the action combines it with the application row's cvVariantId. Update the stale P1 comment. Guard-refusal reason surfaces as before.
  2. **CV selector**: `selectCvAction({applicationId, cvVariantId})` (uuid zod, updates `applications.cv_variant_id`, revalidates) + `cv-select.tsx` dropdown of `listCvVariants` rendered on the application detail page (shows current selection; "No CV selected" default).
  3. **Replay schema-guard**: `withReplay` accepts optional `schema?: z.ZodType<T>`; on replay hit, `schema.safeParse(candidate.value)` failure → replay_miss-style failure (never throw). `runGeneration`/`run-stream` pass `generationResultSchema`.
  4. **Tie-break reorder**: in `prepareGeneration`, move `classifySensitiveLlm` AFTER the application-scoping check (ruleset check may stay first — it's free); adjust the flow so an invalid applicationId never burns an LLM call; update the affected test.
  5. **ProvenanceChips extraction**: shared `apps/web/src/components/provenance-chips.tsx`; `materials.tsx` and `qa.tsx` import it (delete both local copies).
  6. **Two-workspace test**: `listReusableAnswers` scoping test (second throwaway workspace with its own application+answer; assert isolation).
- [ ] **Step 1: Failing tests** for items 1 (transition refused without approved doc/CV via a generation.test-style db test asserting the action helper... simplest: db-level test for `hasApprovedMaterials` + an integration case in generation.test.ts harness creating an approved doc), 3 (corrupt-value-vs-schema replay hit → miss), 4 (spy: invalid applicationId → classifySensitive never called), 6 (two-workspace isolation).
- [ ] **Step 2: FAIL.** **Step 3: Implement all six.** **Step 4: PASS + full repo gate.**
- [ ] **Step 5: Commit** — `fix(web,ai,db): P3 backlog — real materials check, cv selector, replay guard, tie-break order, shared chips`

---

### Task 4: Credentials crypto + repo; master-key config

**Files:**
- Create: `packages/db/src/crypto.ts`, `packages/db/src/repos/credentials.ts`
- Modify: `packages/db/src/index.ts`, `packages/config/src/index.ts` (+test), `packages/db/package.json` (dep `libsodium-wrappers`, devDep `@types/libsodium-wrappers`), `.env.example`, `infra/docker-compose.yml` (CAREERHQ_MASTER_KEY → web AND worker, `${CAREERHQ_MASTER_KEY:-}`)
- Test: `packages/db/src/crypto.test.ts`, `packages/db/src/repos/credentials.test.ts`

**Interfaces:**
- Produces:
```ts
// crypto.ts — libsodium secretbox; sealed format: nonce(24) || box
export class CryptoError extends Error {}
export async function sealSecret(masterKeyB64: string, plaintext: string): Promise<Uint8Array>;
export async function openSecret(masterKeyB64: string, sealed: Uint8Array): Promise<string>; // CryptoError on tamper/wrong key/bad key length
export async function generateMasterKeyB64(): Promise<string>; // 32 random bytes, base64
// repos/credentials.ts
export async function createCredential(db: Db, input: { workspaceId: string; kind: string; masterKeyB64: string; secret: string }): Promise<string>; // returns credential id
export async function readCredentialSecret(db: Db, id: string, masterKeyB64: string): Promise<string>; // CryptoError propagates
export async function deleteCredential(db: Db, id: string): Promise<void>;
// config additions
masterKey: string | null;   // CAREERHQ_MASTER_KEY, default null (email connections disabled); validate base64 length 32 when present (bad value → prose error)
```
- [ ] **Step 1: Failing tests** — round-trip seal/open; tamper (flip a byte) → CryptoError; wrong key → CryptoError; bad key length → CryptoError; credential repo round-trip against 5433 (created row has no plaintext — assert ciphertext ≠ secret bytes; delete removes row); config: absent → null, invalid base64/length → prose error naming CAREERHQ_MASTER_KEY, valid round-trips.
- [ ] **Step 2: FAIL.** **Step 3: Implement** (libsodium `ready` await once, module-level promise; `crypto_secretbox_easy`/`open_easy`). `pnpm install`, lockfile in commit. Compose + .env.example in the SAME commit.
- [ ] **Step 4: PASS + full db/config suites.** Verify `docker compose -f infra/docker-compose.yml config` shows the var on web and worker.
- [ ] **Step 5: Commit** — `feat(db,config): libsodium credential encryption with master-key config`

---

### Task 5: Core gates — canonical payload, fingerprint, gate matrix, token helpers

**Files:**
- Create: `packages/core/src/gates/fingerprint.ts`, `packages/core/src/gates/evaluate.ts`, `packages/core/src/gates/token.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/gates/fingerprint.test.ts`, `packages/core/src/gates/evaluate.test.ts`, `packages/core/src/gates/token.test.ts`

**Interfaces:**
- Produces:
```ts
// fingerprint.ts
export function canonicalJson(value: unknown): string;      // recursively key-sorted, stable; throws on undefined/function/cycles
export function payloadFingerprint(value: unknown): string; // sha256 hex of canonicalJson
export interface EmailSubmissionPayload {
  applicationId: string; connectionId: string;
  to: string; subject: string; body: string;
  attachments: Array<{ filename: string; sha256: string }>;
}
// token.ts
export const CONFIRMATION_TTL_MS = 10 * 60_000;
export function generateConfirmationToken(): string;        // 32 random bytes hex (node:crypto)
export function hashConfirmationToken(token: string): string; // sha256 hex
// evaluate.ts
export interface GateCheckInput {
  envGateOpen: boolean;
  workspaceKind: WorkspaceKind;
  sandboxTargetAllowed: boolean;   // caller computes: target host is the allowed sandbox host
  tokenRecord: { tokenHash: string; payloadFingerprint: string; expiresAt: Date; consumedAt: Date | null } | null;
  presentedToken: string;
  now: Date;
  currentFingerprint: string;      // recomputed by the caller from the CURRENT draft
  retypedTarget: string;
  expectedTarget: string;          // compared case-insensitively, trimmed
  hasConfirmedAttempt: boolean;
  attemptInFlight: boolean;        // another attempt in SUBMITTING/NEEDS_RECONCILE
}
export type GateDecision =
  | { allowed: true }
  | { allowed: false; code: "duplicate_submission" | "attempt_in_flight" | "gate_closed" | "sandbox_blocked"
      | "token_missing" | "token_consumed" | "token_expired" | "token_invalid"
      | "fingerprint_mismatch" | "target_mismatch"; reason: string };
export function evaluateSubmissionGates(input: GateCheckInput): GateDecision;
// Check ORDER (normative, first failure wins): duplicate_submission → attempt_in_flight → gate_closed →
// sandbox_blocked (kind sandbox && !sandboxTargetAllowed) → token_missing/consumed/expired/invalid →
// fingerprint_mismatch → target_mismatch → allowed.
```
- [ ] **Step 1: Failing tests** — fingerprint: stable across key order (`{a:1,b:2}` vs `{b:2,a:1}` identical), nested arrays preserved in order, ANY payload change (one char of body, attachment sha, recipient case? — no: fingerprint is exact bytes; case matters here) changes the hash; canonicalJson throws on undefined value and cyclic object. token: 64-hex token; hash deterministic ≠ token. evaluate: a FULL matrix table test — every code reachable with exactly the expected precedence (e.g. duplicate beats gate_closed; sandbox_blocked only for sandbox kind; personal workspace ignores sandboxTargetAllowed; expired vs consumed vs wrong-hash distinct; fingerprint mismatch before target mismatch; target compare trims + case-insensitive `HR@Acme.example ` matches `hr@acme.example`), and the all-green case → allowed.
- [ ] **Step 2: FAIL.** **Step 3: Implement.** **Step 4: PASS + full core suite.**
- [ ] **Step 5: Commit** — `feat(core): submission gate matrix, canonical fingerprint and confirmation tokens`

---

### Task 6: packages/email — SMTP adapter with error mapping + redaction

**Files:**
- Create: `packages/email/package.json`, `packages/email/tsconfig.json`, `packages/email/src/index.ts`, `packages/email/src/redact.ts`, `packages/email/src/smtp.ts`
- Modify: `.dependency-cruiser.cjs` (extend the purity rule: `packages/email` may not import `db`/`apps` — same fence as ingest/ai)
- Test: `packages/email/src/redact.test.ts`, `packages/email/src/smtp.test.ts`

**Interfaces:**
- Produces (`@careerhq/email`, deps: `nodemailer`, `@careerhq/contracts` workspace:*; devDeps `@types/nodemailer`, vitest):
```ts
// redact.ts
export function redactError(err: unknown, secrets: string[]): string;
// String(err.message ?? err); every secrets[] occurrence → "[redacted]"; also masks
// `AUTH PLAIN <...>`/`AUTH LOGIN <...>` blobs and base64 runs ≥ 16 chars → "[redacted]"; caps at 300 chars.
// smtp.ts
export interface SmtpSendRequest {
  from: string;                       // "Display Name <addr>" formatted by caller
  to: string; subject: string; text: string;
  attachments: Array<{ filename: string; content: Buffer }>;
  messageIdDomain: string;            // e.g. from-address domain → nodemailer messageId generation left ON; we read the returned one
}
export type SendOutcome =
  | { status: "sent"; messageId: string }
  | { status: "failed"; reason: string }        // redacted
  | { status: "uncertain"; reason: string };    // redacted; post-DATA ambiguity
export interface SmtpTransportLike {
  verify(): Promise<true>;
  sendMail(opts: object): Promise<{ messageId: string; accepted: string[]; rejected: string[] }>;
}
export function makeSmtpTransport(cfg: SmtpConfig, password: string): SmtpTransportLike; // nodemailer.createTransport: secure = tls==="implicit"; requireTLS = tls==="starttls"; ignoreTLS = tls==="none"
export async function verifySmtpConnection(t: SmtpTransportLike, secrets: string[]): Promise<{ ok: true } | { ok: false; reason: string }>;
export async function sendApplicationEmail(t: SmtpTransportLike, req: SmtpSendRequest, secrets: string[]): Promise<SendOutcome>;
// Error mapping: sendMail resolves + accepted includes the recipient → sent.
// sendMail resolves but recipient in rejected → failed ("recipient rejected").
// sendMail rejects: err.command === "DATA" or err.command === "end DATA" or (err.code === "ETIMEDOUT" && err.command?.startsWith("DATA")) → uncertain; everything else → failed. Reasons always redacted.
```
- [ ] **Step 1: Failing tests** — redact: password + AUTH blob + long-base64 masked, 300-char cap, non-Error input; smtp: stub transports for each outcome path (sent; rejected-recipient failed; EAUTH failed with password NOT in reason; DATA-command rejection → uncertain; ETIMEDOUT on end-DATA → uncertain); makeSmtpTransport flag mapping asserted via a factory-injection seam (export a `createTransportImpl` injection or assert via nodemailer's transporter.options).
- [ ] **Step 2: Scaffold package (contracts pattern), FAIL run.** **Step 3: Implement.** **Step 4: PASS + build + lint + depcruise (extend rule; negative-test it: temp `import "@careerhq/db"` in email → error → revert, record both).**
- [ ] **Step 5: Commit** — `feat(email): smtp adapter with outcome mapping and secret redaction`

---

### Task 7: DB — email connections repo + email attempt/receipt repo

**Files:**
- Create: `packages/db/src/repos/email-connections.ts`, `packages/db/src/repos/email-attempts.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/repos/email-connections.test.ts`, `packages/db/src/repos/email-attempts.test.ts`

**Interfaces:**
- Produces:
```ts
// email-connections.ts
export async function createEmailConnection(db: Db, input: {
  workspaceId: string; label: string; fromAddress: string; displayName?: string;
  smtp: SmtpConfig; smtpPassword: string; imap?: ImapConfig; imapPassword?: string;
  retention: RetentionSetting; masterKeyB64: string;
}): Promise<EmailConnection>;         // one tx: credentials rows + connection; imapPassword required iff imap given
export async function getConnectionSecrets(db: Db, connectionId: string, masterKeyB64: string): Promise<{
  connection: EmailConnection; smtpPassword: string; imapPassword: string | null }>;
export async function listEmailConnections(db: Db, workspaceId: string): Promise<EmailConnection[]>;
export async function updateConnectionHealth(db: Db, id: string, health: "ok" | "error", detail?: string | null): Promise<void>; // also sets lastCheckedAt
export async function updateSyncState(db: Db, id: string, syncState: Record<string, number>): Promise<void>;
export async function deleteEmailConnection(db: Db, id: string): Promise<void>; // tx: delete connection THEN its credential rows (restrict FK order)
// email-attempts.ts — the receipt state machine (every transition guarded by canAttemptTransition; refusal → {ok:false, reason})
export async function createEmailAttempt(db: Db, input: { applicationId: string; draft: EmailDraft; connectionId: string }): Promise<ApplicationAttempt>; // channel "email", status DRAFT, draft_payload {draft, connectionId}
export async function updateEmailDraft(db: Db, attemptId: string, draft: EmailDraft, connectionId: string): Promise<ApplicationAttempt | null>; // only in DRAFT/READY/PENDING_CONFIRMATION (edits invalidate later fingerprints naturally)
export async function getEmailAttempt(db: Db, attemptId: string): Promise<ApplicationAttempt | null>;
export async function listAttemptsForApplication(db: Db, applicationId: string): Promise<ApplicationAttempt[]>;
export async function recordPreview(db: Db, input: { attemptId: string; payloadFingerprint: string; target: string; tokenHash: string; expiresAt: Date }): Promise<{ ok: true } | { ok: false; reason: string }>;
// tx: attempt DRAFT→READY→PENDING_CONFIRMATION (two guarded steps), store target_fingerprint + payload_fingerprint on the attempt, insert attempt_confirmations row
export async function getActiveConfirmation(db: Db, attemptId: string): Promise<AttemptConfirmation | null>; // latest unconsumed
export async function beginSubmission(db: Db, input: { attemptId: string; confirmationId: string; pendingReceipt: unknown }): Promise<{ ok: true } | { ok: false; reason: string }>;
// tx: consume confirmation (consumedAt=now, refuse if already consumed) + attempt PENDING_CONFIRMATION→SUBMITTING + pending_receipt — the write that happens BEFORE the mutation
export async function completeSubmission(db: Db, input: { attemptId: string; confirmedReceipt: unknown }): Promise<{ ok: true } | { ok: false; reason: string }>;
// tx: attempt SUBMITTING→SUBMITTED (partial unique index may reject → surfaced as refusal) + confirmed_receipt + submitted_at + transitionApplication(applicationId, "SUBMITTED", "attempt", {hasConfirmedAttempt:true})
export async function failSubmission(db: Db, attemptId: string, reason: string): Promise<void>;      // SUBMITTING→FAILED + failure_reason
export async function markNeedsReconcile(db: Db, attemptId: string, reason: string): Promise<void>;  // SUBMITTING→NEEDS_RECONCILE
export async function resolveReconcile(db: Db, input: { attemptId: string; resolution: "submitted" | "failed"; evidence?: unknown }): Promise<{ ok: true } | { ok: false; reason: string }>; // human-only path
export async function hasBlockingAttempt(db: Db, applicationId: string): Promise<{ confirmed: boolean; inFlight: boolean }>;
```
- [ ] **Step 1: Failing tests** — connections: create-with-imap makes 2 credential rows, secrets round-trip via master key, delete removes connection AND credentials, list scoped; attempts: full happy lifecycle (create→update draft→recordPreview→beginSubmission consumes token exactly once (second begin refuses)→completeSubmission sets receipts + application lands SUBMITTED via the real transition); failSubmission/markNeedsReconcile paths; resolveReconcile both resolutions; hasBlockingAttempt reflects confirmed/in-flight; the partial-unique backstop: a second attempt for the same application completing → refusal not throw.
- [ ] **Step 2: FAIL (5433).** **Step 3: Implement.** **Step 4: PASS + full db suite.**
- [ ] **Step 5: Commit** — `feat(db): email connection and gated attempt/receipt repositories`

---

### Task 8: Web — email connection settings UI

**Files:**
- Create: `apps/web/src/app/(dashboard)/settings/email/page.tsx`, `apps/web/src/app/(dashboard)/settings/email/actions.ts`, `apps/web/src/app/(dashboard)/settings/email/connection-form.tsx` (client)
- Modify: `apps/web/src/app/(dashboard)/settings/page.tsx` (link section "Email connections")

**Interfaces:**
- `/settings/email` (force-dynamic): no master key configured → info panel "Set CAREERHQ_MASTER_KEY to enable mailbox connections" (nothing else); else: connections table (label, from, health badge + redacted detail, last checked, IMAP yes/no, retention mode, Test / Disconnect buttons) + create form (label, from address, display name, SMTP host/port/username/password/TLS select, optional IMAP section with folders comma-input, retention select + days input).
- Actions (P1 conventions; passwords are `FormData` fields that NEVER get logged or echoed back — on validation error re-render with empty password fields):
  - `createConnectionAction(formData)` — zod via smtpConfigSchema/imapConfigSchema/retentionSettingSchema; calls `createEmailConnection`; then immediately `testConnectionAction` logic (verify) and store health.
  - `testConnectionAction({connectionId})` — `getConnectionSecrets` → `makeSmtpTransport` → `verifySmtpConnection` (secrets: [password]) → `updateConnectionHealth`; returns `{ok, reason?}` for inline display.
  - `disconnectAction({connectionId})` — `deleteEmailConnection`.
- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify manually** (this host): with CAREERHQ_MASTER_KEY set (generate via a tsx one-liner calling `generateMasterKeyB64`), create a connection pointing at Mailpit (`host localhost, port 1025, tls none, any username/password`) → health "ok" after test; create one with a bogus host → health "error" with redacted detail (assert the password string does NOT appear — grep the rendered HTML and the server log); disconnect removes it. Transcripts in report.
- [ ] **Step 3: Typecheck + lint.**
- [ ] **Step 4: Commit** — `feat(web): email connection settings with test and redacted health`

---

### Task 9: Web — email submission orchestrator (draft → preview → confirm → execute)

**Files:**
- Create: `apps/web/src/lib/email-submission.ts`
- Test: `apps/web/src/lib/email-submission.test.ts` (real db on 5433, injected transport)

**Interfaces:**
- Produces (single orchestration module the actions/UI call; deps injection like `runGeneration`):
```ts
export interface EmailSubmissionDeps {
  db: Db; config: AppConfig;
  makeTransport?: typeof makeSmtpTransport;  // injection for tests
}
export type PreviewOutcome =
  | { status: "ok"; attemptId: string; fingerprint: string; payload: EmailSubmissionPayload; expiresAt: string; token: string }
  | { status: "blocked"; reason: string };
export async function previewSubmission(deps: EmailSubmissionDeps, args: { workspaceId: string; attemptId: string }): Promise<PreviewOutcome>;
// loads attempt (workspace-scoped via application), draft + connection + CV file (sha256 from cv_variants), builds
// EmailSubmissionPayload, fingerprint, generates token (returns PLAINTEXT token to the caller for the confirm dialog;
// stores only the hash via recordPreview). Blocked when: no draft/connection/CV missing file, attempt not in DRAFT/READY/PENDING_CONFIRMATION.
export type ConfirmOutcome =
  | { status: "submitted"; messageId: string }
  | { status: "blocked"; code: string; reason: string }   // code = the GateDecision code
  | { status: "failed"; reason: string }
  | { status: "needs_reconcile"; reason: string };
export async function confirmAndSend(deps: EmailSubmissionDeps, args: {
  workspaceId: string; attemptId: string; presentedToken: string; retypedTarget: string;
}): Promise<ConfirmOutcome>;
// Recomputes the CURRENT fingerprint from the stored draft (any edit since preview mismatches), loads the active
// confirmation, gathers gate inputs (env gate from config.submissionsLiveEmail; workspace kind; sandboxTargetAllowed =
// connection.smtp.host === config.sandboxSmtpAllowedHost when kind is sandbox; hasBlockingAttempt), calls
// evaluateSubmissionGates. Not allowed → blocked with the gate code+reason (attempt stays PENDING_CONFIRMATION).
// Allowed → beginSubmission (pending receipt: payload + fingerprint + startedAt) → sendApplicationEmail with the real
// CV file Buffer → sent → completeSubmission (evidence: messageId, acceptedAt, attachment hashes) → submitted.
// failed → failSubmission → failed. uncertain → markNeedsReconcile → needs_reconcile.
```
- Config addition (this task): `sandboxSmtpAllowedHost: string` (env `SANDBOX_SMTP_ALLOWED_HOST` default `"mailpit"`) + compose entries for web+worker + .env.example + config test.
- [ ] **Step 1: Failing tests** (injected stub transports; real db): preview returns payload with CV sha256 + stores hashed token (row's tokenHash === hash(token)); tampered draft after preview → confirm blocked `fingerprint_mismatch`; wrong retyped target → `target_mismatch`; env gate off → `gate_closed` and attempt still PENDING_CONFIRMATION; gate on + stub sent → submitted, receipts populated, application SUBMITTED (real transition); stub failed → FAILED with redacted reason; stub uncertain → NEEDS_RECONCILE; second confirm attempt after success → blocked `duplicate_submission`; token reuse after a blocked-then-fixed flow → consumed refusal path exercised.
- [ ] **Step 2: FAIL.** **Step 3: Implement.** **Step 4: PASS + full gate.**
- [ ] **Step 5: Commit** — `feat(web): gated email submission orchestrator with receipts`

---

### Task 10: Web — email submission UI

**Files:**
- Create: `apps/web/src/app/(dashboard)/applications/[id]/email-panel.tsx` (client), `apps/web/src/app/(dashboard)/applications/[id]/email-actions.ts`
- Modify: `apps/web/src/app/(dashboard)/applications/[id]/page.tsx` (render `<EmailPanel/>` with server-fetched attempts/connections/documents)

**Interfaces:**
- Actions wrapping Task 7/9 functions (P1 conventions): `createEmailAttemptAction`, `updateEmailDraftAction`, `previewSubmissionAction`, `confirmAndSendAction`, `resolveReconcileAction`.
- Panel behavior: no connection → link to /settings/email; draft editor (to, subject, body — "Use approved email draft" button copies the latest APPROVED email_body document; attachment line shows selected CV variant name + "change" linking the Task 3 selector); Preview → full-payload review screen (recipient, subject, body, attachment filename + sha256 prefix, fingerprint prefix, expiry countdown) + confirm dialog requiring the EXACT recipient retyped (submit disabled until non-empty; server does the real comparison) → outcome panes: submitted (Message-ID, link stays on page — application card now shows SUBMITTED), blocked (gate code + reason; `gate_closed` explains the env flag), failed (redacted reason, draft retained), needs_reconcile (explanation + "Mark submitted (with evidence note)" / "Mark failed" via `resolveReconcileAction`).
- Attempt history list (status badges incl. receipts' timestamps; NEEDS_RECONCILE highlighted).
- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify manually** (this host, gate ON for Mailpit: `SUBMISSIONS_LIVE_EMAIL=true`, master key set, Mailpit connection from Task 8): drive the real flow with server-action POSTs — draft → preview → confirm with retyped target → submitted; assert the message arrived via Mailpit API (`curl localhost:8025/api/v1/messages` shows subject + attachment); a tampered-draft confirm → fingerprint_mismatch; gate OFF run → gate_closed at confirm, preview fine. Transcripts in report.
- [ ] **Step 3: Typecheck + lint + web tests.**
- [ ] **Step 4: Commit** — `feat(web): email draft/preview/confirm panel with attempt history`

---

### Task 11: packages/email — IMAP normalization + threading matcher

**Files:**
- Create: `packages/email/src/imap.ts`, `packages/email/src/threading.ts`
- Modify: `packages/email/src/index.ts`, `packages/email/package.json` (deps `imapflow`, `mailparser`; devDep `@types/mailparser`)
- Test: `packages/email/src/threading.test.ts`, `packages/email/src/imap.test.ts`

**Interfaces:**
- Produces:
```ts
// imap.ts
export interface RawFetchedMessage { uid: number; source: Buffer }   // full RFC822 source
export interface ImapClientLike {
  connect(): Promise<void>; logout(): Promise<void>;
  fetchNewMessages(folder: string, sinceUid: number): AsyncIterable<RawFetchedMessage>;
}
export function makeImapClient(cfg: ImapConfig, password: string): ImapClientLike; // imapflow impl; secure = tls==="implicit"
export interface NormalizedInboundEmail {
  messageId: string; inReplyTo: string | null; references: string[];
  fromAddr: string; toAddrs: string[]; subject: string;
  date: Date; textSnippet: string;      // ≤300 chars, whitespace-collapsed
  fullText: string;                     // complete text body (caller decides retention)
}
export async function normalizeRawMessage(raw: RawFetchedMessage): Promise<NormalizedInboundEmail | null>; // mailparser; null when no Message-ID
// threading.ts (pure)
export interface OutboundIndexEntry { messageId: string; applicationId: string }
export interface SenderDomainEntry { domain: string; applicationId: string }
export type ThreadMatch = { applicationId: string; matchMethod: "headers" | "sender" } | null;
export function matchInboundToApplication(
  msg: Pick<NormalizedInboundEmail, "inReplyTo" | "references" | "fromAddr">,
  outboundIndex: ReadonlyMap<string, string>,          // messageId → applicationId
  senderDomains: ReadonlyMap<string, string[]>,        // domain → applicationIds (submitted-ish states only, caller-filtered)
): ThreadMatch;
// headers: inReplyTo match wins; else FIRST references match (walk in order); else sender-domain — ONLY when the
// domain maps to exactly ONE application (ambiguous → null, never guess); else null. Message-ID comparison strips <> and trims.
```
- [ ] **Step 1: Failing tests** — threading: inReplyTo hit; references-chain hit (middle element); angle-bracket/whitespace normalization (`<abc@x>` matches `abc@x`); sender-domain unique hit; sender-domain ambiguous (2 apps) → null; no match → null; headers beat sender when both would match. imap normalization: feed 2 fixture RFC822 buffers (hand-authored in the test: simple text reply with In-Reply-To + References; one with no Message-ID → null); snippet collapsed ≤300; date parsed.
- [ ] **Step 2: FAIL.** **Step 3: Implement** (`pnpm install`; lockfile in commit). **Step 4: PASS + build + lint.**
- [ ] **Step 5: Commit** — `feat(email): imap normalization and header-first threading matcher`

---

### Task 12: DB — email messages repo; Worker — sync job + classifyReply + auto-ack

**Files:**
- Create: `packages/db/src/repos/email-messages.ts`, `apps/worker/src/jobs/email-sync.ts`, `packages/ai/src/tasks/classify-reply.ts`
- Modify: `apps/worker/src/main.ts` (queue `email.sync`, schedule `config.emailSyncCron`), `packages/config/src/index.ts` (+`emailSyncCron` default `*/15 * * * *`, compose worker env `${EMAIL_SYNC_CRON:-*/15 * * * *}`, .env.example), `packages/ai/src/index.ts`, `apps/worker/package.json` (dep `@careerhq/email`)
- Test: `packages/db/src/repos/email-messages.test.ts`, `packages/ai/src/tasks/classify-reply.test.ts`, `apps/worker/src/jobs/email-sync.test.ts` (integration, injected Imap client + AI)

**Interfaces:**
- Produces:
```ts
// db repos/email-messages.ts
export async function recordOutboundMessage(db: Db, input: { workspaceId; connectionId; messageId; toAddrs: string[]; subject; applicationId }): Promise<void>; // direction outbound, match manual — called by completeSubmission's caller (Task 9 wires it in this task via a small edit noted below)
export async function upsertInboundMessage(db: Db, input: { workspaceId; connectionId; msg: NormalizedInboundEmail; applicationId: string | null; matchMethod: MatchMethod | null; bodyRef: string | null; suggestionSeed?: { suggestionState: "pending" } }): Promise<{ inserted: boolean; id: string }>; // unique (workspace, messageId) → skip existing
export async function buildOutboundIndex(db: Db, workspaceId: string): Promise<Map<string, string>>;
export async function buildSenderDomainIndex(db: Db, workspaceId: string): Promise<Map<string, string[]>>; // submitted-ish applications' company domains (companies.domain ?? jobs.url host)
export async function listMessagesForApplication(db: Db, applicationId: string): Promise<EmailMessage[]>;
export async function listPendingSuggestions(db: Db, workspaceId: string): Promise<EmailMessage[]>;
export async function setClassification(db: Db, messageId: string, input: { classification: ReplyClassification; confidence: number; suggestedTransition: ApplicationState | null; suggestionState: SuggestionState | null }): Promise<void>;
export async function setSuggestionState(db: Db, messageId: string, state: SuggestionState): Promise<void>;
export async function purgeExpiredBodies(db: Db, workspaceId: string, now?: Date): Promise<string[]>; // days_limited connections only: nulls body_ref for rows past the cutoff and returns the cleared refs (file paths) for the worker to unlink
// ai tasks/classify-reply.ts
export function buildClassifyPrompt(msg: { subject: string; snippet: string; companyName: string; jobTitle: string; applicationState: string }): { system: string; user: string };
export async function classifyReply(msg: ..., opts: FallbackOptions): Promise<FallbackResult<ClassifyReplyResult>>;
// system: classify a job-application reply email; ONLY JSON {classification, confidence, suggestedState, quotedEvidence};
// suggestedState only from ACKNOWLEDGED/INTERVIEW/REJECTED/OFFER; quotedEvidence = verbatim phrase from the message.
// worker jobs/email-sync.ts
export async function runEmailSyncOnce(db: Db, workspaceId: string, config: AppConfig, opts?: {
  makeClient?: typeof makeImapClient; classify?: typeof classifyReply;
}): Promise<{ connections: number; fetched: number; linked: number; suggested: number; classified: number; autoAcked: number; purged: number }>;
// per connection with imap: client from secrets → per folder fetch since syncState uid → normalize → thread-match
// (indexes from db) → retention decision (metadata_only: no body; full_local: write body to
// `${fileStorageDir}/mail/${uuid}.txt` as bodyRef; days_limited: same + purge pass) → upsert →
// for NEW matched inbound messages with an api key: classifyReply (fast tier) → setClassification
// (suggestionState "pending" unless auto-ack) → auto-ack rule: classification "ack" && confidence >= AUTO_ACK_CONFIDENCE
// && application in SUBMITTED → transitionApplication trigger "classification" with {classificationConfidence: confidence}
// → suggestionState "accepted". No key → messages stored unclassified (deterministic floor). Update syncState per folder.
// Errors per connection: caught, health "error" with redacted detail, continue to next connection.
```
- Also in this task: wire `recordOutboundMessage` into the Task 9 orchestrator right after `completeSubmission` (small edit + test assertion in email-submission.test.ts).
- [ ] **Step 1: Failing tests** — repo: upsert dedupe by (workspace, messageId); indexes built correctly (outbound from recorded messages; sender domains only for SUBMITTED+ apps); purge clears refs past cutoff only for days_limited; classify-reply: prompt contains subject/snippet/state + ONLY-JSON instruction, valid mocked result ok, suggestedState outside the allowed set → schema... (schema allows any ApplicationState — enforce the allowed subset via isUseful: suggestedState absent or ∈ {ACKNOWLEDGED, INTERVIEW, REJECTED, OFFER}); worker: injected client with 3 fixture messages (one In-Reply-To match → linked+classified via injected classify; one sender-domain unique → suggested pending; one unmatched → stored unlinked, not classified), auto-ack case (classify returns ack/0.95 on a SUBMITTED app → application ACKNOWLEDGED trigger classification in the event log), no-key case (classified count 0, messages still stored), syncState advances, second run fetches nothing (sinceUid).
- [ ] **Step 2: FAIL.** **Step 3: Implement.** **Step 4: PASS + full gate + depcruise (worker may import email; email may not import db — already fenced).**
- [ ] **Step 5: Commit** — `feat(db,ai,worker): imap sync pipeline with threading, classification and auto-ack`

---

### Task 13: Web — messages view + suggestion review queue

**Files:**
- Create: `apps/web/src/app/(dashboard)/inbox/page.tsx`, `apps/web/src/app/(dashboard)/inbox/actions.ts`, `apps/web/src/app/(dashboard)/applications/[id]/messages.tsx` (server fragment)
- Modify: `apps/web/src/app/layout.tsx` (nav "Mail"), `apps/web/src/app/(dashboard)/applications/[id]/page.tsx` (render messages section)

**Interfaces:**
- `/inbox` (force-dynamic): pending suggestions list — message (from, subject, snippet, received), linked application (company · title · current state), classification badge + confidence, suggested transition, quoted evidence, Accept / Dismiss. Accept → `acceptSuggestionAction({messageId})`: applies `transitionApplication(applicationId, suggestedTransition, "user")` (user trigger per spec §9.5 — user confirmation) + `setSuggestionState "accepted"`; refusals (illegal transition from current state) surface inline and leave the suggestion pending. Dismiss → state "dismissed". Empty state text. Application detail messages section: chronological in/out messages (direction badge, classification when present, snippet, body link when bodyRef present — served via the existing file route? P1 has no file route: render snippet only + note; body download is YAGNI for P4 — note deliberately).
- [ ] **Step 1: Implement.**
- [ ] **Step 2: Verify manually** — seed a pending suggestion via the Task 12 test helpers (tsx against 5433), curl /inbox grep classification badge + evidence; accept → application transitions (event log trigger user) and row leaves the queue; illegal suggestion (OFFER on a DISCOVERED app) → inline refusal, stays pending. Transcripts.
- [ ] **Step 3: Typecheck + lint.**
- [ ] **Step 4: Commit** — `feat(web): mail inbox with suggestion review queue and application message history`

---

### Task 14: Mailpit end-to-end round trip + gate negative proof

**Files:**
- Create: `apps/web/src/lib/email-e2e.test.ts` (integration; skipIf no TEST_DATABASE_URL or no Mailpit — probe `localhost:8025` and skip cleanly when absent)

**Interfaces:**
- The full-stack proof (DoD items): using REAL nodemailer transport against compose Mailpit (`localhost:1025`, tls none) and a REAL db: create workspace+application+approved doc+CV variant (tiny PDF buffer)+Mailpit connection (real crypto round trip with a generated master key) → orchestrator preview → confirmAndSend with correct token+target and `submissionsLiveEmail: true` in the injected config → expect submitted; then assert via Mailpit REST (`GET http://localhost:8025/api/v1/search?query=` or `/api/v1/messages`) the message exists with the subject and 1 attachment; negative proofs in the same file: gate off → gate_closed; tampered draft → fingerprint_mismatch; wrong target → target_mismatch; second submission → duplicate_submission. Clean up: delete the Mailpit message (DELETE /api/v1/messages) or ignore (Mailpit is disposable) — note choice.
- [ ] **Step 1: Write the test (it IS the deliverable), watch it FAIL only if wiring is broken — it should pass against the shipped Tasks 7–12; treat failures as integration bugs to fix (report them).**
- [ ] **Step 2: Run with Mailpit up; PASS. Run with Mailpit stopped; SKIP cleanly. Full gate.**
- [ ] **Step 3: Commit** — `test(web): mailpit end-to-end gated submission round trip`

---

### Task 15: ADR-0005, README, full verification

**Files:**
- Create: `docs/adr/0005-credential-encryption.md`
- Modify: `README.md`, `docs/roadmap.md` (mark P4 done, carry any new backlog)

**Interfaces:**
- ADR-0005 (Context/Decision/Consequences, ~35 lines, 0003/0004 style): app-level libsodium secretbox with env master key vs the spec-v0.2-era OS-keyring idea (infeasible in Docker/web — cite spec §13's threat model); ciphertext-only rows, redaction at every error surface, disconnect=delete; what the master key does NOT protect against (host/root access) — honest scope.
- README: email channel to shipped features (connections with encrypted credentials, gated sending with the three layers + receipts, IMAP sync + threading + classification + review queue, Mailpit dev flow incl. how to demo safely: `SUBMISSIONS_LIVE_EMAIL=true` + Mailpit connection); env table gains CAREERHQ_MASTER_KEY (+ how to generate), EMAIL_SYNC_CRON, SANDBOX_SMTP_ALLOWED_HOST; routes gain /inbox and /settings/email; keep every claim code-accurate.
- [ ] **Step 1: Write docs.** **Step 2: Full gate + paste tails; grep tests for live network (Mailpit/localhost allowed, everything else forbidden).**
- [ ] **Step 3: Commit** — `docs: ADR-0005 credential encryption, README email channel`

---

## Final Verification (Definition of Done for P4)

1. Full gate green; only Mailpit/localhost network in tests.
2. The three gate layers provably block: env off → gate_closed (preview still works); sandbox workspace with non-Mailpit host → sandbox_blocked; tampered payload → fingerprint_mismatch; wrong retyped target → target_mismatch; duplicate → duplicate_submission (matrix unit tests + e2e negatives).
3. Pending receipt exists BEFORE the send (test asserts intermediate state), confirmed receipt carries the Message-ID; a stubbed DATA-phase failure lands NEEDS_RECONCILE and is resolvable only via the explicit human action.
4. Real round trip: message lands in Mailpit with attachment; application reaches SUBMITTED through the genuine attempt-triggered transition.
5. No secret ever appears in errors, logs, HTML, or receipts (redaction tests + manual grep proof in Task 8/10 reports).
6. IMAP fixtures thread by headers first, sender-domain only when unambiguous; classification suggestions require user confirmation except ack ≥ 0.9 auto-ack (event log proves trigger "classification"); no key → sync still stores messages.
7. Retention modes enforced (metadata_only default stores no body; days_limited purges).
8. P3 backlog burned (real hasMaterials + CV selector, replay guard, tie-break order, shared chips, two-workspace test).
9. Compose config carries every new env var on the right services (verified via `docker compose config` in the introducing tasks — no P2/P3-style seam repeat).
