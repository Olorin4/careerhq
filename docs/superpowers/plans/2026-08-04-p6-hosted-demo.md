# CareerHQ P6 — Hosted Demo and Portfolio Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the finished application into a public, safe, self-resetting demo at `https://careerhq.nickkalas.dev` — sandbox workspace mode, rate limits, a 6-hourly reset, AI and browser bounded for a shared 3.7 GB VPS — plus the portfolio surface a prospective client actually reads: screenshots, a recorded walkthrough, `SECURITY.md`, an MIT `LICENSE`, and a one-command quickstart.

**Architecture:** Demo safety is a *runtime mode*, not a fork: one new `DEMO_MODE` env plus the existing `workspaces.kind = "sandbox"` row selects a demo workspace, and every already-built gate (`SANDBOX_FORCE_SAFE`, the sandbox adapter block, AI replay) is finally wired to it. Nothing about the personal-mode code path changes. A `docker-compose.demo.yml` composes the same images with demo env, hard memory caps, and a browser-concurrency guard; the reset job truncates and reseeds the sandbox workspace on a cron.

**Tech Stack:** unchanged — Next.js 15, pg-boss, Postgres 17, Playwright, Docker Compose. Deployment: existing `edge-nginx` (Cloudflare origin certs) on Hetzner CX23 `167.233.94.188`.

## Global Constraints

- **The demo must not be able to reach any real external target (spec §3).** Sandbox enforcement stays at the adapter layer, never the UI: email → Mailpit only, auto-apply → the bundled `demo-ats` origin only, and both env gates (`SUBMISSIONS_LIVE_EMAIL`, `SUBMISSIONS_LIVE_COMPANY_SITE`) stay **false** in the demo compose. A demo visitor must not be able to flip any of this.
- **Zero real personal data (spec §1.6).** The demo serves only the fictional "Alex Demo" persona. Credential setup (`/settings/email`) is disabled in sandbox — no visitor may store a secret, and no real mailbox is ever configured.
- **Shared-host discipline.** The VPS runs the owner's other services (`edge-nginx`, kelevo staging api/postgres/redis, outreach, iwd-backend, twilio-app) on 3.7 GB RAM / 2 GB swap. Every CareerHQ container declares a hard `mem_limit`; the demo must never be able to starve a neighbour. Chromium runs **one at a time, globally**.
- **AI runs in replay in the demo** (`AI_MODE=replay`): no OpenRouter key is deployed, so the demo cannot spend tokens or depend on provider uptime; the deterministic floor still applies where a fixture is missing.
- **Reset every 6 hours**: the sandbox workspace is truncated and reseeded so visitor edits never accumulate and the demo is always the same story.
- Repo conventions: TS strict, no `any`; ESM `.js` specifiers; established test harnesses (`skipIf(!TEST_DATABASE_URL)` on `postgres://careerhq:careerhq@localhost:5433/careerhq`, demo-ats on `localhost:3001`); conventional commits ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; **every new env var lands in `.env.example` AND the compose file in the task that introduces it** (the standing lesson from P2/P3).
- New env vars: `DEMO_MODE` (web+worker, default `false`), `DEMO_RESET_CRON` (worker, default `0 */6 * * *`), `DEMO_RATE_LIMIT_PER_MIN` (web, default `30`), `AUTOAPPLY_MAX_CONCURRENT_BROWSERS` (worker+web, default `1`).
- **Deployment is outward-facing.** SSH to `hetzner-staging` is approved for this session only. Task 11 asks for explicit confirmation before the first `docker compose up` and before the DNS record makes the URL public; nothing is deployed by any earlier task.

---

### Task 1: Security hardening required before public exposure

**Files:**
- Create: `apps/web/src/lib/safe-url.ts`
- Modify: `apps/web/src/app/(dashboard)/facts/page.tsx`, `apps/web/src/app/(dashboard)/jobs/job-row.tsx`, `apps/web/src/app/(dashboard)/applications/[id]/page.tsx`, `packages/db/src/repos/facts.ts`, `packages/db/src/repos/documents.ts`, `packages/db/src/repos/answers.ts`
- Test: `apps/web/src/lib/safe-url.test.ts`, extend `packages/db/src/repos/facts.test.ts`

