# CareerHQ UI Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 1,573 lines of ad-hoc CSS with a token-driven Tailwind design system, and redesign the shell and four key screens, so the app's first impression matches the quality of its architecture.

**Architecture:** CSS custom properties in one `tokens.css` are the single source of colour, type and spacing; `tailwind.config.ts` maps semantic utility names onto them so no component ever writes a raw hex and a dark palette stays a later addition rather than a refactor. A shared component layer carries seven "systematic" pages; four "bespoke" pages get their own compositions.

**Tech Stack:** Next.js 15.4 (App Router, React 19), Tailwind CSS 4, PostCSS, `next/font` (self-hosted Inter), Vitest 3, Playwright 1.62.1.

## Global Constraints

- Spec: [`docs/superpowers/specs/2026-08-05-ui-design-system-design.md`](../specs/2026-08-05-ui-design-system-design.md). Where plan and spec disagree, the spec wins.
- **This is a presentation-layer change.** No task may alter a server action, a gate, a repository call or any data flow. If a visual fix appears to need one, stop and report it.
- **No raw hex in any component.** If a needed colour is not a token, the token set is wrong — extend `tokens.css`, do not inline.
- `--irreversible` (`#c2503c`) is reserved for controls that touch the outside world: "Confirm and submit", "Send", "Delete". Nowhere else.
- Inter loads via `next/font` (self-hosted at build). No runtime request to Google Fonts — the demo banner claims "nothing leaves this server".
- Every token pair must pass WCAG AA for its use. Check contrast; do not assume.
- Baseline gate: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm depcruise` — **1,158 tests passing** at `master`.
- **A green suite does not prove a UI change works.** The tests assert behaviour and DB state, not markup; they can stay green through a completely broken redesign. Every task that changes a screen must be verified in a real `next start` with a real browser.
- Test env: `TEST_DATABASE_URL=postgres://careerhq:careerhq@localhost:5433/careerhq`, demo-ats on `http://localhost:3001`.
- `apps/demo-ats` is **out of scope**. It is a fictional employer's careers site and must keep looking like a different company's product.
- Conventional commits, matching `git log --oneline -8`.

**Where this splits, if it has to.** After Task 5 the app is coherent and shippable: tokens, components, shell and the seven systematic pages all done. Tasks 6–8 (the four bespoke screens) are an independent second pass. A run that stalls after Task 5 has still fixed the first impression, which is the point of the work.

---

### Task 1: Stable test hooks for the screenshot script

`scripts/capture-demo-media.ts` is the sole external consumer of CareerHQ's CSS classes (~30 of them). It is not covered by the test suite, and it fails in the worst way — producing plausible images of the wrong elements rather than erroring. Decouple it before anything moves.

**Files:**
- Modify: `scripts/capture-demo-media.ts`
- Modify (add `data-testid` only): `apps/web/src/app/(dashboard)/applications/board.tsx`, `.../applications/transition-buttons.tsx`, `.../jobs/job-row.tsx`, `.../applications/[id]/materials.tsx`, `.../applications/[id]/site-panel.tsx`, `.../applications/[id]/qa.tsx`, `.../inbox/suggestions.tsx`, `.../overview/page.tsx`, `.../answers/page.tsx`, `apps/web/src/app/layout.tsx`

**Interfaces:**
- Produces: a `data-testid` on every element the capture script selects. Naming: kebab-case, mirroring the current class (`.board-card` → `data-testid="board-card"`). Later tasks may rename or delete any CSS class **except** where a `data-testid` now carries the selection.

- [ ] **Step 1: Enumerate every selector the script uses**

```bash
grep -ohE "['\"]\.[a-z][a-z0-9_ .-]*['\"]" scripts/capture-demo-media.ts | tr -d "\"'" | sort -u
```

Expected: ~30 entries such as `.board-card`, `.job-row-breakdown`, `.materials-needs-facts`, `.site-field-consent`, `.overview-due-list li`. Ignore `.mp4` / `.webm` — those are file extensions, not selectors.

