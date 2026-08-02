# CareerHQ P1 — Foundation, Tracker, Fact Bank Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the CareerHQ monorepo skeleton with the application tracker (guarded state machine + event log + Kanban UI + next-action panel), Candidate Fact Bank, CV variants, seed data, Docker Compose stack, and CI — Phase P1 of `docs/roadmap.md`, per spec `career-hq-product-spec.md` v0.3 (§1, §2, §3, §6, §7.1, §12, §14, §16, §17).

**Architecture:** pnpm + Turborepo monorepo. Pure domain logic (state machines, next-action) lives in `packages/core` with zero IO; `packages/contracts` holds shared Zod enums/types; `packages/db` holds Drizzle schema + repositories; `apps/web` (Next.js 15 App Router, server actions) and `apps/worker` (pg-boss) are the only composition roots. Application state is a projection of an append-only `application_events` log; every transition goes through `core` guards inside a DB transaction.

**Tech Stack:** Node 22, pnpm 10, TypeScript 5 (strict), Turborepo 2, Next.js 15 + React 19, Drizzle ORM + `postgres` driver + drizzle-kit, PostgreSQL 17, pg-boss 10, Zod 3, Vitest 3, ESLint 9 + Prettier, dependency-cruiser, GitHub Actions.

## Global Constraints

- Application states, verbatim (spec §6.1): `DISCOVERED, SHORTLISTED, PREPARING, READY_FOR_REVIEW, SUBMITTED, ACKNOWLEDGED, INTERVIEW, OFFER, REJECTED, WITHDRAWN, EXPIRED`.
- Attempt statuses, verbatim (spec §12 / architecture §3): `DRAFT, READY, PENDING_CONFIRMATION, SUBMITTING, SUBMITTED, FAILED, BLOCKED, NEEDS_RECONCILE`.
- Transition triggers: `user, attempt, classification, system`. Fact categories (spec §7.1): `identity, contact, experience, education, skill, preference, authorization, compensation, availability`.
- Package dependency rules (architecture §2, enforced by dependency-cruiser in Task 17): `contracts` ← everything; `core` imports ONLY `contracts`; `db` imports `contracts` (+`core` allowed); only `apps/*` compose everything. `core` never imports `db` or does IO.
- All domain tables carry `workspace_id` (spec §3). Tables snake_case. The `applications.state` column is a projection of `application_events` — never update state without appending an event in the same transaction.
- Users can never set `SUBMITTED` directly via transition; only trigger `attempt`, or creation via the manual-external path (spec §6.2).
- No real personal data anywhere — seed persona is "Alex Demo" (spec §1.6).
- Follow-up default: SUBMITTED/ACKNOWLEDGED +7 days (spec §6.2), configurable via `FOLLOW_UP_DAYS`.
- TypeScript `strict: true`, no `any`. ESM everywhere (`"type": "module"`).
- Commit messages: conventional prefix (`feat:`, `chore:`, `test:`, `docs:`), each ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Owner login (spec §14) is deferred to P6 by roadmap decision — do not build auth in P1.

---

### Task 1: Monorepo scaffold and tooling

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`, `.nvmrc`, `eslint.config.mjs`, `.prettierrc.json`
- Create: `apps/.gitkeep`, `packages/.gitkeep` (removed as apps/packages land)

**Interfaces:**
- Produces: workspace-wide scripts `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` (Turbo pipelines); `tsconfig.base.json` that every package extends; path-independent ESM setup.

- [ ] **Step 1: Initialize workspace files**

`package.json`:
```json
{
  "name": "careerhq",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.14.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "turbo run build",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "turbo": "^2.5.0",
    "typescript": "^5.9.0",
    "prettier": "^3.6.0",
    "eslint": "^9.30.0",
    "typescript-eslint": "^8.35.0",
    "@eslint/js": "^9.30.0"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
  - "packages/*"
  - "services/*"
```

`turbo.json`:
```json
{
  "$schema": "https://turborepo.dev/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "lint": {},
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] }
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "verbatimModuleSyntax": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`eslint.config.mjs`:
```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["**/dist/**", "**/.next/**", "**/node_modules/**"],
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
```

`.prettierrc.json`: `{ "printWidth": 100 }`
`.nvmrc`: `22`
`.gitignore`:
```
node_modules/
dist/
.next/
.turbo/
.env
.env.local
*.tsbuildinfo
var/
```

- [ ] **Step 2: Install and verify**

Run: `pnpm install && pnpm exec turbo --version && pnpm exec tsc --version`
Expected: installs cleanly; turbo 2.x and tsc 5.x print versions.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: monorepo scaffold (pnpm, turborepo, ts strict, eslint)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `packages/contracts` — shared enums and types

**Files:**
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/index.test.ts`

**Interfaces:**
- Produces (exact exports every later task imports from `@careerhq/contracts`):
  - `APPLICATION_STATES`, `type ApplicationState`
  - `ATTEMPT_STATUSES`, `type AttemptStatus`
  - `TRANSITION_TRIGGERS`, `type TransitionTrigger`
  - `CHANNELS` (`['email','company_site','external']`), `type Channel`
  - `FACT_CATEGORIES`, `type FactCategory`
  - `SENSITIVITIES` (`['normal','sensitive']`), `type Sensitivity`
  - `CV_FORMATS` (`['designed','ats']`), `type CvFormat`
  - `WORKSPACE_KINDS` (`['personal','sandbox']`), `type WorkspaceKind`
  - Zod schemas: `applicationStateSchema`, `attemptStatusSchema`, `transitionTriggerSchema`, `channelSchema`, `factCategorySchema`, `sensitivitySchema`, `cvFormatSchema`, `workspaceKindSchema`

- [ ] **Step 1: Package scaffold**

`packages/contracts/package.json`:
```json
{
  "name": "@careerhq/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint src",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^3.25.0" },
  "devDependencies": { "vitest": "^3.2.0" }
}
```

`packages/contracts/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

- [ ] **Step 2: Write the failing test**

`packages/contracts/src/index.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  APPLICATION_STATES,
  ATTEMPT_STATUSES,
  FACT_CATEGORIES,
  applicationStateSchema,
} from "./index.js";

describe("contracts", () => {
  it("defines the 11 application states verbatim from spec §6.1", () => {
    expect(APPLICATION_STATES).toEqual([
      "DISCOVERED", "SHORTLISTED", "PREPARING", "READY_FOR_REVIEW", "SUBMITTED",
      "ACKNOWLEDGED", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN", "EXPIRED",
    ]);
  });
  it("defines the 8 attempt statuses", () => {
    expect(ATTEMPT_STATUSES).toHaveLength(8);
    expect(ATTEMPT_STATUSES).toContain("NEEDS_RECONCILE");
  });
  it("defines the 9 fact categories from spec §7.1", () => {
    expect(FACT_CATEGORIES).toHaveLength(9);
  });
  it("rejects unknown states via zod", () => {
    expect(applicationStateSchema.safeParse("GHOSTED").success).toBe(false);
    expect(applicationStateSchema.safeParse("SUBMITTED").success).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @careerhq/contracts test`
Expected: FAIL — cannot resolve `./index.js`.

- [ ] **Step 4: Implement**

`packages/contracts/src/index.ts`:
```ts
import { z } from "zod";

export const APPLICATION_STATES = [
  "DISCOVERED", "SHORTLISTED", "PREPARING", "READY_FOR_REVIEW", "SUBMITTED",
  "ACKNOWLEDGED", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN", "EXPIRED",
] as const;
export type ApplicationState = (typeof APPLICATION_STATES)[number];
export const applicationStateSchema = z.enum(APPLICATION_STATES);

export const ATTEMPT_STATUSES = [
  "DRAFT", "READY", "PENDING_CONFIRMATION", "SUBMITTING",
  "SUBMITTED", "FAILED", "BLOCKED", "NEEDS_RECONCILE",
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export const attemptStatusSchema = z.enum(ATTEMPT_STATUSES);

export const TRANSITION_TRIGGERS = ["user", "attempt", "classification", "system"] as const;
export type TransitionTrigger = (typeof TRANSITION_TRIGGERS)[number];
export const transitionTriggerSchema = z.enum(TRANSITION_TRIGGERS);

export const CHANNELS = ["email", "company_site", "external"] as const;
export type Channel = (typeof CHANNELS)[number];
export const channelSchema = z.enum(CHANNELS);

export const FACT_CATEGORIES = [
  "identity", "contact", "experience", "education", "skill",
  "preference", "authorization", "compensation", "availability",
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];
export const factCategorySchema = z.enum(FACT_CATEGORIES);

export const SENSITIVITIES = ["normal", "sensitive"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];
export const sensitivitySchema = z.enum(SENSITIVITIES);

export const CV_FORMATS = ["designed", "ats"] as const;
export type CvFormat = (typeof CV_FORMATS)[number];
export const cvFormatSchema = z.enum(CV_FORMATS);

export const WORKSPACE_KINDS = ["personal", "sandbox"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];
export const workspaceKindSchema = z.enum(WORKSPACE_KINDS);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @careerhq/contracts test && pnpm --filter @careerhq/contracts build`
Expected: PASS; `dist/` emitted.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts && git commit -m "feat(contracts): shared state/category enums and zod schemas

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `packages/core` — application state machine

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/src/state/application.ts`
- Test: `packages/core/src/state/application.test.ts`

**Interfaces:**
- Consumes: `@careerhq/contracts` types.
- Produces (exact signatures, re-exported from `@careerhq/core`):
```ts
export interface TransitionContext {
  hasConfirmedAttempt?: boolean;      // guard for → SUBMITTED
  hasMaterials?: boolean;             // guard for PREPARING → READY_FOR_REVIEW
  classificationConfidence?: number;  // guard for classification-triggered ACKNOWLEDGED
}
export type TransitionCheck = { ok: true } | { ok: false; reason: string };
export function canTransition(
  from: ApplicationState, to: ApplicationState,
  trigger: TransitionTrigger, ctx?: TransitionContext,
): TransitionCheck;
export function legalTargets(from: ApplicationState, trigger: TransitionTrigger): ApplicationState[];
export const AUTO_ACK_CONFIDENCE = 0.9;
```

- [ ] **Step 1: Package scaffold**

`packages/core/package.json` — same shape as contracts, name `@careerhq/core`, plus `"dependencies": { "@careerhq/contracts": "workspace:*" }`, devDependency `vitest`. `tsconfig.json` identical pattern.

- [ ] **Step 2: Write the failing tests (spec §6.2 transition table)**

`packages/core/src/state/application.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { canTransition, legalTargets, AUTO_ACK_CONFIDENCE } from "./application.js";