**Interfaces:**
- Produces:
```ts
// safe-url.ts — the only place a stored URL becomes an href
export function safeExternalHref(raw: string | null | undefined): string | null;
// Returns the URL only when it parses AND its protocol is http: or https:.
// Everything else — javascript:, data:, vbscript:, file:, blob:, a relative
// string, an unparseable value — returns null so the caller renders plain text.
```
- Every `href={someStoredUrl}` in the dashboard goes through it; when it returns `null` the component renders the URL as text (never an anchor).
- **Workspace-scoped mutations** (the P4 finding deferred to P6): `archiveFact`, `reverifyFact`, `updateFact`, `setDocumentApproval`, `approveAnswer`, `rejectAnswer` currently take a bare id. Add a required `workspaceId` parameter and scope the `where` clause (fact/document/answer → its application → workspace, matching `listReusableAnswers`'s existing join). Update every call site to pass the active workspace.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/safe-url.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { safeExternalHref } from "./safe-url.js";

describe("safeExternalHref", () => {
  it("passes ordinary http(s) URLs through unchanged", () => {
    expect(safeExternalHref("https://boards.greenhouse.io/acme/jobs/1")).toBe("https://boards.greenhouse.io/acme/jobs/1");
    expect(safeExternalHref("http://example.test/x")).toBe("http://example.test/x");
  });
  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "blob:https://x.example/abc",
  ])("refuses %s", (raw) => {
    expect(safeExternalHref(raw)).toBeNull();
  });
  it("refuses relative, empty and unparseable values", () => {
    for (const raw of ["/applications/1", "", "   ", "not a url", null, undefined]) {
      expect(safeExternalHref(raw)).toBeNull();
    }
  });
});
```
`packages/db/src/repos/facts.test.ts` (append) — the scoping proof:
```ts
it("refuses to archive a fact belonging to another workspace", async () => {
  const other = await db.insert(workspaces).values({ name: `t-other-${Date.now()}`, kind: "personal" }).returning();
  const otherId = other[0]!.id;
  try {
    const fact = await createFact(db, {
      workspaceId: otherId, category: "skill", claim: "Other workspace fact", reviewBy: new Date("2027-01-01"),
    });
    await archiveFact(db, workspaceId, fact.id);              // wrong workspace
    const stillVisible = await listFacts(db, otherId);
    expect(stillVisible.find((f) => f.id === fact.id)).toBeDefined();  // untouched
  } finally {
    await db.delete(workspaces).where(eq(workspaces.id, otherId));
  }
});
```
- [ ] **Step 2: FAIL runs** — `pnpm --filter @careerhq/web test` and `TEST_DATABASE_URL=… pnpm --filter @careerhq/db test`.
- [ ] **Step 3: Implement** `safeExternalHref`; route every stored-URL href through it; add the `workspaceId` parameter to the six repo functions and fix all call sites (typecheck will enumerate them).
- [ ] **Step 4: PASS + full repo gate.**
- [ ] **Step 5: Commit** — `fix(web,db): protocol-allowlist stored URLs and workspace-scope single-record mutations`

---

### Task 2: Demo mode — sandbox workspace, disabled credentials, banner

**Files:**
- Modify: `packages/config/src/index.ts` (+ test), `apps/web/src/lib/workspace.ts`, `apps/web/src/app/(dashboard)/settings/email/page.tsx`, `apps/web/src/app/(dashboard)/settings/email/actions.ts`, `apps/web/src/app/layout.tsx`, `apps/web/src/app/globals.css`, `apps/worker/src/lib/workspace.ts`, `.env.example`
- Test: `apps/web/src/lib/workspace.test.ts` (new), `packages/config/src/index.test.ts` (append)

**Interfaces:**
- Produces:
```ts
// config
demoMode: boolean;                       // DEMO_MODE, default false
// apps/web/src/lib/workspace.ts
export async function getActiveWorkspace(db: Db, opts?: { demoMode?: boolean }): Promise<Workspace>;
// demoMode true  → resolve the SANDBOX workspace (kind "sandbox"), creating "CareerHQ Demo" if absent
// demoMode false → unchanged: oldest personal workspace, creating "My workspace" if absent
// The worker's getPersonalWorkspaceId gains the same demo-aware sibling so the reset/sync jobs
// operate on the same workspace the web app serves.
```
- **Credential setup disabled in sandbox (spec §3):** `/settings/email` renders an explanatory panel instead of the connection form when `config.demoMode`; `createConnectionAction` and `testConnectionAction` refuse with `{ok:false, reason:"disabled in the hosted demo"}` **server-side** — the UI state is not the enforcement.
- **Demo banner:** a fixed top strip in `layout.tsx` when `config.demoMode` — "Demo — data resets every 6 hours. Sending is disabled; nothing leaves this server." with a link to the GitHub repo. Styled in `globals.css`, always visible, never dismissible.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/workspace.test.ts` (real db, `skipIf(!TEST_DATABASE_URL)`):
```ts
it("resolves the sandbox workspace in demo mode, creating it when absent", async () => {
  const ws = await getActiveWorkspace(db, { demoMode: true });
  expect(ws.kind).toBe("sandbox");
});
it("resolves the personal workspace when demo mode is off", async () => {
  const ws = await getActiveWorkspace(db, { demoMode: false });
  expect(ws.kind).toBe("personal");
});
it("never returns a personal workspace in demo mode even when one exists", async () => {
  await db.insert(workspaces).values({ name: `t-personal-${Date.now()}`, kind: "personal" });
  const ws = await getActiveWorkspace(db, { demoMode: true });
  expect(ws.kind).toBe("sandbox");
});
```
`packages/config/src/index.test.ts` (append): `DEMO_MODE` absent → `false`; `"true"` → `true`.