- [ ] **Step 2: Add `data-testid` beside each corresponding class**

Add the attribute; **do not remove the class yet**. Example in `board.tsx`:

```tsx
<article className="board-card" data-testid="board-card">
```

- [ ] **Step 3: Switch the script to the new hooks**

```ts
// before
const card = page.locator(".board-card").first();
// after
const card = page.locator('[data-testid="board-card"]').first();
```

- [ ] **Step 4: Prove the script still produces correct images**

Run `pnpm demo:media` against the local demo stack, then **open every PNG in `docs/media/` and look at it**. An empty state, an error banner or a spinner caught mid-flight is a failure. Confirm all ten match their captions.

- [ ] **Step 5: Prove the hooks are load-bearing**

Temporarily rename one `data-testid` in a component, re-run the script, and confirm it fails rather than silently capturing the wrong element. Restore it.

- [ ] **Step 6: Full gate + commit**

```bash
pnpm typecheck && pnpm lint && pnpm build && pnpm depcruise
git add scripts/capture-demo-media.ts apps/web/src
git commit -m "test(web,scripts): select demo media by data-testid, not by style classes"
```

---

### Task 2: Tailwind, tokens, and the type scale

**Files:**
- Create: `apps/web/tailwind.config.ts`, `apps/web/postcss.config.mjs`, `apps/web/src/app/tokens.css`
- Modify: `apps/web/package.json`, `pnpm-lock.yaml`, `apps/web/src/app/globals.css`, `apps/web/src/app/layout.tsx`
- Test: `apps/web/src/app/tokens.test.ts`

**Interfaces:**
- Produces: Tailwind utilities resolving to custom properties — `bg-canvas`, `bg-surface`, `text-ink`, `text-muted`, `text-soft`, `border-line`, `bg-anchor`, `bg-anchor-soft`, and for each state `{info,warn,ok,bad}`: `text-<name>` and `bg-<name>-soft`, plus `bg-irreversible` / `text-irreversible`. Type scale `text-xs`…`text-2xl`. Font family `font-sans` = Inter.

- [ ] **Step 1: Write the failing test**

The tokens file is the single source of truth, so assert that it actually defines every name the Tailwind config claims to map — a mismatch produces a utility that silently resolves to nothing.

```ts
// apps/web/src/app/tokens.test.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REQUIRED = [
  "--canvas", "--surface", "--ink", "--muted", "--soft", "--line",
  "--anchor", "--anchor-soft", "--shadow",
  "--info", "--info-soft", "--warn", "--warn-soft",
  "--ok", "--ok-soft", "--bad", "--bad-soft", "--irreversible",
] as const;

describe("design tokens", () => {
  const css = readFileSync(path.resolve(import.meta.dirname, "tokens.css"), "utf8");

  it("defines every token the Tailwind config maps", () => {
    for (const name of REQUIRED) expect(css).toContain(`${name}:`);
  });

  it("defines them on :root so a dark palette can override them later", () => {
    expect(css).toMatch(/:root\s*\{/);
  });

  it("carries no raw hex outside the :root block", () => {
    const afterRoot = css.slice(css.indexOf("}"));
    expect(afterRoot).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @careerhq/web test -- tokens`
Expected: FAIL — `ENOENT: no such file or directory … tokens.css`

- [ ] **Step 3: Add the dependencies**

```bash
pnpm --filter @careerhq/web add -D tailwindcss@^4 @tailwindcss/postcss@^4 postcss@^8
```

- [ ] **Step 4: Write `tokens.css`**

```css
:root {
  --canvas: #f2f1ed;
  --surface: #fbfaf8;
  --ink: #191d1c;
  --muted: #666c6a;
  --soft: #8a908d;
  --line: #dddcd6;
  --anchor: #16211f;
  --anchor-soft: #1f2d29;
  --shadow: 0 14px 40px rgba(29, 36, 32, 0.07);

  --info: #3c6680;
  --info-soft: #e3edf2;
  --warn: #8f5d18;
  --warn-soft: #f6ead6;
  --ok: #21674f;
  --ok-soft: #e1efe8;
  --bad: #a83f39;
  --bad-soft: #f6e5e3;

  /* Reserved: controls that touch the outside world and cannot be undone.
     Confirm-and-submit, Send, Delete. Nothing decorative, ever. */
  --irreversible: #c2503c;
}
```