describe("application state machine (spec §6.2)", () => {
  it("allows the happy path with user triggers", () => {
    expect(canTransition("DISCOVERED", "SHORTLISTED", "user").ok).toBe(true);
    expect(canTransition("SHORTLISTED", "PREPARING", "user").ok).toBe(true);
    expect(canTransition("INTERVIEW", "OFFER", "user").ok).toBe(true);
  });
  it("PREPARING → READY_FOR_REVIEW requires materials", () => {
    expect(canTransition("PREPARING", "READY_FOR_REVIEW", "user", { hasMaterials: false }).ok).toBe(false);
    expect(canTransition("PREPARING", "READY_FOR_REVIEW", "user", { hasMaterials: true }).ok).toBe(true);
  });
  it("user can NEVER set SUBMITTED directly", () => {
    const r = canTransition("READY_FOR_REVIEW", "SUBMITTED", "user", { hasConfirmedAttempt: true });
    expect(r.ok).toBe(false);
  });
  it("attempt trigger sets SUBMITTED only with a confirmed attempt", () => {
    expect(canTransition("READY_FOR_REVIEW", "SUBMITTED", "attempt", { hasConfirmedAttempt: true }).ok).toBe(true);
    expect(canTransition("READY_FOR_REVIEW", "SUBMITTED", "attempt", {}).ok).toBe(false);
  });
  it("classification auto-acks only at high confidence", () => {
    expect(canTransition("SUBMITTED", "ACKNOWLEDGED", "classification",
      { classificationConfidence: AUTO_ACK_CONFIDENCE }).ok).toBe(true);
    expect(canTransition("SUBMITTED", "ACKNOWLEDGED", "classification",
      { classificationConfidence: 0.5 }).ok).toBe(false);
    expect(canTransition("SUBMITTED", "ACKNOWLEDGED", "user").ok).toBe(true);
  });
  it("classification may never set INTERVIEW/OFFER/REJECTED (user-confirmed only)", () => {
    expect(canTransition("SUBMITTED", "INTERVIEW", "classification", { classificationConfidence: 1 }).ok).toBe(false);
    expect(canTransition("INTERVIEW", "OFFER", "classification", { classificationConfidence: 1 }).ok).toBe(false);
  });
  it("any active state can be REJECTED or WITHDRAWN by the user", () => {
    for (const from of ["DISCOVERED", "PREPARING", "SUBMITTED", "INTERVIEW", "OFFER"] as const) {
      expect(canTransition(from, "REJECTED", "user").ok).toBe(true);
      expect(canTransition(from, "WITHDRAWN", "user").ok).toBe(true);
    }
  });
  it("only DISCOVERED/SHORTLISTED can EXPIRE, via system", () => {
    expect(canTransition("DISCOVERED", "EXPIRED", "system").ok).toBe(true);
    expect(canTransition("SHORTLISTED", "EXPIRED", "system").ok).toBe(true);
    expect(canTransition("SUBMITTED", "EXPIRED", "system").ok).toBe(false);
  });
  it("terminal states have no exits", () => {
    for (const from of ["REJECTED", "WITHDRAWN", "EXPIRED"] as const) {
      expect(legalTargets(from, "user")).toEqual([]);
    }
  });
  it("legalTargets lists user-triggerable targets for the UI", () => {
    expect(legalTargets("DISCOVERED", "user")).toEqual(
      expect.arrayContaining(["SHORTLISTED", "REJECTED", "WITHDRAWN"]),
    );
    expect(legalTargets("READY_FOR_REVIEW", "user")).not.toContain("SUBMITTED");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @careerhq/contracts build && pnpm --filter @careerhq/core test`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`packages/core/src/state/application.ts`:
```ts
import type { ApplicationState, TransitionTrigger } from "@careerhq/contracts";

export const AUTO_ACK_CONFIDENCE = 0.9;

export interface TransitionContext {
  hasConfirmedAttempt?: boolean;
  hasMaterials?: boolean;
  classificationConfidence?: number;
}
export type TransitionCheck = { ok: true } | { ok: false; reason: string };

type Guard = (ctx: TransitionContext) => TransitionCheck;
const ok: TransitionCheck = { ok: true };
const pass: Guard = () => ok;

const requireMaterials: Guard = (ctx) =>
  ctx.hasMaterials ? ok : { ok: false, reason: "materials must exist for the chosen channel" };
const requireConfirmedAttempt: Guard = (ctx) =>
  ctx.hasConfirmedAttempt ? ok : { ok: false, reason: "a confirmed application attempt is required" };
const requireHighConfidence: Guard = (ctx) =>
  (ctx.classificationConfidence ?? 0) >= AUTO_ACK_CONFIDENCE
    ? ok
    : { ok: false, reason: "classification confidence below auto-acknowledge threshold" };

const ACTIVE: readonly ApplicationState[] = [
  "DISCOVERED", "SHORTLISTED", "PREPARING", "READY_FOR_REVIEW",
  "SUBMITTED", "ACKNOWLEDGED", "INTERVIEW", "OFFER",
];

type Edge = { to: ApplicationState; triggers: Partial<Record<TransitionTrigger, Guard>> };
const EDGES: Partial<Record<ApplicationState, Edge[]>> = {
  DISCOVERED: [
    { to: "SHORTLISTED", triggers: { user: pass } },
    { to: "EXPIRED", triggers: { system: pass, user: pass } },
  ],
  SHORTLISTED: [
    { to: "PREPARING", triggers: { user: pass } },
    { to: "EXPIRED", triggers: { system: pass, user: pass } },
  ],
  PREPARING: [{ to: "READY_FOR_REVIEW", triggers: { user: requireMaterials, system: requireMaterials } }],
  READY_FOR_REVIEW: [{ to: "SUBMITTED", triggers: { attempt: requireConfirmedAttempt } }],
  SUBMITTED: [
    { to: "ACKNOWLEDGED", triggers: { user: pass, classification: requireHighConfidence } },
    { to: "INTERVIEW", triggers: { user: pass } },
  ],
  ACKNOWLEDGED: [{ to: "INTERVIEW", triggers: { user: pass } }],
  INTERVIEW: [{ to: "OFFER", triggers: { user: pass } }],
};

function edgesFor(from: ApplicationState): Edge[] {
  const base = EDGES[from] ?? [];
  if (!ACTIVE.includes(from)) return base;
  return [
    ...base,
    { to: "REJECTED", triggers: { user: pass } },
    { to: "WITHDRAWN", triggers: { user: pass } },
  ];
}

export function canTransition(
  from: ApplicationState,
  to: ApplicationState,
  trigger: TransitionTrigger,
  ctx: TransitionContext = {},
): TransitionCheck {
  const edge = edgesFor(from).find((e) => e.to === to);
  if (!edge) return { ok: false, reason: `no transition ${from} → ${to}` };
  const guard = edge.triggers[trigger];
  if (!guard) return { ok: false, reason: `trigger '${trigger}' may not perform ${from} → ${to}` };
  return guard(ctx);
}

export function legalTargets(from: ApplicationState, trigger: TransitionTrigger): ApplicationState[] {
  return edgesFor(from)
    .filter((e) => e.triggers[trigger] !== undefined)
    .map((e) => e.to);
}
```

`packages/core/src/index.ts`:
```ts
export * from "./state/application.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @careerhq/core test`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add packages/core && git commit -m "feat(core): application state machine with spec §6.2 guards

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `packages/core` — attempt state machine, next action, follow-ups

**Files:**
- Create: `packages/core/src/state/attempt.ts`, `packages/core/src/next-action.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/state/attempt.test.ts`, `packages/core/src/next-action.test.ts`

**Interfaces:**
- Produces:
```ts
export function canAttemptTransition(from: AttemptStatus, to: AttemptStatus): TransitionCheck;
export interface NextAction { label: string; due: Date | null }
export function computeNextAction(input: {
  state: ApplicationState;
  submittedAt?: Date | null;
  lastEventAt?: Date | null;
  followUpDays?: number; // default 7
}): NextAction | null;   // null for terminal states
```

- [ ] **Step 1: Write the failing tests**

`packages/core/src/state/attempt.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { canAttemptTransition } from "./attempt.js";

describe("attempt lifecycle (architecture §3)", () => {
  it("follows DRAFT → READY → PENDING_CONFIRMATION → SUBMITTING → SUBMITTED", () => {
    expect(canAttemptTransition("DRAFT", "READY").ok).toBe(true);
    expect(canAttemptTransition("READY", "PENDING_CONFIRMATION").ok).toBe(true);
    expect(canAttemptTransition("PENDING_CONFIRMATION", "SUBMITTING").ok).toBe(true);
    expect(canAttemptTransition("SUBMITTING", "SUBMITTED").ok).toBe(true);
  });
  it("SUBMITTING may end FAILED, BLOCKED is pre-mutation only, NEEDS_RECONCILE post-mutation", () => {
    expect(canAttemptTransition("SUBMITTING", "FAILED").ok).toBe(true);
    expect(canAttemptTransition("SUBMITTING", "NEEDS_RECONCILE").ok).toBe(true);
    expect(canAttemptTransition("PENDING_CONFIRMATION", "BLOCKED").ok).toBe(true);
    expect(canAttemptTransition("SUBMITTED", "FAILED").ok).toBe(false);
  });
  it("NEEDS_RECONCILE resolves only to SUBMITTED or FAILED (human decision)", () => {
    expect(canAttemptTransition("NEEDS_RECONCILE", "SUBMITTED").ok).toBe(true);
    expect(canAttemptTransition("NEEDS_RECONCILE", "FAILED").ok).toBe(true);
    expect(canAttemptTransition("NEEDS_RECONCILE", "SUBMITTING").ok).toBe(false);
  });
  it("cannot skip the confirmation step", () => {
    expect(canAttemptTransition("READY", "SUBMITTING").ok).toBe(false);
    expect(canAttemptTransition("DRAFT", "SUBMITTED").ok).toBe(false);
  });
});
```

`packages/core/src/next-action.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { computeNextAction } from "./next-action.js";

describe("computeNextAction (spec §6.2)", () => {
  it("terminal states have no next action", () => {
    for (const state of ["REJECTED", "WITHDRAWN", "EXPIRED"] as const) {
      expect(computeNextAction({ state })).toBeNull();
    }
  });
  it("SUBMITTED gets a follow-up due submittedAt + 7 days by default", () => {
    const submittedAt = new Date("2026-08-01T00:00:00Z");
    const action = computeNextAction({ state: "SUBMITTED", submittedAt });
    expect(action?.label).toBe("Follow up");
    expect(action?.due?.toISOString()).toBe("2026-08-08T00:00:00.000Z");
  });
  it("follow-up window is configurable", () => {
    const submittedAt = new Date("2026-08-01T00:00:00Z");
    const action = computeNextAction({ state: "SUBMITTED", submittedAt, followUpDays: 3 });
    expect(action?.due?.toISOString()).toBe("2026-08-04T00:00:00.000Z");
  });
  it("pre-submission states get action labels without due dates", () => {
    expect(computeNextAction({ state: "DISCOVERED" })).toEqual({ label: "Shortlist or dismiss", due: null });
    expect(computeNextAction({ state: "PREPARING" })).toEqual({ label: "Complete application materials", due: null });
    expect(computeNextAction({ state: "READY_FOR_REVIEW" })).toEqual({ label: "Review and submit", due: null });
    expect(computeNextAction({ state: "INTERVIEW" })).toEqual({ label: "Prepare for interview", due: null });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @careerhq/core test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/core/src/state/attempt.ts`:
```ts
import type { AttemptStatus } from "@careerhq/contracts";
import type { TransitionCheck } from "./application.js";

const ATTEMPT_EDGES: Partial<Record<AttemptStatus, AttemptStatus[]>> = {
  DRAFT: ["READY"],
  READY: ["PENDING_CONFIRMATION", "DRAFT"],
  PENDING_CONFIRMATION: ["SUBMITTING", "BLOCKED", "READY"],
  SUBMITTING: ["SUBMITTED", "FAILED", "NEEDS_RECONCILE"],
  NEEDS_RECONCILE: ["SUBMITTED", "FAILED"],
};

export function canAttemptTransition(from: AttemptStatus, to: AttemptStatus): TransitionCheck {
  return (ATTEMPT_EDGES[from] ?? []).includes(to)
    ? { ok: true }
    : { ok: false, reason: `no attempt transition ${from} → ${to}` };
}
```

`packages/core/src/next-action.ts`:
```ts
import type { ApplicationState } from "@careerhq/contracts";

export interface NextAction { label: string; due: Date | null }

const LABELS: Partial<Record<ApplicationState, string>> = {
  DISCOVERED: "Shortlist or dismiss",
  SHORTLISTED: "Start preparing",
  PREPARING: "Complete application materials",
  READY_FOR_REVIEW: "Review and submit",
  SUBMITTED: "Follow up",
  ACKNOWLEDGED: "Follow up",
  INTERVIEW: "Prepare for interview",
  OFFER: "Evaluate offer",
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeNextAction(input: {
  state: ApplicationState;
  submittedAt?: Date | null;
  lastEventAt?: Date | null;
  followUpDays?: number;
}): NextAction | null {
  const label = LABELS[input.state];
  if (!label) return null;
  const days = input.followUpDays ?? 7;
  if (input.state === "SUBMITTED" || input.state === "ACKNOWLEDGED") {
    const base = input.state === "SUBMITTED" ? input.submittedAt : (input.lastEventAt ?? input.submittedAt);
    return { label, due: base ? new Date(base.getTime() + days * DAY_MS) : null };
  }
  return { label, due: null };
}
```

Append to `packages/core/src/index.ts`:
```ts
export * from "./state/attempt.js";
export * from "./next-action.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @careerhq/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core && git commit -m "feat(core): attempt lifecycle, next-action and follow-up computation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `packages/config` — validated environment

**Files:**
- Create: `packages/config/package.json`, `packages/config/tsconfig.json`, `packages/config/src/index.ts`
- Test: `packages/config/src/index.test.ts`

**Interfaces:**
- Produces:
```ts
export interface AppConfig {
  databaseUrl: string;
  submissionsLiveEmail: boolean;      // default false (spec §11 layer 1)
  submissionsLiveCompanySite: boolean; // default false
  sandboxForceSafe: boolean;           // default false
  followUpDays: number;                // default 7
  fileStorageDir: string;              // default "var/files"
}
export function loadConfig(env?: Record<string, string | undefined>): AppConfig; // throws on invalid
```
- Note: `loadConfig` takes `env` as a parameter (defaults to `process.env`) — no module-scope env capture (lesson from kelevoTMS review).

- [ ] **Step 1: Write the failing test**

`packages/config/src/index.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

const BASE = { DATABASE_URL: "postgres://u:p@localhost:5432/careerhq" };

describe("loadConfig", () => {
  it("requires DATABASE_URL", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
  it("defaults every submission gate to OFF (spec §11)", () => {
    const cfg = loadConfig(BASE);
    expect(cfg.submissionsLiveEmail).toBe(false);
    expect(cfg.submissionsLiveCompanySite).toBe(false);
  });
  it("parses gates and follow-up override", () => {
    const cfg = loadConfig({ ...BASE, SUBMISSIONS_LIVE_EMAIL: "true", FOLLOW_UP_DAYS: "10" });
    expect(cfg.submissionsLiveEmail).toBe(true);
    expect(cfg.followUpDays).toBe(10);
  });
  it("rejects non-numeric FOLLOW_UP_DAYS", () => {
    expect(() => loadConfig({ ...BASE, FOLLOW_UP_DAYS: "soon" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @careerhq/config test` → FAIL.

- [ ] **Step 3: Implement**

`packages/config/src/index.ts`:
```ts
import { z } from "zod";

const boolFromEnv = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const envSchema = z.object({
  DATABASE_URL: z.string().url({ message: "DATABASE_URL must be a valid postgres URL" }),
  SUBMISSIONS_LIVE_EMAIL: boolFromEnv,
  SUBMISSIONS_LIVE_COMPANY_SITE: boolFromEnv,
  SANDBOX_FORCE_SAFE: boolFromEnv,
  FOLLOW_UP_DAYS: z.coerce.number().int().positive().default(7),
  FILE_STORAGE_DIR: z.string().default("var/files"),
});

export interface AppConfig {
  databaseUrl: string;
  submissionsLiveEmail: boolean;
  submissionsLiveCompanySite: boolean;
  sandboxForceSafe: boolean;
  followUpDays: number;
  fileStorageDir: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  return {
    databaseUrl: parsed.DATABASE_URL,
    submissionsLiveEmail: parsed.SUBMISSIONS_LIVE_EMAIL,
    submissionsLiveCompanySite: parsed.SUBMISSIONS_LIVE_COMPANY_SITE,
    sandboxForceSafe: parsed.SANDBOX_FORCE_SAFE,
    followUpDays: parsed.FOLLOW_UP_DAYS,
    fileStorageDir: parsed.FILE_STORAGE_DIR,
  };
}
```

Package files mirror Task 2 (name `@careerhq/config`, dependency `zod`).

- [ ] **Step 4: Run test to verify it passes** — `pnpm --filter @careerhq/config test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/config && git commit -m "feat(config): zod-validated env with submission gates defaulting off

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `packages/db` — Drizzle schema and migrations

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/drizzle.config.ts`, `packages/db/src/schema/index.ts`, `packages/db/src/client.ts`, `packages/db/src/index.ts`
- Create (generated): `packages/db/migrations/0000_*.sql`

**Interfaces:**
- Consumes: `@careerhq/contracts` enum arrays (single source of truth for pg enums).
- Produces: Drizzle table objects `workspaces, companies, jobs, applications, applicationEvents, applicationAttempts, candidateFacts, cvVariants`; `createDb(url: string)` returning a `postgres`-driver Drizzle instance; inferred row types `Application`, `ApplicationEvent`, `CandidateFact`, `CvVariant`, `NewApplication`, etc. via `typeof table.$inferSelect / $inferInsert`.

- [ ] **Step 1: Package scaffold**

`packages/db/package.json` deps: `drizzle-orm ^0.44`, `postgres ^3.4`, `@careerhq/contracts workspace:*`; devDeps: `drizzle-kit ^0.31`, `vitest`, `tsx ^4`. Scripts add:
```json
{
  "db:generate": "drizzle-kit generate",
  "db:migrate": "drizzle-kit migrate",
  "seed": "tsx src/seed.ts"
}
```
`packages/db/drizzle.config.ts`:
```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://careerhq:careerhq@localhost:5432/careerhq" },
});
```

- [ ] **Step 2: Write the schema**

`packages/db/src/schema/index.ts`:
```ts
import {
  boolean, index, integer, jsonb, pgEnum, pgTable, real, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import {
  APPLICATION_STATES, ATTEMPT_STATUSES, CHANNELS, CV_FORMATS,
  FACT_CATEGORIES, SENSITIVITIES, TRANSITION_TRIGGERS, WORKSPACE_KINDS,
} from "@careerhq/contracts";

export const workspaceKind = pgEnum("workspace_kind", WORKSPACE_KINDS);
export const applicationState = pgEnum("application_state", APPLICATION_STATES);
export const attemptStatus = pgEnum("attempt_status", ATTEMPT_STATUSES);
export const transitionTrigger = pgEnum("transition_trigger", TRANSITION_TRIGGERS);
export const channel = pgEnum("channel", CHANNELS);
export const factCategory = pgEnum("fact_category", FACT_CATEGORIES);
export const sensitivity = pgEnum("sensitivity", SENSITIVITIES);
export const cvFormat = pgEnum("cv_format", CV_FORMATS);
export const attemptOrigin = pgEnum("attempt_origin", ["app", "manual"]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: workspaceKind("kind").notNull().default("personal"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  domain: text("domain"),
  atsHint: text("ats_hint"),
});

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
  source: text("source").notNull().default("manual"),
  externalId: text("external_id"),
  url: text("url"),
  title: text("title").notNull(),
  location: text("location"),
  remoteMode: text("remote_mode"),
  descriptionMd: text("description_md"),
  contentHash: text("content_hash"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  expiredAt: timestamp("expired_at", { withTimezone: true }),
  keywordScore: real("keyword_score"),
  keywordBreakdown: jsonb("keyword_breakdown"),
  status: text("status").notNull().default("inbox"),
}, (t) => [
  uniqueIndex("jobs_workspace_source_external").on(t.workspaceId, t.source, t.externalId),
]);

export const applications = pgTable("applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "restrict" }),
  state: applicationState("state").notNull().default("DISCOVERED"),
  channel: channel("channel"),
  cvVariantId: uuid("cv_variant_id"),
  notes: text("notes"),
  nextAction: text("next_action"),
  nextActionDue: timestamp("next_action_due", { withTimezone: true }),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("applications_workspace_state").on(t.workspaceId, t.state)]);

export const applicationEvents = pgTable("application_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
  fromState: applicationState("from_state"),
  toState: applicationState("to_state").notNull(),
  trigger: transitionTrigger("trigger").notNull(),
  actor: text("actor").notNull().default("owner"),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("application_events_application").on(t.applicationId, t.createdAt)]);

export const applicationAttempts = pgTable("application_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
  channel: channel("channel").notNull(),
  origin: attemptOrigin("origin").notNull().default("app"),
  status: attemptStatus("status").notNull().default("DRAFT"),
  targetFingerprint: text("target_fingerprint"),
  payloadFingerprint: text("payload_fingerprint"),
  pendingReceipt: jsonb("pending_receipt"),
  confirmedReceipt: jsonb("confirmed_receipt"),
  failureReason: text("failure_reason"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("attempts_one_submitted_per_application")
    .on(t.applicationId)
    .where(sql`${t.status} = 'SUBMITTED'`),
]);

export const candidateFacts = pgTable("candidate_facts", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  category: factCategory("category").notNull(),
  claim: text("claim").notNull(),
  detail: text("detail"),
  evidenceUrl: text("evidence_url"),
  sensitivity: sensitivity("sensitivity").notNull().default("normal"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  reviewBy: timestamp("review_by", { withTimezone: true }).notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cvVariants = pgTable("cv_variants", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  format: cvFormat("format").notNull(),
  filePath: text("file_path").notNull(),
  sha256: text("sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```
(Add `import { sql } from "drizzle-orm";` at top for the partial index.)

`packages/db/src/client.ts`:
```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Db = ReturnType<typeof createDb>;
export function createDb(url: string) {
  const sql = postgres(url, { max: 10 });
  return drizzle(sql, { schema, casing: "snake_case" });
}
```

`packages/db/src/index.ts` re-exports `createDb`, `type Db`, all schema tables, and inferred types:
```ts
export * from "./client.js";
export * from "./schema/index.js";
import type { applications, applicationEvents, candidateFacts, cvVariants, jobs, workspaces } from "./schema/index.js";
export type Application = typeof applications.$inferSelect;
export type NewApplication = typeof applications.$inferInsert;
export type ApplicationEvent = typeof applicationEvents.$inferSelect;
export type CandidateFact = typeof candidateFacts.$inferSelect;
export type CvVariant = typeof cvVariants.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
```

- [ ] **Step 3: Generate the migration and verify SQL**

Run: `pnpm --filter @careerhq/db db:generate`
Expected: one SQL file in `packages/db/migrations/` containing `CREATE TYPE "application_state"`, all 8 tables, and the partial unique index `WHERE "status" = 'SUBMITTED'`. Inspect the file to confirm the partial index — this constraint is the spec §11 duplicate-submission guard.

- [ ] **Step 4: Typecheck** — `pnpm --filter @careerhq/db typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/db && git commit -m "feat(db): drizzle schema for P1 tables with one-submitted-attempt constraint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Docker Compose stack + worker scaffold

**Files:**
- Create: `infra/docker-compose.yml`, `infra/Dockerfile.web`, `infra/Dockerfile.worker`, `.env.example`
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/src/main.ts`

**Interfaces:**
- Consumes: `loadConfig` from `@careerhq/config`.
- Produces: `docker compose -f infra/docker-compose.yml up -d postgres mailpit` for local dev; worker boots pg-boss and registers a `maintenance.heartbeat` scheduled job (every 5 min) proving queue wiring end-to-end. Postgres service: user/password/db all `careerhq`, port 5432; Mailpit: SMTP 1025, UI 8025.

- [ ] **Step 1: Compose file**

`infra/docker-compose.yml`:
```yaml
name: careerhq
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: careerhq
      POSTGRES_PASSWORD: careerhq
      POSTGRES_DB: careerhq
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U careerhq"]
      interval: 5s
      timeout: 3s
      retries: 10
  mailpit:
    image: axllent/mailpit:latest
    ports: ["1025:1025", "8025:8025"]
  web:
    build: { context: .., dockerfile: infra/Dockerfile.web }
    environment:
      DATABASE_URL: postgres://careerhq:careerhq@postgres:5432/careerhq
    ports: ["3000:3000"]
    volumes: [files:/app/var/files]
    depends_on:
      postgres: { condition: service_healthy }
  worker:
    build: { context: .., dockerfile: infra/Dockerfile.worker }
    environment:
      DATABASE_URL: postgres://careerhq:careerhq@postgres:5432/careerhq
    volumes: [files:/app/var/files]
    depends_on:
      postgres: { condition: service_healthy }
volumes:
  pgdata:
  files:
```

`.env.example`:
```
DATABASE_URL=postgres://careerhq:careerhq@localhost:5432/careerhq
SUBMISSIONS_LIVE_EMAIL=false
SUBMISSIONS_LIVE_COMPANY_SITE=false
FOLLOW_UP_DAYS=7
```

- [ ] **Step 2: Worker app**

`apps/worker/package.json`: name `@careerhq/worker`, deps `pg-boss ^10`, `@careerhq/config workspace:*`, `@careerhq/db workspace:*`; scripts `"dev": "tsx watch src/main.ts"`, `"build": "tsc -p tsconfig.json"`, `"start": "node dist/main.js"`, plus lint/typecheck.

`apps/worker/src/main.ts`:
```ts
import PgBoss from "pg-boss";
import { loadConfig } from "@careerhq/config";

const config = loadConfig();
const boss = new PgBoss(config.databaseUrl);

boss.on("error", (err) => console.error("[worker] pg-boss error", err));

await boss.start();
await boss.createQueue("maintenance.heartbeat");
await boss.schedule("maintenance.heartbeat", "*/5 * * * *");
await boss.work("maintenance.heartbeat", async () => {
  console.log("[worker] heartbeat", new Date().toISOString());
});
console.log("[worker] started; queues registered");
```

`infra/Dockerfile.worker` (multi-stage, pnpm):
```dockerfile
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
COPY apps/worker ./apps/worker
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @careerhq/worker... build
CMD ["node", "apps/worker/dist/main.js"]
```
`infra/Dockerfile.web` mirrors it for `apps/web` with `CMD ["pnpm", "--filter", "@careerhq/web", "start"]` (web app arrives Task 8; the Dockerfile may be committed now and first built then).

- [ ] **Step 3: Verify infra**

Run:
```bash
docker compose -f infra/docker-compose.yml up -d postgres mailpit
DATABASE_URL=postgres://careerhq:careerhq@localhost:5432/careerhq pnpm --filter @careerhq/db db:migrate
DATABASE_URL=postgres://careerhq:careerhq@localhost:5432/careerhq pnpm --filter @careerhq/worker dev &
```
Expected: migration applies (8 tables); worker logs `started; queues registered`. Stop the dev worker afterward. Verify tables: `docker compose -f infra/docker-compose.yml exec postgres psql -U careerhq -c '\dt'`.

- [ ] **Step 4: Commit**

```bash
git add infra apps/worker .env.example && git commit -m "feat(infra): compose stack (postgres, mailpit, web, worker) and pg-boss worker scaffold

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: `apps/web` — Next.js scaffold with workspace bootstrap

**Files:**
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.ts`, `apps/web/src/app/layout.tsx`, `apps/web/src/app/page.tsx`, `apps/web/src/app/globals.css`, `apps/web/src/lib/db.ts`, `apps/web/src/lib/workspace.ts`

**Interfaces:**
- Consumes: `createDb` from `@careerhq/db`, `loadConfig` from `@careerhq/config`.
- Produces: `getDb(): Db` (module-level singleton), `getActiveWorkspace(db): Promise<Workspace>` — finds the `personal` workspace or creates it ("My workspace") on first request. All later server actions use these two helpers.

- [ ] **Step 1: Scaffold Next.js app**

`apps/web/package.json`: name `@careerhq/web`; deps `next ^15.4`, `react ^19`, `react-dom ^19`, `@careerhq/{contracts,core,db,config} workspace:*`; scripts `dev: next dev`, `build: next build`, `start: next start`, `typecheck: tsc --noEmit`, `lint: eslint src`. `tsconfig.json` extends base but overrides `module: "esnext"`, `moduleResolution: "bundler"`, `jsx: "preserve"`, `noEmit: true`, plus Next plugin. `next.config.ts` default export `{}`.

`apps/web/src/lib/db.ts`:
```ts
import { createDb, type Db } from "@careerhq/db";
import { loadConfig } from "@careerhq/config";

let db: Db | undefined;
export function getDb(): Db {
  if (!db) db = createDb(loadConfig().databaseUrl);
  return db;
}
```

`apps/web/src/lib/workspace.ts`:
```ts
import { workspaces, type Db, type Workspace } from "@careerhq/db";
import { eq } from "drizzle-orm";

export async function getActiveWorkspace(db: Db): Promise<Workspace> {
  const existing = await db.select().from(workspaces).where(eq(workspaces.kind, "personal")).limit(1);
  if (existing[0]) return existing[0];
  const created = await db.insert(workspaces).values({ name: "My workspace", kind: "personal" }).returning();
  if (!created[0]) throw new Error("failed to bootstrap workspace");
  return created[0];
}
```

`apps/web/src/app/layout.tsx`: html shell + nav links to `/applications`, `/facts`, `/cvs`. `apps/web/src/app/page.tsx`: redirect to `/applications`.

- [ ] **Step 2: Verify**

Run: `DATABASE_URL=postgres://careerhq:careerhq@localhost:5432/careerhq pnpm --filter @careerhq/web dev` then `curl -sI http://localhost:3000/ | head -1`
Expected: HTTP 307/200; no runtime errors in the dev log. Stop the server.

- [ ] **Step 3: Commit**

```bash
git add apps/web && git commit -m "feat(web): next.js scaffold with db singleton and workspace bootstrap

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: `packages/db` — application repository (create, transition, list)

**Files:**
- Create: `packages/db/src/repos/applications.ts`
- Modify: `packages/db/src/index.ts` (re-export repo)
- Test: `packages/db/src/repos/applications.test.ts` (integration — runs only when `TEST_DATABASE_URL` is set)

**Interfaces:**
- Consumes: `canTransition`, `computeNextAction` from `@careerhq/core`.
- Produces:
```ts
export interface CreateApplicationInput {
  workspaceId: string; companyName: string; jobTitle: string;
  jobUrl?: string; notes?: string;
  asExternalSubmitted?: boolean; // spec §6.2 manual external path
  submittedAt?: Date;            // used with asExternalSubmitted
}
export async function createApplication(db: Db, input: CreateApplicationInput): Promise<Application>;
export type TransitionOutcome = { ok: true; application: Application } | { ok: false; reason: string };
export async function transitionApplication(db: Db, args: {
  applicationId: string; to: ApplicationState; trigger: TransitionTrigger;
  ctx?: TransitionContext; actor?: string; followUpDays?: number;
}): Promise<TransitionOutcome>;
export async function listApplications(db: Db, workspaceId: string): Promise<Application[]>;
export async function getApplicationDetail(db: Db, applicationId: string): Promise<{
  application: Application; job: Job; events: ApplicationEvent[];
} | null>;
```
- `createApplication` creates company + manual-source job + application (state `DISCOVERED`, creation event trigger `user`). With `asExternalSubmitted: true` it instead creates the application at `SUBMITTED` with an `application_attempts` row `{channel:'external', origin:'manual', status:'SUBMITTED'}` and a creation event whose payload notes `origin: manual` (spec §6.2).
- `transitionApplication` runs in ONE transaction: `SELECT ... FOR UPDATE` the application, call `canTransition`, insert event, update `state`, `next_action`, `next_action_due`, `submitted_at` (when entering SUBMITTED), `updated_at`.

- [ ] **Step 1: Write the failing integration test**

`packages/db/src/repos/applications.test.ts`:
```ts
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, workspaces } from "../index.js";
import { createApplication, transitionApplication, getApplicationDetail } from "./applications.js";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

let db: Db;
let workspaceId: string;

beforeAll(async () => {
  db = createDb(url!);
  const [ws] = await db.insert(workspaces).values({ name: `t-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;
});

d("applications repo", () => {
  it("creates an application at DISCOVERED with a creation event", async () => {
    const app = await createApplication(db, { workspaceId, companyName: "Acme", jobTitle: "Engineer" });
    expect(app.state).toBe("DISCOVERED");
    const detail = await getApplicationDetail(db, app.id);
    expect(detail?.events).toHaveLength(1);
    expect(detail?.events[0]?.toState).toBe("DISCOVERED");
  });

  it("performs a guarded transition and appends an event", async () => {
    const app = await createApplication(db, { workspaceId, companyName: "Beta", jobTitle: "Dev" });
    const r = await transitionApplication(db, { applicationId: app.id, to: "SHORTLISTED", trigger: "user" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.application.state).toBe("SHORTLISTED");
      expect(r.application.nextAction).toBe("Start preparing");
    }
    const detail = await getApplicationDetail(db, app.id);
    expect(detail?.events).toHaveLength(2);
  });

  it("refuses an illegal transition and appends nothing", async () => {
    const app = await createApplication(db, { workspaceId, companyName: "Gamma", jobTitle: "Dev" });
    const r = await transitionApplication(db, { applicationId: app.id, to: "SUBMITTED", trigger: "user" });
    expect(r.ok).toBe(false);
    const detail = await getApplicationDetail(db, app.id);
    expect(detail?.application.state).toBe("DISCOVERED");
    expect(detail?.events).toHaveLength(1);
  });

  it("logs a manual external application at SUBMITTED with an external attempt", async () => {
    const submittedAt = new Date("2026-08-01T00:00:00Z");
    const app = await createApplication(db, {
      workspaceId, companyName: "Delta", jobTitle: "Dev", asExternalSubmitted: true, submittedAt,
    });
    expect(app.state).toBe("SUBMITTED");
    expect(app.nextAction).toBe("Follow up");
    expect(app.nextActionDue?.toISOString()).toBe("2026-08-08T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run to verify fail/skip behavior**

Run: `pnpm --filter @careerhq/db test` (skips without `TEST_DATABASE_URL`), then
`TEST_DATABASE_URL=postgres://careerhq:careerhq@localhost:5432/careerhq pnpm --filter @careerhq/db test`
Expected: FAIL — `./applications.js` not found.

- [ ] **Step 3: Implement**

`packages/db/src/repos/applications.ts`:
```ts
import { and, asc, eq, sql } from "drizzle-orm";
import type { ApplicationState, TransitionTrigger } from "@careerhq/contracts";
import { canTransition, computeNextAction, type TransitionContext } from "@careerhq/core";
import type { Db } from "../client.js";
import {
  applicationAttempts, applicationEvents, applications, companies, jobs,
} from "../schema/index.js";
import type { Application, ApplicationEvent, Job } from "../index.js";

export interface CreateApplicationInput {
  workspaceId: string; companyName: string; jobTitle: string;
  jobUrl?: string; notes?: string;
  asExternalSubmitted?: boolean; submittedAt?: Date;
}

export async function createApplication(db: Db, input: CreateApplicationInput): Promise<Application> {
  return db.transaction(async (tx) => {
    const [company] = await tx.insert(companies)
      .values({ workspaceId: input.workspaceId, name: input.companyName }).returning();
    const [job] = await tx.insert(jobs).values({
      workspaceId: input.workspaceId, companyId: company!.id,
      title: input.jobTitle, url: input.jobUrl, source: "manual", status: "promoted",
    }).returning();

    const external = input.asExternalSubmitted === true;
    const state: ApplicationState = external ? "SUBMITTED" : "DISCOVERED";
    const submittedAt = external ? (input.submittedAt ?? new Date()) : null;
    const next = computeNextAction({ state, submittedAt });

    const [app] = await tx.insert(applications).values({
      workspaceId: input.workspaceId, jobId: job!.id, state,
      channel: external ? "external" : null, notes: input.notes,
      nextAction: next?.label ?? null, nextActionDue: next?.due ?? null, submittedAt,
    }).returning();

    await tx.insert(applicationEvents).values({
      applicationId: app!.id, fromState: null, toState: state, trigger: "user",
      payload: external ? { origin: "manual", note: "logged external application" } : null,
    });
    if (external) {
      await tx.insert(applicationAttempts).values({
        applicationId: app!.id, channel: "external", origin: "manual",
        status: "SUBMITTED", submittedAt,
      });
    }
    return app!;
  });
}

export type TransitionOutcome = { ok: true; application: Application } | { ok: false; reason: string };

export async function transitionApplication(db: Db, args: {
  applicationId: string; to: ApplicationState; trigger: TransitionTrigger;
  ctx?: TransitionContext; actor?: string; followUpDays?: number;
}): Promise<TransitionOutcome> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(applications)
      .where(eq(applications.id, args.applicationId)).for("update");
    if (!current) return { ok: false, reason: "application not found" };

    const check = canTransition(current.state, args.to, args.trigger, args.ctx ?? {});
    if (!check.ok) return check;

    const submittedAt = args.to === "SUBMITTED" ? new Date() : current.submittedAt;
    const next = computeNextAction({
      state: args.to, submittedAt, lastEventAt: new Date(), followUpDays: args.followUpDays,
    });
    await tx.insert(applicationEvents).values({
      applicationId: current.id, fromState: current.state, toState: args.to,
      trigger: args.trigger, actor: args.actor ?? "owner",
    });
    const [updated] = await tx.update(applications).set({
      state: args.to, submittedAt,
      nextAction: next?.label ?? null, nextActionDue: next?.due ?? null,
      updatedAt: sql`now()`,
    }).where(eq(applications.id, current.id)).returning();
    return { ok: true, application: updated! };
  });
}

export async function listApplications(db: Db, workspaceId: string): Promise<Application[]> {
  return db.select().from(applications)
    .where(eq(applications.workspaceId, workspaceId))
    .orderBy(asc(applications.createdAt));
}

export async function getApplicationDetail(db: Db, applicationId: string) {
  const [app] = await db.select().from(applications).where(eq(applications.id, applicationId));
  if (!app) return null;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, app.jobId));
  const events = await db.select().from(applicationEvents)
    .where(eq(applicationEvents.applicationId, applicationId))
    .orderBy(asc(applicationEvents.createdAt));
  return { application: app, job: job as Job, events: events as ApplicationEvent[] };
}
```
Re-export from `packages/db/src/index.ts`: `export * from "./repos/applications.js";`

- [ ] **Step 4: Run integration tests to verify they pass**

Run: `TEST_DATABASE_URL=postgres://careerhq:careerhq@localhost:5432/careerhq pnpm --filter @careerhq/db test`
Expected: PASS (4 tests). Also `pnpm --filter @careerhq/db test` without the env → all skipped, exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/db && git commit -m "feat(db): application repository with transactional guarded transitions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: `packages/db` — fact bank and CV variant repositories

**Files:**
- Create: `packages/db/src/repos/facts.ts`, `packages/db/src/repos/cv-variants.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/repos/facts.test.ts`

**Interfaces:**
- Produces:
```ts
// facts.ts
export interface FactInput {
  workspaceId: string; category: FactCategory; claim: string;
  detail?: string; evidenceUrl?: string; sensitivity?: Sensitivity;
  reviewBy: Date;
}
export async function createFact(db: Db, input: FactInput): Promise<CandidateFact>;
export async function updateFact(db: Db, id: string, patch: Partial<Omit<FactInput, "workspaceId">>): Promise<CandidateFact | null>;
export async function archiveFact(db: Db, id: string): Promise<void>;
export async function reverifyFact(db: Db, id: string, reviewBy: Date): Promise<CandidateFact | null>; // sets verified_at = now
export async function listFacts(db: Db, workspaceId: string, opts?: { includeArchived?: boolean }): Promise<CandidateFact[]>;
export function isFactStale(fact: Pick<CandidateFact, "reviewBy">, now?: Date): boolean;
// cv-variants.ts
export async function createCvVariant(db: Db, input: { workspaceId: string; label: string; format: CvFormat; filePath: string; sha256: string }): Promise<CvVariant>;
export async function listCvVariants(db: Db, workspaceId: string): Promise<CvVariant[]>;
```

- [ ] **Step 1: Write the failing test** (`facts.test.ts`, same `describe.skipIf(!url)` pattern as Task 9):

```ts
it("creates, lists, archives", async () => {
  const fact = await createFact(db, {
    workspaceId, category: "skill", claim: "TypeScript (5 years)",
    reviewBy: new Date("2027-01-01"),
  });
  expect(fact.sensitivity).toBe("normal");
  await archiveFact(db, fact.id);
  const visible = await listFacts(db, workspaceId);
  expect(visible.find((f) => f.id === fact.id)).toBeUndefined();
  const all = await listFacts(db, workspaceId, { includeArchived: true });
  expect(all.find((f) => f.id === fact.id)).toBeDefined();
});
it("flags stale facts past review_by (spec §7.1)", () => {
  expect(isFactStale({ reviewBy: new Date("2026-01-01") }, new Date("2026-08-01"))).toBe(true);
  expect(isFactStale({ reviewBy: new Date("2027-01-01") }, new Date("2026-08-01"))).toBe(false);
});
it("re-verifying resets verified_at and review_by", async () => {
  const fact = await createFact(db, {
    workspaceId, category: "experience", claim: "Built a TMS", reviewBy: new Date("2026-01-01"),
  });
  const updated = await reverifyFact(db, fact.id, new Date("2027-06-01"));
  expect(updated?.reviewBy.toISOString()).toBe("2027-06-01T00:00:00.000Z");
});
```

- [ ] **Step 2: Run to verify it fails** — module not found.

- [ ] **Step 3: Implement** — straightforward Drizzle CRUD per the interface block; `isFactStale` is `fact.reviewBy.getTime() < (now ?? new Date()).getTime()`; `listFacts` filters `isNull(candidateFacts.archivedAt)` unless `includeArchived`, ordered by category then createdAt. `cv-variants.ts` is two functions of plain insert/select.

- [ ] **Step 4: Run tests to verify they pass** — `TEST_DATABASE_URL=... pnpm --filter @careerhq/db test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db && git commit -m "feat(db): fact bank and cv variant repositories with stale flagging

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Tracker server actions

**Files:**
- Create: `apps/web/src/app/(dashboard)/applications/actions.ts`

**Interfaces:**
- Consumes: repos from `@careerhq/db`, `getDb`, `getActiveWorkspace`.
- Produces server actions used by Tasks 12–13 UI:
```ts
export async function createApplicationAction(formData: FormData): Promise<void>;      // fields: companyName, jobTitle, jobUrl?, notes?, external? ("on"), submittedAt?
export async function transitionApplicationAction(args: { applicationId: string; to: ApplicationState }): Promise<{ ok: boolean; reason?: string }>;
```
- Both validate input with Zod (`z.string().min(1)` etc.), call the repos with trigger `user`, then `revalidatePath("/applications")`. `transitionApplicationAction` passes `ctx: { hasMaterials: true }` when `to === "READY_FOR_REVIEW"` — P1 has no materials model yet; the UI transition IS the user's assertion that materials are ready (documented inline; the real check arrives in P3).

- [ ] **Step 1: Implement**

`apps/web/src/app/(dashboard)/applications/actions.ts`:
```ts
"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { applicationStateSchema } from "@careerhq/contracts";
import { createApplication, transitionApplication } from "@careerhq/db";
import { getDb } from "../../../lib/db.js";
import { getActiveWorkspace } from "../../../lib/workspace.js";

const createSchema = z.object({
  companyName: z.string().trim().min(1),
  jobTitle: z.string().trim().min(1),
  jobUrl: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  notes: z.string().optional(),
  external: z.coerce.boolean().default(false),
  submittedAt: z.coerce.date().optional(),
});

export async function createApplicationAction(formData: FormData): Promise<void> {
  const input = createSchema.parse(Object.fromEntries(formData));
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  await createApplication(db, {
    workspaceId: ws.id, companyName: input.companyName, jobTitle: input.jobTitle,
    jobUrl: input.jobUrl, notes: input.notes,
    asExternalSubmitted: input.external, submittedAt: input.submittedAt,
  });
  revalidatePath("/applications");
}

const transitionSchema = z.object({ applicationId: z.string().uuid(), to: applicationStateSchema });

export async function transitionApplicationAction(raw: { applicationId: string; to: string }) {
  const args = transitionSchema.parse(raw);
  const db = getDb();
  const result = await transitionApplication(db, {
    applicationId: args.applicationId, to: args.to, trigger: "user",
    // P1: the user's click is the materials assertion; replaced by a real check in P3.
    ctx: args.to === "READY_FOR_REVIEW" ? { hasMaterials: true } : {},
  });
  revalidatePath("/applications");
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}
```

- [ ] **Step 2: Verify** — `pnpm --filter @careerhq/web typecheck` → clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web && git commit -m "feat(web): tracker server actions (create, guarded transition)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Kanban board UI

**Files:**
- Create: `apps/web/src/app/(dashboard)/applications/page.tsx`, `apps/web/src/app/(dashboard)/applications/board.tsx` (client), `apps/web/src/app/(dashboard)/applications/new-application-form.tsx`

**Interfaces:**
- Consumes: `listApplications`, `getApplicationDetail` (Task 9), actions (Task 11), `legalTargets` from `@careerhq/core`.
- Produces: `/applications` — a column per non-terminal state (terminal states collapse into one "Closed" column), cards showing company · title · next action; each card offers buttons for every `legalTargets(state, "user")` target and a link to `/applications/[id]`. A "Log application" form (company, title, URL, notes, "already applied elsewhere" checkbox + date) drives `createApplicationAction`.

- [ ] **Step 1: Implement**

`page.tsx` (server component):
```tsx
import { listApplications, jobs as jobsTable, companies as companiesTable } from "@careerhq/db";
import { inArray, eq } from "drizzle-orm";
import { APPLICATION_STATES } from "@careerhq/contracts";
import { getDb } from "../../../lib/db.js";
import { getActiveWorkspace } from "../../../lib/workspace.js";
import { Board } from "./board.js";
import { NewApplicationForm } from "./new-application-form.js";

export default async function ApplicationsPage() {
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  const apps = await listApplications(db, ws.id);
  const jobRows = apps.length
    ? await db.select().from(jobsTable).where(inArray(jobsTable.id, apps.map((a) => a.jobId)))
    : [];
  const companyRows = jobRows.length
    ? await db.select().from(companiesTable)
        .where(inArray(companiesTable.id, jobRows.map((j) => j.companyId!).filter(Boolean)))
    : [];
  const cards = apps.map((a) => {
    const job = jobRows.find((j) => j.id === a.jobId);
    const company = companyRows.find((c) => c.id === job?.companyId);
    return {
      id: a.id, state: a.state, title: job?.title ?? "?", company: company?.name ?? "?",
      nextAction: a.nextAction, nextActionDue: a.nextActionDue?.toISOString() ?? null,
    };
  });
  return (
    <main>
      <h1>Applications</h1>
      <NewApplicationForm />
      <Board cards={cards} />
    </main>
  );
}
```

`board.tsx` (client component): groups `cards` by state; columns are the 8 active states in `APPLICATION_STATES` order plus one "Closed" column for `REJECTED/WITHDRAWN/EXPIRED`; each card renders `legalTargets(card.state, "user")` as buttons calling `transitionApplicationAction({ applicationId, to })` via `useTransition`, showing `reason` inline when `ok === false` — the guard's refusal message must be user-visible, not swallowed.

`new-application-form.tsx`: plain `<form action={createApplicationAction}>` with the five fields; the "already applied elsewhere" checkbox is named `external`, revealing a `submittedAt` date input.

- [ ] **Step 2: Verify manually**

Run: dev server; create "Acme / Senior TS Engineer"; click SHORTLISTED; confirm the card moves and no SUBMITTED button exists anywhere (guard: user can never submit directly). Create one with "already applied elsewhere" → lands directly in SUBMITTED with "Follow up" due in 7 days.

- [ ] **Step 3: Commit**

```bash
git add apps/web && git commit -m "feat(web): kanban tracker board with guarded transition buttons

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Application detail page + overview panel

**Files:**
- Create: `apps/web/src/app/(dashboard)/applications/[id]/page.tsx`, `apps/web/src/app/(dashboard)/overview/page.tsx`
- Modify: `apps/web/src/app/page.tsx` (redirect to `/overview`), `apps/web/src/app/layout.tsx` (nav link)

**Interfaces:**
- Consumes: `getApplicationDetail`, `listApplications`, `transitionApplicationAction`.
- Produces: `/applications/[id]` — job info, notes, current state, next action, and the full event timeline (`{createdAt} — {fromState ?? "·"} → {toState} ({trigger})`); transition buttons as on the board. `/overview` — "Due follow-ups" list: applications with `nextActionDue <= now + 3 days`, ordered by due date, each linking to its detail page; plus state counts.

- [ ] **Step 1: Implement**

`[id]/page.tsx` fetches `getApplicationDetail(db, params.id)` (404 via `notFound()` when null) and renders the timeline as an ordered list; buttons reuse the same client transition component as the board (extract `TransitionButtons` from `board.tsx` into `transition-buttons.tsx` and import in both).

`overview/page.tsx`:
```tsx
const apps = await listApplications(db, ws.id);
const soon = Date.now() + 3 * 24 * 60 * 60 * 1000;
const due = apps
  .filter((a) => a.nextActionDue && a.nextActionDue.getTime() <= soon)
  .sort((a, b) => a.nextActionDue!.getTime() - b.nextActionDue!.getTime());
const counts = new Map<string, number>();
for (const a of apps) counts.set(a.state, (counts.get(a.state) ?? 0) + 1);
```
Rendered as a due list (company · title · action · due date, overdue highlighted) and a state-count row.

- [ ] **Step 2: Verify manually** — detail page shows the full event history for an application that went DISCOVERED→SHORTLISTED→PREPARING; overview lists the externally-logged SUBMITTED application under due follow-ups once its due date is within 3 days (create one with `submittedAt` 5 days ago to see it).

- [ ] **Step 3: Commit**

```bash
git add apps/web && git commit -m "feat(web): application detail with event timeline and overview follow-ups panel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: Fact Bank UI

**Files:**
- Create: `apps/web/src/app/(dashboard)/facts/page.tsx`, `apps/web/src/app/(dashboard)/facts/actions.ts`, `apps/web/src/app/(dashboard)/facts/fact-form.tsx`

**Interfaces:**
- Consumes: `createFact`, `updateFact`, `archiveFact`, `reverifyFact`, `listFacts`, `isFactStale` (Task 10).
- Produces: `/facts` — facts grouped by category; each row shows claim, detail, sensitivity badge, verified/review dates, a **STALE** badge when `isFactStale`, and actions Re-verify (sets `verified_at=now`, prompts a new `review_by` date) and Archive. Add-fact form: category select (9 categories), claim, detail, evidence URL, sensitivity select, review-by date (default: +12 months, pre-filled by the form). Server actions in `facts/actions.ts` follow the exact Task 11 pattern (zod parse → repo call → `revalidatePath("/facts")`).

- [ ] **Step 1: Implement** the three files per the interface block. Validation schema for creation:
```ts
const factSchema = z.object({
  category: factCategorySchema,
  claim: z.string().trim().min(1),
  detail: z.string().optional(),
  evidenceUrl: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  sensitivity: sensitivitySchema.default("normal"),
  reviewBy: z.coerce.date(),
});
```

- [ ] **Step 2: Verify manually** — add a `skill` fact with review-by in the past → STALE badge shows; re-verify with a future date → badge clears; archive removes it from the default list.

- [ ] **Step 3: Commit**

```bash
git add apps/web && git commit -m "feat(web): candidate fact bank CRUD with stale flagging

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 15: CV variant upload

**Files:**
- Create: `apps/web/src/app/(dashboard)/cvs/page.tsx`, `apps/web/src/app/(dashboard)/cvs/actions.ts`

**Interfaces:**
- Consumes: `createCvVariant`, `listCvVariants` (Task 10); `loadConfig().fileStorageDir`.
- Produces: `/cvs` — upload form (label, format `designed|ats`, PDF file) and a table (label, format, size-agnostic sha256 prefix, uploaded date). Upload action: accepts only `application/pdf` ≤ 5 MB, writes the file to `${fileStorageDir}/cvs/${randomUUID()}.pdf` (`fs.mkdir recursive` first), computes sha256 via `crypto.createHash`, stores metadata via `createCvVariant`. The file bytes never enter Postgres (spec §2 files-on-volume rule).

- [ ] **Step 1: Implement**

Core of `cvs/actions.ts`:
```ts
"use server";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { cvFormatSchema } from "@careerhq/contracts";
import { createCvVariant } from "@careerhq/db";
import { loadConfig } from "@careerhq/config";
import { getDb } from "../../../lib/db.js";
import { getActiveWorkspace } from "../../../lib/workspace.js";

const metaSchema = z.object({ label: z.string().trim().min(1), format: cvFormatSchema });
const MAX_BYTES = 5 * 1024 * 1024;

export async function uploadCvAction(formData: FormData): Promise<void> {
  const meta = metaSchema.parse({ label: formData.get("label"), format: formData.get("format") });
  const file = formData.get("file");
  if (!(file instanceof File) || file.type !== "application/pdf") throw new Error("a PDF file is required");
  if (file.size > MAX_BYTES) throw new Error("PDF exceeds 5 MB limit");
  const bytes = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const dir = path.join(loadConfig().fileStorageDir, "cvs");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${randomUUID()}.pdf`);
  await writeFile(filePath, bytes);
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  await createCvVariant(db, { workspaceId: ws.id, ...meta, filePath, sha256 });
  revalidatePath("/cvs");
}
```

- [ ] **Step 2: Verify manually** — upload any small PDF twice as `designed` and `ats`; both listed; file exists under `var/files/cvs/`; a `.txt` upload is rejected.

- [ ] **Step 3: Commit**

```bash
git add apps/web && git commit -m "feat(web): cv variant upload to file volume with sha256 metadata

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 16: Seed — the "Alex Demo" persona

**Files:**
- Create: `packages/db/src/seed.ts`
- Modify: root `package.json` (script `"seed": "pnpm --filter @careerhq/db seed"`)

**Interfaces:**
- Consumes: every repo from Tasks 9–10.
- Produces: idempotent seed (deletes and recreates a workspace named `Alex Demo`) containing: 15 candidate facts spanning all 9 categories (at least one `sensitivity: "sensitive"` — e.g. authorization "US work authorization: citizen"; compensation "Target base: $140k"); 2 CV variants pointing at two tiny generated placeholder PDFs written to the volume (a minimal valid PDF literal string is fine); 10 applications across fictional companies (Lumon Industries, Initech, Hooli, Pied Piper, Globex, Wonka Data, Stark Cloud, Acme Analytics, Umbrella Health, Vandelay Systems) distributed over states: 1 DISCOVERED, 1 SHORTLISTED, 2 PREPARING, 1 READY_FOR_REVIEW, 2 SUBMITTED (one external/manual, one with submittedAt 8 days ago so its follow-up is overdue), 1 INTERVIEW, 1 OFFER, 1 REJECTED — each reached by replaying real `transitionApplication` calls so event histories are genuine, never by writing `state` directly.

- [ ] **Step 1: Implement** `seed.ts`: connect via `process.env.DATABASE_URL`, delete workspace `Alex Demo` if present (cascades), create it as `kind: "personal"`, then build the data via the repos. To reach INTERVIEW/OFFER, path through SUBMITTED using `createApplication(..., { asExternalSubmitted: true })` then `transitionApplication` with trigger `user`. Log a one-line summary per application. Exit non-zero on any failed transition (`if (!r.ok) throw new Error(r.reason)`).

- [ ] **Step 2: Run and verify**

Run: `DATABASE_URL=postgres://careerhq:careerhq@localhost:5432/careerhq pnpm seed` twice (idempotency), then open `/applications`.
Expected: board populated across columns; overview shows the overdue follow-up; `/facts` shows 15 facts incl. one stale if you seed one with past `review_by` (seed exactly one such fact deliberately).

- [ ] **Step 3: Commit**

```bash
git add packages/db package.json && git commit -m "feat(db): idempotent Alex Demo seed via real repo transitions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 17: dependency-cruiser boundaries + GitHub Actions CI

**Files:**
- Create: `.dependency-cruiser.cjs`, `.github/workflows/ci.yml`
- Modify: root `package.json` (script `"depcruise": "depcruise apps packages --config .dependency-cruiser.cjs"`, devDependency `dependency-cruiser ^16`)

**Interfaces:**
- Produces: CI that fails on: lint, typecheck, boundary violation, unit/integration test failure.

- [ ] **Step 1: Boundary rules**

`.dependency-cruiser.cjs`:
```js
module.exports = {
  forbidden: [
    {
      name: "core-purity",
      comment: "core may import only contracts (architecture §2)",
      severity: "error",
      from: { path: "^packages/core" },
      to: { path: "^(packages/(db|ai|ingest|email|autoapply|config)|apps)" },
    },
    {
      name: "contracts-zero-deps",
      severity: "error",
      from: { path: "^packages/contracts" },
      to: { path: "^(packages/(?!contracts)|apps)" },
    },
    {
      name: "packages-not-into-apps",
      severity: "error",
      from: { path: "^packages" },
      to: { path: "^apps" },
    },
  ],
  options: { doNotFollow: { path: "node_modules" }, tsPreCompilationDeps: true },
};
```

- [ ] **Step 2: Verify locally** — `pnpm depcruise` → no errors. Prove it works: temporarily add `import "@careerhq/db"` to `packages/core/src/index.ts` → depcruise errors; revert.

- [ ] **Step 3: CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  checks:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17-alpine
        env: { POSTGRES_USER: careerhq, POSTGRES_PASSWORD: careerhq, POSTGRES_DB: careerhq }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U careerhq" --health-interval 5s
          --health-timeout 3s --health-retries 10
    env:
      DATABASE_URL: postgres://careerhq:careerhq@localhost:5432/careerhq
      TEST_DATABASE_URL: postgres://careerhq:careerhq@localhost:5432/careerhq
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm depcruise
      - run: pnpm --filter @careerhq/db db:migrate
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 4: Verify** — push a branch / run `act` if available, or at minimum run every CI step locally in order and confirm each passes.

- [ ] **Step 5: Commit**

```bash
git add .dependency-cruiser.cjs .github package.json && git commit -m "chore(ci): dependency-cruiser boundaries and github actions pipeline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 18: README v1 + ADR-0001 + ADR-0002

**Files:**
- Create: `README.md`, `docs/adr/0001-postgres-and-pg-boss.md`, `docs/adr/0002-gated-mutation-protocol.md`

**Interfaces:**
- Consumes: everything shipped in Tasks 1–17; `docs/architecture.md` diagrams.

- [ ] **Step 1: README v1** — sections: what CareerHQ is (2 paragraphs, portfolio framing), current status (P1 complete, link `docs/roadmap.md`), quickstart:
```bash
git clone … && cd careerHQ-app
docker compose -f infra/docker-compose.yml up -d postgres mailpit
cp .env.example .env
pnpm install && pnpm --filter @careerhq/db db:migrate && pnpm seed
pnpm --filter @careerhq/web dev   # http://localhost:3000
```
architecture summary (embed the mermaid system diagram from `docs/architecture.md` §1), screenshots placeholder section, links to spec/architecture/roadmap/ADRs, license note (MIT).

- [ ] **Step 2: ADRs** — standard format (Context / Decision / Consequences), each ~40 lines:
  - `0001-postgres-and-pg-boss.md`: concurrent web+worker writers rule out SQLite write-locking; `jsonb` receipts/breakdowns; the partial unique index as the duplicate-submission backstop; pg-boss rides the same Postgres so `docker compose up` stays at 4 services — accepted trade-off: heavier than SQLite for pure-local use.
  - `0002-gated-mutation-protocol.md`: records the spec §11 design decided in P1 and enforced from P4 — three independent server-side layers (env gates off-by-default, sandbox adapter block, preview-fingerprint + retype-target confirmation), pending-receipt-before-mutation / confirmed-receipt-after-evidence, `NEEDS_RECONCILE` never auto-retried, DB partial-unique constraint; consequence noted: P1 already ships the attempt state machine and constraint so later phases cannot ship submission code without the rails.

- [ ] **Step 3: Full-suite verification**

Run: `pnpm lint && pnpm typecheck && pnpm depcruise && TEST_DATABASE_URL=postgres://careerhq:careerhq@localhost:5432/careerhq pnpm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/adr && git commit -m "docs: README v1, ADR-0001 (postgres+pg-boss), ADR-0002 (gated mutations)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Final Verification (Definition of Done for P1)

1. `docker compose -f infra/docker-compose.yml up -d postgres mailpit && pnpm install && pnpm --filter @careerhq/db db:migrate && pnpm seed && pnpm --filter @careerhq/web dev` from a clean clone gives a populated tracker at `http://localhost:3000`.
2. Board: guarded transitions work; illegal moves show the guard's reason; no path in the UI sets SUBMITTED except "log external application".
3. Detail page shows genuine event history; overview surfaces the seeded overdue follow-up.
4. `/facts` shows 15 facts with one STALE; re-verify clears it. `/cvs` uploads and lists PDFs with hashes.
5. `pnpm lint && pnpm typecheck && pnpm depcruise && pnpm test` all pass locally and in GitHub Actions.
6. `git log` shows one commit per task, conventional messages.