- [ ] **Step 2: FAIL runs.** **Step 3: Implement** (config, both workspace resolvers, the settings refusal, the banner). **Step 4: PASS + repo gate.**
- [ ] **Step 5: Commit** — `feat(web,worker,config): demo mode with sandbox workspace, disabled credentials and banner`

---

### Task 3: Mutation rate limiting

**Files:**
- Create: `apps/web/src/lib/rate-limit.ts`
- Modify: `apps/web/src/app/(dashboard)/applications/[id]/site-actions.ts`, `.../materials-actions.ts`, `.../qa-actions.ts`, `.../email-actions.ts`, `apps/web/src/app/(dashboard)/jobs/actions.ts`, `apps/web/src/app/api/generate/stream/route.ts`, `packages/config/src/index.ts` (+ test), `.env.example`
- Test: `apps/web/src/lib/rate-limit.test.ts`

**Interfaces:**
- Produces:
```ts
export interface RateLimitResult { ok: true } | { ok: false; retryAfterSeconds: number }
export function checkRateLimit(bucket: string, opts: { limit: number; windowMs?: number; now?: number }): RateLimitResult;
// Fixed-window counter in a module-level Map keyed by bucket. windowMs default 60_000.
// Single-process is correct here: the demo runs one web container.
export function clearRateLimits(): void;   // test hook
```
- Config: `demoRateLimitPerMin: number` (`DEMO_RATE_LIMIT_PER_MIN`, default 30).
- Every **mutating** server action and the stream route call `checkRateLimit("<action-name>", { limit: config.demoRateLimitPerMin })` **only when `config.demoMode`** — personal self-hosted use is never throttled. On refusal they return the action's existing failure shape with a "too many requests, try again in Ns" reason (they must not throw).

- [ ] **Step 1: Write the failing test**
```ts
import { beforeEach, describe, expect, it } from "vitest";
import { checkRateLimit, clearRateLimits } from "./rate-limit.js";

describe("checkRateLimit", () => {
  beforeEach(() => clearRateLimits());
  it("allows up to the limit then refuses with a retry hint", () => {
    for (let i = 0; i < 3; i += 1) expect(checkRateLimit("b", { limit: 3, now: 1000 }).ok).toBe(true);
    const refused = checkRateLimit("b", { limit: 3, now: 1000 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });
  it("starts a fresh window after windowMs", () => {
    checkRateLimit("b", { limit: 1, now: 1000 });
    expect(checkRateLimit("b", { limit: 1, now: 1000 }).ok).toBe(false);
    expect(checkRateLimit("b", { limit: 1, now: 1000 + 60_000 }).ok).toBe(true);
  });
  it("keeps buckets independent", () => {
    checkRateLimit("a", { limit: 1, now: 1000 });
    expect(checkRateLimit("b", { limit: 1, now: 1000 }).ok).toBe(true);
  });
});
```
- [ ] **Step 2: FAIL.** **Step 3: Implement + wire the call sites.** **Step 4: PASS + repo gate.**
- [ ] **Step 5: Commit** — `feat(web): per-action rate limiting for the hosted demo`