- [ ] **Step 5: Write `postcss.config.mjs` and `tailwind.config.ts`**

```js
// postcss.config.mjs
export default { plugins: { "@tailwindcss/postcss": {} } };
```

```ts
// tailwind.config.ts
import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "var(--canvas)", surface: "var(--surface)",
        ink: "var(--ink)", muted: "var(--muted)", soft: "var(--soft)",
        line: "var(--line)", anchor: "var(--anchor)",
        "anchor-soft": "var(--anchor-soft)",
        info: "var(--info)", "info-soft": "var(--info-soft)",
        warn: "var(--warn)", "warn-soft": "var(--warn-soft)",
        ok: "var(--ok)", "ok-soft": "var(--ok-soft)",
        bad: "var(--bad)", "bad-soft": "var(--bad-soft)",
        irreversible: "var(--irreversible)",
      },
      boxShadow: { card: "var(--shadow)" },
      fontSize: {
        xs: "0.75rem", sm: "0.875rem", base: "1rem",
        lg: "1.125rem", xl: "1.3rem", "2xl": "1.5rem",
      },
    },
  },
} satisfies Config;
```

- [ ] **Step 6: Load Inter and the tokens in the layout**

In `apps/web/src/app/layout.tsx`, above the existing `import "./globals.css"`:

```tsx
import { Inter } from "next/font/google";
import "./tokens.css";

const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-sans" });
```

and put `className={inter.variable}` on the `<html>` element. `next/font` self-hosts the files at build time — verify no request to `fonts.googleapis.com` in Step 8.

- [ ] **Step 7: Run the test — it should pass**

Run: `pnpm --filter @careerhq/web test -- tokens`
Expected: PASS (3 tests)

- [ ] **Step 8: Prove Tailwind and the font actually work in a built app**

```bash
pnpm --filter @careerhq/web build && pnpm --filter @careerhq/web start
```

Add `className="bg-canvas text-ink"` to one element, load the page, and confirm in devtools that the computed background is `rgb(242, 241, 237)`. Check the Network tab shows **no** request to `fonts.googleapis.com` or `fonts.gstatic.com`. Then revert the probe element.

- [ ] **Step 9: Verify the container build too**

The host gate cannot see a broken `docker build` — five packages already shipped one. Run:

```bash
docker compose -p careerhq-uicheck -f infra/docker-compose.yml build web
```

Expected: succeeds. Then `docker image rm careerhq-uicheck-web` if it was created under that name.

- [ ] **Step 10: Commit**

```bash
git add apps/web/tailwind.config.ts apps/web/postcss.config.mjs apps/web/src/app/tokens.css apps/web/src/app/tokens.test.ts apps/web/src/app/layout.tsx apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): design tokens and Tailwind, wired to CSS custom properties"
```

---

### Task 3: The component layer

Seven pages are meant to come out well from shared components with no per-page design. Build the components first so that claim can be tested.

**Files:**
- Create: `apps/web/src/components/button.tsx`, `badge.tsx`, `card.tsx`, `field.tsx`, `row.tsx`, `empty-state.tsx`, `countdown.tsx`, `chip.tsx`, `section.tsx`, `reconcile-panel.tsx`
- Test: `apps/web/src/components/button.test.tsx`, `badge.test.tsx`, `countdown.test.tsx`

**Interfaces:**
- Produces:
```tsx
export type ButtonTone = "default" | "primary" | "irreversible" | "ghost";
export function Button(props: { tone?: ButtonTone } & React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element;

export type BadgeTone = "neutral" | "info" | "warn" | "ok" | "bad";
export function Badge(props: { tone: BadgeTone; children: React.ReactNode; testId?: string }): JSX.Element;

export function Card(props: { children: React.ReactNode; className?: string }): JSX.Element;
export function Field(props: { label: string; error?: string; children: React.ReactNode }): JSX.Element;
/** The list-row primitive the fact, answer, CV and inbox lists are built from. */
export function Row(props: { children: React.ReactNode; href?: string; testId?: string }): JSX.Element;
export function EmptyState(props: { title: string; hint?: string }): JSX.Element;
export function Countdown(props: { expiresAt: string }): JSX.Element;   // live mm:ss
export function Chip(props: { children: React.ReactNode }): JSX.Element; // provenance
export function Section(props: { title: string; action?: React.ReactNode; children: React.ReactNode }): JSX.Element;
export function ReconcilePanel(props: { reason: string; children?: React.ReactNode }): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/src/components/button.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "./button.js";

describe("Button", () => {
  it("marks an irreversible action distinctly from a primary one", () => {
    const { rerender } = render(<Button tone="primary">Save</Button>);
    const primary = screen.getByRole("button").className;
    rerender(<Button tone="irreversible">Confirm and submit</Button>);
    const irreversible = screen.getByRole("button").className;
    // The whole point: these must not look the same.
    expect(irreversible).not.toBe(primary);
    expect(irreversible).toContain("irreversible");
  });

  it("stays a real button for keyboard users", () => {
    render(<Button tone="irreversible">Confirm</Button>);
    expect(screen.getByRole("button")).toBeEnabled();
  });
});
```

```tsx
// apps/web/src/components/countdown.test.tsx
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Countdown } from "./countdown.js";

describe("Countdown", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("counts down and reaches expired", () => {
    const expiresAt = new Date(Date.now() + 62_000).toISOString();
    render(<Countdown expiresAt={expiresAt} />);
    expect(screen.getByText("1:02")).toBeInTheDocument();
    vi.advanceTimersByTime(63_000);
    expect(screen.getByText(/expired/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @careerhq/web test -- components`
Expected: FAIL — cannot resolve `./button.js`. If `@testing-library/react` is absent, add it: `pnpm --filter @careerhq/web add -D @testing-library/react @testing-library/jest-dom jsdom`, and set `environment: "jsdom"` for these files in the vitest config.

- [ ] **Step 3: Implement the components**

`Button` maps tone to token utilities — `irreversible` → `bg-irreversible text-white`, `primary` → `bg-ink text-white`, `default` → `border border-line bg-surface text-ink`, `ghost` → `text-muted`. Every tone gets `focus-visible:outline focus-visible:outline-2` so keyboard focus is visible. `Badge` maps tone to `bg-<tone>-soft text-<tone>`. `ReconcilePanel` renders a hatched left border (`repeating-linear-gradient`) plus an explicit "outcome unknown" label — it must not look like either success or failure.

- [ ] **Step 4: Run the tests — they should pass**

Run: `pnpm --filter @careerhq/web test -- components`
Expected: PASS

- [ ] **Step 5: Check contrast for every token pair**

For each of `info/info-soft`, `warn/warn-soft`, `ok/ok-soft`, `bad/bad-soft`, `ink/surface`, `muted/surface`, and `white/irreversible`, compute the contrast ratio and assert ≥ 4.5:1. Record the numbers in the task report. If a pair fails, adjust the token — not the component.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components
git commit -m "feat(web): component layer on the token system"
```

---

### Task 4: The shell

**Files:**
- Modify: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/components/sidebar.tsx`, `apps/web/src/components/demo-banner.tsx`
- Test: `apps/web/src/components/sidebar.test.tsx`

**Interfaces:**
- Consumes: `Badge` from Task 3.
- Produces: `<Sidebar counts={{ discovery?: number; mail?: number; due?: number }} />`. Collapsed state in `localStorage` under `careerhq.sidebar.collapsed`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/sidebar.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Sidebar } from "./sidebar.js";