---

### Task 4: Demo seed and the 6-hourly reset job

**Files:**
- Create: `packages/db/src/demo-seed.ts`, `apps/worker/src/jobs/demo-reset.ts`
- Modify: `packages/db/src/index.ts`, `apps/worker/src/main.ts`, `packages/config/src/index.ts` (+ test), `.env.example`
- Test: `apps/worker/src/jobs/demo-reset.test.ts`

**Interfaces:**
- Consumes: the P1 seed's approach (build state by replaying real repo calls, never writing `state` directly).
- Produces:
```ts
// packages/db/src/demo-seed.ts
export const DEMO_WORKSPACE_NAME = "CareerHQ Demo";
export async function seedDemoWorkspace(db: Db, opts: { fileStorageDir: string }): Promise<{ workspaceId: string }>;
// Idempotent: deletes the sandbox workspace named DEMO_WORKSPACE_NAME (cascades) and rebuilds it.
// Content: the Alex Demo persona (facts incl. one stale + one sensitive), 2 CV variants, ~12 applications
// spread across every state, ~30 discovery jobs with scores/breakdowns, one approved cover letter and
// one approved email body, 2 reusable answers, one email connection pointing at MAILPIT (so the
// email panel is explorable), a couple of inbound messages with a pending classification suggestion,
// and one company_site attempt already SUBMITTED with receipts + screenshot so the evidence is visible.
// apps/worker/src/jobs/demo-reset.ts
export async function runDemoResetOnce(db: Db, config: AppConfig): Promise<{ workspaceId: string; durationMs: number }>;
// main.ts registers queue "demo.reset" scheduled on config.demoResetCron ONLY when config.demoMode.
```
- Config: `demoResetCron: string` (`DEMO_RESET_CRON`, default `"0 */6 * * *"`).

- [ ] **Step 1: Write the failing test** — real db: run `runDemoResetOnce` twice; assert it is idempotent (same counts, no duplicate workspace), that the workspace is `kind: "sandbox"` and named `DEMO_WORKSPACE_NAME`, that a visitor-made change (insert an extra application into the sandbox) is gone after the next reset, and that a **personal** workspace in the same database is untouched by the reset.
- [ ] **Step 2: FAIL.** **Step 3: Implement.** **Step 4: PASS + repo gate.**
- [ ] **Step 5: Commit** — `feat(db,worker): demo workspace seed and scheduled reset`

---

### Task 5: Bounded browser — one at a time, everywhere

**Files:**
- Create: `apps/worker/src/autoapply/browser-limit.ts`
- Modify: `apps/worker/src/autoapply/driver.ts`, `apps/worker/src/autoapply/index.ts`, `apps/web/src/lib/site-driver.ts`, `packages/config/src/index.ts` (+ test), `.env.example`
- Test: `apps/worker/src/autoapply/browser-limit.test.ts`

**Interfaces:**
- Produces:
```ts
export class BrowserBusyError extends Error {}
export function configureBrowserLimit(maxConcurrent: number): void;   // from config at wiring time
export async function withBrowserSlot<T>(fn: () => Promise<T>): Promise<T>;
// Acquires one of maxConcurrent slots (default 1). If none is free it does NOT queue —
// it throws BrowserBusyError immediately, so a demo visitor gets an honest
// "the demo browser is busy, try again in a moment" instead of a request that hangs
// until a timeout. The slot is always released in a finally.
```
- `openSession()` acquires the slot; `BrowserSession.close()` releases it. `site-submission.ts` maps `BrowserBusyError` to the existing `blocked { code: "driver_unavailable" }` outcome with a busy-specific reason — importantly **before `beginSubmission`**, so a busy browser never burns a confirmation token (the P5 H1(b) property must hold for this new failure too).
- Config: `autoapplyMaxConcurrentBrowsers: number` (`AUTOAPPLY_MAX_CONCURRENT_BROWSERS`, default 1).