describe("Sidebar", () => {
  it("shows a count when there is one, and omits it at zero", () => {
    render(<Sidebar counts={{ discovery: 27, mail: 0 }} />);
    expect(screen.getByText("27")).toBeInTheDocument();
    // A zero count is noise, not information.
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("links every destination", () => {
    render(<Sidebar counts={{}} />);
    for (const href of ["/overview", "/jobs", "/applications", "/inbox", "/facts", "/answers", "/cvs", "/settings"]) {
      expect(screen.getByRole("link", { name: new RegExp(href.slice(1), "i") })).toHaveAttribute("href", href);
    }
  });
});
```

- [ ] **Step 2: FAIL.** Run: `pnpm --filter @careerhq/web test -- sidebar`. Expected: cannot resolve `./sidebar.js`.

- [ ] **Step 3: Implement `Sidebar` and `DemoBanner`, and rewire `layout.tsx`**

Sidebar: `w-64` on `bg-anchor`, collapsing to `w-16`; active row `bg-anchor-soft`; counts right-aligned, omitted when zero or undefined. The collapse toggle is a real `<button>` with an accessible name. `DemoBanner` moves onto the token palette and keeps its existing copy and `role="status"` verbatim — the wording was reviewed and is load-bearing.

- [ ] **Step 4: PASS.** Run: `pnpm --filter @careerhq/web test -- sidebar`.

- [ ] **Step 5: Drive it in a real browser**

`pnpm --filter @careerhq/web build && start`, then with a real browser: every destination navigates; collapse persists across a reload; the banner renders with `DEMO_MODE=true` and is absent without it; keyboard tab order reaches every link and the toggle with a visible focus ring.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/layout.tsx apps/web/src/components
git commit -m "feat(web): sidebar shell with collapse and live counts"
```

---

### Task 5: The seven systematic pages

The test of the component layer. If these need per-page CSS, the components are underspecified — fix the components, not the page.

**Files:**
- Modify: `apps/web/src/app/(dashboard)/facts/page.tsx`, `answers/page.tsx`, `cvs/page.tsx`, `inbox/page.tsx`, `inbox/suggestions.tsx`, `settings/page.tsx`, `settings/email/page.tsx`, `settings/email/connection-form.tsx`, and their child components
- Modify: `apps/web/src/app/globals.css` (delete the rules these pages no longer use)

**Interfaces:**
- Consumes: every component from Task 3, the shell from Task 4.

- [ ] **Step 1: Convert one page and record what the components could not do**

Start with `/facts`. The idiom to follow — semantic classes out, token utilities in, `data-testid` untouched:

```tsx
// before
<li className="facts-row">
  <span className="facts-claim">{fact.claim}</span>
  <span className="badge-stale">Stale</span>
</li>

// after
<Row testId="facts-row">
  <span className="text-ink">{fact.claim}</span>
  <Badge tone="warn">Stale</Badge>
</Row>
```

Note `tone="warn"` rather than a "stale" colour: a stale fact is something **the user must act on**, which is what warn means in this system. Applying the vocabulary correctly matters more than matching the previous appearance.

Where you reach for a bespoke style, note it — that list is the deliverable of this step as much as the page is.

- [ ] **Step 2: Fix the component layer, not the page**

Extend Task 3's components to cover the gaps found. Re-run their tests.

- [ ] **Step 3: Convert the remaining six**

- [ ] **Step 4: Delete the dead CSS**

Remove from `globals.css` every rule these pages no longer reference. `globals.css` should shrink substantially — report the before and after line counts.

- [ ] **Step 5: Drive all seven in a real browser**

Each renders, each form still submits, each error still displays, no console errors, no hydration warnings. **A passing test suite proves none of this.**

- [ ] **Step 6: Full gate + commit**

```bash
git add apps/web/src
git commit -m "feat(web): the systematic pages on the component layer"
```

---

### Task 6: `/overview` and `/jobs`

**Files:**
- Modify: `apps/web/src/app/(dashboard)/overview/page.tsx`, `.../jobs/page.tsx`, `.../jobs/job-row.tsx`, `.../jobs/health.tsx`

- [ ] **Step 1: Rebuild `/overview`**

Funnel counts as cards using tabular numerals; due follow-ups as a scannable list with the overdue ones in `warn`. This is the first screen a visitor lands on and currently the weakest.

- [ ] **Step 2: Rebuild `/jobs`**

Score breakdown expands inline; the LLM rationale readable rather than crammed; red flags in `warn`; keyword and LLM scores aligned in tabular numerals.

- [ ] **Step 3: Verify in a real browser, including the empty states**

Both pages with seeded data **and** with an empty workspace. An empty state that looks broken is a bug — this app's demo resets every six hours and a visitor can land mid-reset.

- [ ] **Step 4: Confirm the `data-testid` hooks still resolve**

Run `pnpm demo:media` and inspect `01-overview.png` and `04-discovery-inbox.png`.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(web): redesign the overview and discovery screens"
```

---

### Task 7: `/applications` board

**Files:**
- Modify: `apps/web/src/app/(dashboard)/applications/page.tsx`, `board.tsx`, `transition-buttons.tsx`

- [ ] **Step 1: Rebuild the board**

Columns per state; cards carrying company, title, and the state badge from Task 3. Guarded transitions keep their existing server-action behaviour untouched — this is a presentation change only.

- [ ] **Step 2: Verify every transition still works in a real browser**

Each guarded transition, and a refused one still showing its reason.

- [ ] **Step 3: `pnpm demo:media`, inspect `02-applications-board.png`**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(web): redesign the application board"
```

---

### Task 8: `/applications/[id]` — two column

The densest screen and the one that carries the product story.

**Files:**
- Modify: `apps/web/src/app/(dashboard)/applications/[id]/page.tsx`, `materials.tsx`, `qa.tsx`, `site-panel.tsx`, `email-panel.tsx`, `messages.tsx`

- [ ] **Step 1: Build the two-column frame**

Main scroll (materials, screening Q&A, auto-apply, email) plus a sticky rail (status badge, computed next action, timeline).

- [ ] **Step 2: Apply the state vocabulary throughout**

AI-generated-not-approved in `warn`; sensitive fields with a lock badge; `NEEDS_RECONCILE` in the `ReconcilePanel`; `PENDING_CONFIRMATION` rendering the live `Countdown`; **"Confirm and submit" the only `irreversible`-toned control on the page**.

- [ ] **Step 3: Verify the whole auto-apply flow in a real browser**

Prepare → review → tick consent → preview → retype target → confirm, against demo-ats. The consent tick must be reachable and operable by keyboard alone — a consent control you cannot reach without a mouse is one some users cannot give.

- [ ] **Step 4: `pnpm demo:media`, inspect shots 03, 05, 06, 08, 09**

- [ ] **Step 5: Full gate + commit**

```bash
git commit -m "feat(web): redesign the application detail screen"
```

---

### Task 9: Final verification and redeploy

- [ ] **Step 1: Full gate, uncached** — `pnpm lint && pnpm typecheck && pnpm depcruise && pnpm build && TEST_DATABASE_URL=… pnpm test --force`. Expected: **1,158+ passing**. Paste tails.
- [ ] **Step 2: Confirm `globals.css` shrank** and no component carries a raw hex: `grep -rnE "#[0-9a-fA-F]{3,8}\b" apps/web/src --include="*.tsx"` should return nothing.
- [ ] **Step 3: Regenerate the gallery and inspect all ten images.** Replace the README screenshots.
- [ ] **Step 4: Verify the container build**, then redeploy per `docs/runbook-demo.md` §2 — migrate, `up -d --build`, health, neighbour check.
- [ ] **Step 5: Audit the live demo** — every route renders, the banner is present, no console errors, no hydration warnings, and the safety posture is unchanged (`gate_closed` on a confirm attempt, credential setup still refused).
- [ ] **Step 6: Commit** — `chore: UI redesign verification`.