- [ ] **Step 1: Write the failing test**
```ts
it("serialises: a second concurrent acquirer is refused, not queued", async () => {
  configureBrowserLimit(1);
  let release!: () => void;
  const held = withBrowserSlot(() => new Promise<void>((r) => { release = r; }));
  await expect(withBrowserSlot(async () => "second")).rejects.toBeInstanceOf(BrowserBusyError);
  release();
  await held;
  await expect(withBrowserSlot(async () => "third")).resolves.toBe("third");
});
it("releases the slot even when the body throws", async () => {
  configureBrowserLimit(1);
  await expect(withBrowserSlot(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  await expect(withBrowserSlot(async () => "ok")).resolves.toBe("ok");
});
```
- [ ] **Step 2: FAIL.** **Step 3: Implement + wire.** **Step 4: PASS + full repo gate (the live driver and site-e2e suites must stay green — they run one browser at a time already).**
- [ ] **Step 5: Commit** — `feat(worker,web): global browser concurrency limit with honest refusal`

---

### Task 6: Live-page re-verification before typing (carried F5)

**Files:**
- Modify: `packages/autoapply/src/raw.ts`, `apps/worker/src/autoapply/driver.ts`, `apps/web/src/lib/site-submission.ts`
- Test: `packages/autoapply/src/raw.test.ts` (append), `apps/worker/src/autoapply/driver.test.ts` (append)

**Interfaces:**
- Produces:
```ts
// raw.ts
export function fieldIdentityHash(field: Pick<RawField, "selector" | "labelText">): string;
// sha256(selector + "\n" + collapsed(labelText)).slice(0,16) — what the user actually reviewed:
// this control, asking this question.
```
- `fillAndSubmit` re-extracts the page (it already does) and, before typing anything, compares each answered field's `fieldIdentityHash` against the hash captured at prepare time (carried on the `CanonicalFormField` as a new optional `identityHash`). Any mismatch → `DriverError(kind: "fill")` naming the field, i.e. a **provably pre-click** failure, so the orchestrator reports `failed` and the attempt is retryable rather than parked (the P5 classification, already fixed, gives this for free).
- Rationale to state in the code comment: a consent tick's whole meaning is the statement beside it; if the page changed the question under our selector between review and submit, the recorded consent no longer describes what would be submitted.

- [ ] **Step 1: Write the failing tests** — `fieldIdentityHash` stable for identical selector+label, different when the label changes, whitespace-insensitive. Driver: capture a demo-ats page, mutate the stored `identityHash` for one answered field, run `fillAndSubmit`, expect a `DriverError` with `kind === "fill"` naming that field and **no submission recorded** at demo-ats.
- [ ] **Step 2: FAIL.** **Step 3: Implement.** **Step 4: PASS + repo gate.**
- [ ] **Step 5: Commit** — `feat(autoapply,worker): refuse to fill a field whose question changed since review`

---

### Task 7: Demo compose stack and image slimming

**Files:**
- Create: `infra/docker-compose.demo.yml`, `infra/demo.env.example`
- Modify: `infra/Dockerfile.web`, `infra/Dockerfile.worker`, `.dockerignore`

**Interfaces:**
- Produces `docker compose -f infra/docker-compose.yml -f infra/docker-compose.demo.yml up -d` composing the same images with:
  - `DEMO_MODE=true`, `AI_MODE=replay`, `SUBMISSIONS_LIVE_EMAIL=false`, `SUBMISSIONS_LIVE_COMPANY_SITE=false`, `SANDBOX_SITE_ALLOWED_HOST=demo-ats`, `SANDBOX_SMTP_ALLOWED_HOST=mailpit`, `DEMO_RESET_CRON=0 */6 * * *`, `DEMO_RATE_LIMIT_PER_MIN=30`, `AUTOAPPLY_MAX_CONCURRENT_BROWSERS=1`, and **no** `OPENROUTER_API_KEY` / `CAREERHQ_MASTER_KEY`.
  - Hard caps sized for the shared box: `web` `mem_limit: 900m`, `worker` `mem_limit: 1200m` (it hosts Chromium), `postgres` `mem_limit: 400m`, `demo-ats` `mem_limit: 128m`, `mailpit` `mem_limit: 128m`; every service `restart: unless-stopped`.
  - The web container published on `127.0.0.1:3100` only (never 0.0.0.0 — `edge-nginx` reaches it over the shared Docker network or the loopback publish; use whichever matches how the box's other stacks are wired, and say which you chose).
  - Mailpit's UI **not** published publicly; demo-ats **not** published publicly (both internal to the compose network).
- Image slimming (the box has limited disk): add `.next/cache`, `**/*.test.ts`, `**/fixtures/**` (except the AI replay fixtures the demo needs), `docs/`, `.superpowers/` to `.dockerignore`; in both Dockerfiles run `pnpm install --frozen-lockfile --prod=false` for the build stage then `pnpm prune --prod` before the runtime stage where feasible. Record the resulting `docker images` sizes in the report.
- [ ] **Step 1: Write the compose + Dockerfile changes.**
- [ ] **Step 2: Verify locally** — `docker compose -f infra/docker-compose.yml -f infra/docker-compose.demo.yml config` validates and shows every demo env var on the right service with the caps applied; **build both images locally** and record their sizes; bring the stack up locally on a spare port, confirm `/overview` serves the seeded demo workspace with the banner, `/settings/email` shows the disabled panel, and the reset job is registered. Paste transcripts.
- [ ] **Step 3: Commit** — `feat(infra): demo compose stack with hard memory caps and slimmer images`

---

### Task 8: AI replay fixtures for the demo flows

**Files:**
- Create: fixtures under `packages/ai/fixtures/replay/`
- Modify: `packages/db/src/demo-seed.ts` (only if a prompt's fact ids must be pinned)
- Test: `apps/web/src/lib/generation.test.ts` (append a replay-mode case)

**Interfaces:**
- Consumes: the P3 replay layer (`AI_MODE=record|replay`, key = `${taskId}-${sha256(system+"\n"+user).slice(0,16)}`).
- Produces committed fixtures so that, in the demo, these all return instantly with no API key: a cover-letter generation, an email-body generation, one screening-question answer, one reply classification, and one discovery re-rank — each recorded against the **demo seed's** exact prompts.
- **The prompt embeds live fact UUIDs**, so a fixture only hits if the seed produces stable ids. Make the demo seed deterministic for the facts used in generation (fixed UUIDs for those rows) and say so in the seed's comment — otherwise every reset invalidates every fixture. Record fixtures by running the demo seed, then `AI_MODE=record` with a real key locally, then verifying `AI_MODE=replay` hits.
- [ ] **Step 1: Make the seeded facts' ids deterministic; re-run the demo seed.**
- [ ] **Step 2: Record the fixtures** (local, real key, `AI_MODE=record`), then flip to `AI_MODE=replay` and prove each flow returns the recorded output with no network (assert via a test that a replay-mode generation succeeds with `openrouterApiKey: null`).
- [ ] **Step 3: PASS + repo gate.**
- [ ] **Step 4: Commit** — `feat(ai): replay fixtures for the hosted demo's AI flows`

---

### Task 9: Screenshot gallery and recorded walkthrough

**Files:**
- Create: `scripts/capture-demo-media.ts`, `docs/media/` (generated PNGs + the recording)
- Modify: `package.json` (root script `demo:media`), `.gitignore` (do NOT ignore `docs/media`)

**Interfaces:**
- Produces a Playwright script that drives the **local demo stack** and captures, at 1440×900 with the demo seed:
  1. `/overview` (funnel + due follow-ups), 2. `/applications` (Kanban), 3. an application detail showing the event timeline, 4. `/jobs` (scored discovery inbox with a score breakdown expanded), 5. the materials panel showing an AI draft with provenance chips, 6. the NEEDS_FACTS block, 7. `/answers`, 8. the auto-apply review screen with the consent tick and a sensitive lock badge, 9. the preview + retype-target confirm, 10. `/inbox` with a classification suggestion.
- And a **recorded walkthrough** (Playwright `recordVideo`, ~2–3 min at a readable pace) covering: discovery → promote → generate a grounded cover letter → auto-apply review → consent tick → preview → confirm → the receipt. Convert to MP4 if `ffmpeg` is available, else keep the WebM and say so.
- The script must be re-runnable (`pnpm demo:media`) so the gallery can be regenerated when the UI changes — that is the point of automating it.
- [ ] **Step 1: Write the script; run it against the local demo stack.**
- [ ] **Step 2: Inspect every produced image** (they go in the README — check for empty states, error banners, or a half-rendered page) and re-run until each is representative. State in the report what each image shows.
- [ ] **Step 3: Commit** — `docs: automated screenshot gallery and demo walkthrough recording`

---

### Task 10: SECURITY.md, LICENSE, README final, backup/restore

**Files:**
- Create: `SECURITY.md`, `LICENSE`, `docs/runbook-demo.md`
- Modify: `README.md`, `docs/architecture.md`

**Interfaces:**
- `LICENSE`: MIT, `Copyright (c) 2026 Nick Kalas`. Remove the README's "license file added at public release" hedge.
- `SECURITY.md`: what the project protects and what it does not — credentials encrypted at rest with an env master key (ADR-0005) and the explicit non-goal of defending against host/root compromise; the three-layer submission gate; sandbox demo isolation; the deliberate exclusions (no restricted-board automation, no CAPTCHA bypass); how to report an issue (email); and a plain statement that the hosted demo holds only fictional data.
- `README.md` final: the screenshot gallery from Task 9 with one-line captions, the walkthrough recording, the live demo URL and what a visitor can/can't do there, the one-command quickstart verified from a clean clone, the env table complete with the four new vars, and P1–P6 marked done in **both** status locations (the recurring check).
- `docs/runbook-demo.md`: deploy, update (`git pull && docker compose … up -d --build`), inspect logs, force a reset (`docker compose … exec worker node dist/jobs/demo-reset-cli.js` or the documented equivalent), **backup** (`pg_dump` of the demo db + `tar` of the file volume, with the exact commands) and **restore**, and rollback.
- `docs/architecture.md`: refresh the system diagram to show the demo compose overlay and the edge proxy.
- [ ] **Step 1: Write all four docs.**
- [ ] **Step 2: Verify the quickstart literally** — clone the repo to a fresh temp dir, follow the README's steps verbatim, and confirm the app comes up. Any step that doesn't work as written is a doc bug to fix now. Paste the transcript.
- [ ] **Step 3: Commit** — `docs: SECURITY.md, MIT LICENSE, demo runbook and final README`

---

### Task 11: Deploy to the VPS

**Files:**
- Create: `infra/edge/careerhq.nickkalas.dev.conf` (the vhost, committed for reproducibility)
- Modify: `docs/runbook-demo.md` (fill in the real values discovered during deploy)

**Interfaces:**
- Target: Hetzner CX23, SSH alias `hetzner-staging`, public IPv4 `167.233.94.188`, IPv6 `2a01:4f8:1c1c:d8c2::1`. Existing `edge-nginx` terminates TLS on 80/443 using Cloudflare **origin certificates** mounted from `/home/nick-kalas/infra/edge/certs`, with vhosts in `/home/nick-kalas/infra/edge/conf.d`. `nickkalas.dev` is already on Cloudflare (`katja/doug.ns.cloudflare.com`); `careerhq.nickkalas.dev` has **no** record yet.
- **This task performs outward-facing changes on a shared server running the owner's other services. Confirm with the owner immediately before: (a) the prune, (b) the first `docker compose up`, and (c) creating the DNS record that makes the URL public.** Never restart or reconfigure a neighbouring container.
- Steps, in order:
  1. **Reclaim space** (owner already approved cache + dangling images): `docker builder prune -f` and `docker image prune -f`; record `df -h /` and `docker system df` before and after.
  2. **Cert**: `*.nickkalas.dev` is not covered by the two existing origin certs. Either create a Cloudflare origin certificate for `*.nickkalas.dev` + `nickkalas.dev` and install it as `certs/origin-nickkalas.{pem,key}` (owner supplies it, or authorises the Cloudflare MCP to create it), or — if the owner prefers — use the zone's existing cert if one already exists on another host. Record which was used. Key file must be `chmod 600`.
  3. **Deploy the stack**: clone the repo into `/home/nick-kalas/apps/careerhq`, create the demo env file from `infra/demo.env.example`, `docker compose -f infra/docker-compose.yml -f infra/docker-compose.demo.yml up -d --build`, wait for health, run the demo seed once.
  4. **Vhost**: add `careerhq.nickkalas.dev.conf` to `conf.d` (80 → 301 https; 443 with the origin cert, `proxy_pass` to the web container, `proxy_set_header Host/X-Forwarded-*`, and a sane `client_max_body_size` for CV uploads), then `docker exec edge-nginx nginx -t` **before** `nginx -s reload`. If `-t` fails, fix before reloading — a broken reload takes down the owner's other sites.
  5. **DNS**: create the proxied A record `careerhq` → `167.233.94.188` in the `nickkalas.dev` zone (and AAAA if the owner wants IPv6).
  6. **Smoke the public URL**: `curl -sI https://careerhq.nickkalas.dev/` → 200/307; the demo banner present; `/settings/email` shows the disabled panel; a discovery→promote→generate→auto-apply→confirm walkthrough completes against the bundled demo-ats; **verify the neighbours are still healthy** (`docker ps`, and one request to each existing vhost).
  7. **Confirm the safety posture on the live box**: both live-submission gates read `false`, no `OPENROUTER_API_KEY` and no `CAREERHQ_MASTER_KEY` in the container env, Mailpit and demo-ats unreachable from outside, and the reset job scheduled.
- [ ] **Step 1: Run the deploy in the order above, confirming at the three named points.** **Step 2: Paste every transcript into the report, including the before/after disk figures and the neighbour health check.**
- [ ] **Step 3: Commit** — `infra: edge vhost for the hosted demo`

---

### Task 12: Final verification

**Files:** none (verification only), except fixes anything below surfaces.
- [ ] **Step 1: Full gate, uncached, default concurrency** — `pnpm lint && pnpm typecheck && pnpm depcruise && pnpm build && TEST_DATABASE_URL=postgres://careerhq:careerhq@localhost:5433/careerhq pnpm test --force`. Paste tails.
- [ ] **Step 2: Live demo audit** — from a machine that is not the VPS: the public URL serves the demo; the banner is present; sending is impossible (attempt an email confirm → `gate_closed`); credential setup is refused; rate limiting bites (hammer one action past the limit and get the friendly refusal, not a stack trace); a second concurrent auto-apply prepare is refused with the busy message rather than hanging; and after a forced reset the workspace is back to its seeded state.
- [ ] **Step 3: Report the resource footprint** — `docker stats --no-stream` for the CareerHQ containers plus `free -h` and `df -h /`, so the owner knows exactly what the demo costs on their box.
- [ ] **Step 4: Commit** any fixes; final commit message `chore: P6 verification`.

---

## Final Verification (Definition of Done for P6)

1. `https://careerhq.nickkalas.dev` serves the seeded demo over TLS, with the demo banner and the owner's other sites unaffected.
2. The demo cannot mutate anything outside itself: both live gates false, sandbox adapter block active, no LLM key, no master key, credential setup refused server-side, Mailpit/demo-ats not publicly reachable.
3. Visitor edits vanish on the 6-hourly reset; the seed is idempotent and never touches a personal workspace.
4. Rate limiting and the single-browser guard both refuse honestly (a message, not a hang or a crash), and a busy browser never burns a confirmation token.
5. Stored URLs can never become `javascript:` hrefs; single-record mutations are workspace-scoped.
6. A field whose question changed between review and submit is refused pre-click (carried F5).
7. README carries the generated gallery, the walkthrough recording, the live URL, and a quickstart verified from a clean clone; `SECURITY.md` and an MIT `LICENSE` (Nick Kalas) exist; P1–P6 marked done in both status locations.
8. The runbook documents deploy, update, forced reset, backup, restore and rollback with real commands.
9. Full gate green, uncached; the recorded footprint leaves the box with headroom.
