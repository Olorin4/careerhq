# CareerHQ UI — design system and redesign

**Status:** approved design, ready for an implementation plan
**Date:** 2026-08-05
**Branch target:** a fresh worktree off `master` (`7e47c63`+)

## Why

CareerHQ works. 1,158 tests pass, the hosted demo at <https://careerhq.nickkalas.dev>
survives an adversarial audit, and the architecture is the strongest thing about the
repository. None of that is what a prospective client sees first.

What they see is `apps/web`: 1,573 lines of ad-hoc component CSS with **no shared
foundation** — `:root` carries only `color-scheme`, the font stack is `system-ui`,
and colours are hardcoded per component (`#b00020` in one place, another hex
elsewhere). Nothing compounds, so every screen is styled from zero and the result
reads as a working prototype.

The stated purpose of this project is a portfolio piece. The first impression is
currently its weakest surface. This redesign fixes that.

## Decisions

Each of these was chosen deliberately; the rejected option is recorded because a
decision without its alternative gets re-litigated.

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Scope | Full redesign, including page layouts | A token-only re-skin would leave it looking like a styled document |
| Theme | The predecessor's *logic*, retuned values | Copying `../career` verbatim wastes the chance to let the palette serve this product; a fresh palette discards a proven structure |
| Technology | Tailwind | Hand-written layered CSS was the alternative and is defensible, but Tailwind is the visible-in-portfolio signal the owner wants |
| Test coupling | `data-testid` first, as a prerequisite | Keeping semantic classes as hidden test hooks invites someone to "tidy up" a load-bearing class later |
| Dark mode | Light only, tokens structured so dark is additive | Designing two themes properly is real work; one executed confidently beats two executed adequately |
| Shell | Fixed 260px sidebar, collapsible to 64px | A next-action rail costs width on every page to serve a feature strongest on one |
| Detail page | Two column, nothing hidden | Channel tabs make the better *application*; this screen's job in a portfolio is to show depth, and depth is what two-column displays |

## Foundation

### Tokens

One `apps/web/src/app/tokens.css` defines CSS custom properties.
`tailwind.config.ts` maps semantic utility names onto them —
`bg-canvas`, `bg-surface`, `text-ink`, `text-muted`, `border-line`, and the state
colours below. Utilities therefore resolve to `var(--canvas)` rather than a literal,
which is what makes a dark palette a later *addition* rather than a refactor.

No component may introduce a raw hex. If a colour is needed that the tokens do not
provide, the token set is wrong and should be extended.

### Palette

| Token | Value | Role |
|---|---|---|
| `--canvas` | `#f2f1ed` | page ground |
| `--surface` | `#fbfaf8` | cards, panels, rows |
| `--ink` | `#191d1c` | primary text |
| `--muted` | `#666c6a` | secondary text |
| `--soft` | `#8a908d` | tertiary, timestamps |
| `--line` | `#dddcd6` | hairlines, borders |
| `--anchor` | `#16211f` | sidebar ground |
| `--anchor-soft` | `#1f2d29` | sidebar active row |
| `--shadow` | `0 14px 40px rgba(29,36,32,.07)` | the single elevation |

Deliberately one shadow. Multiple elevations imply a depth hierarchy this app does
not have.

### The state vocabulary

Colour encodes **who acts next and how reversible the action is** — not generic
severity. This is the rule that makes the visual system carry the product's thesis
rather than merely look tidy.

| Token pair | Meaning | Applied to |
|---|---|---|
| neutral (`--muted` on `--surface`) | system state, nothing needed | `DISCOVERED`, counts, metadata |
| `--info` `#3c6680` / `--info-soft` `#e3edf2` | in progress, informational | `SHORTLISTED`, `SUBMITTING`, provenance chips |
| `--warn` `#8f5d18` / `--warn-soft` `#f6ead6` | **the user** must act | `NEEDS_FACTS`, AI-generated-not-approved, stale fact, unanswered question, "needs you" |
| `--ok` `#21674f` / `--ok-soft` `#e1efe8` | done, verified | `SUBMITTED`, approved, confirmed receipt, verified fact |
| `--bad` `#a83f39` / `--bad-soft` `#f6e5e3` | failed, refused | `FAILED`, gate refusals, validation errors |
| `--irreversible` `#c2503c` | **cannot be undone** | *only* controls that touch the outside world |

`--irreversible` is reserved. It appears on "Confirm and submit", "Send", "Delete",
and nothing else. Today "Confirm and submit" is visually identical to "Back to
edit"; giving irreversibility its own colour means a user can see the difference
before reading the label. Terracotta is deepened from the predecessor's `#e56551`
to `#c2503c` because it must pass AA as text and on small controls, which the
lighter value does not.

Two states need more than a colour:

- **`NEEDS_RECONCILE`** means "we genuinely cannot tell whether this was
  submitted". It is neither success nor failure and must not be flattened into
  amber. It gets a distinct marked treatment — a hatched left border plus an
  explicit icon — so it reads as *unknown*, which is what it is.
- **`PENDING_CONFIRMATION`** carries a live 10-minute expiry. It renders as a
  countdown, not a static badge, because the number is the point.

### Typography

Inter, with the existing `system-ui` stack as fallback. Loaded via `next/font`,
which self-hosts the files at build time — the hosted demo must not make a runtime
request to Google Fonts, both because an external dependency on the render path is
a availability risk and because "nothing leaves this server" is a claim the demo
banner makes.

One type scale defined in tokens: `--text-xs` 0.75rem through `--text-2xl` 1.5rem,
ratio 1.2. Numerals tabular wherever counts or scores align in columns (discovery
scores, funnel figures, timeline timestamps).

## Shell

Fixed 260px sidebar on `--anchor`, collapsing to 64px icons with the collapsed
state persisted in `localStorage`. Live counts render beside the destinations where
they mean something: discovery inbox size, unread mail, due follow-ups. A count is
omitted rather than shown as zero.

The demo banner is redesigned as part of the shell. It currently ships as a purple
bar that will clash with a warm palette, and it is the first thing a visitor reads
— it should look deliberate.

Below tablet the sidebar becomes an overlay. Not mobile-first: this is a desktop
working tool and pretending otherwise spends effort that never shows.

## Page treatments

**Bespoke — four screens that carry the product story:**

- **`/overview`** — funnel and due follow-ups. The weakest screen today and the
  first one a visitor lands on.
- **`/jobs`** — discovery, with the score breakdown expanding inline and the LLM
  rationale and red flags legible rather than crammed.
- **`/applications`** — the Kanban board and its guarded transitions.
- **`/applications/[id]`** — two column: main scroll (materials, screening Q&A,
  auto-apply, email) plus a sticky rail (status, computed next action, timeline).

**Systematic — seven surfaces the component layer should carry:** `/facts`,
`/answers`, `/cvs`, `/inbox`, `/settings`, `/settings/email`, and the root
redirect. If these do not come out well from the shared components, the component
layer is underspecified — which is a useful thing to learn early rather than paper
over with per-page CSS.

## Component inventory

The shared layer the systematic pages depend on: button (default / primary /
irreversible / ghost), badge, form field (label, input, select, textarea, error),
card, table row, empty state, countdown, provenance chip, section heading, and the
`NEEDS_RECONCILE` marked panel.

## Prerequisite: test hooks

**29 class-based selectors are load-bearing** in `apps/web/src/lib/site-e2e.test.ts`,
`apps/worker/src/autoapply/driver.test.ts` and `scripts/capture-demo-media.ts` —
`.board-card`, `.job-row-breakdown`, `.materials-needs-facts`, `.badge-ai-draft`
and others. There are **zero** `data-testid` attributes in the codebase.

A restyle that removes those classes would break the e2e suite *and* the screenshot
script — and the screenshot script regenerates the README gallery, so it would break
the very thing that displays the new design.

Therefore, before any visual work: add `data-testid` to the selected elements,
migrate tests and the capture script onto them, and verify green. The restyle can
then be aggressive without fear, and the suite stays robust against future visual
work.

## Verification

- Full gate green throughout: `pnpm typecheck`, `pnpm lint`, `pnpm test`,
  `pnpm build`, `pnpm depcruise`. Baseline **1,158 passing**.
- **A green suite does not prove a UI change works.** Every screen must be driven
  in a real `next start` with a real browser — the project has already shipped two
  bugs through a fully green gate for exactly this reason.
- `pnpm demo:media` regenerates the gallery, and **every image is inspected** before
  it lands. An empty state or a spinner caught mid-flight is the default outcome of
  naive screenshot automation.
- Contrast checked per token pair, not assumed.
- The hosted demo is redeployed and re-audited afterwards.

## Out of scope

- Dark mode (structured for, not built)
- Mobile-first layouts
- Any change to server actions, gates, or data flow — this is a presentation-layer
  change and must not alter behaviour
- `apps/demo-ats` styling: it is a *fictional employer's* site and should look like
  a different company's product, not like CareerHQ

## Size, and where it splits

This is large for one plan: a prerequisite, a foundation, a shell, four bespoke
screens and a component layer carrying seven more. It is kept as one plan because
the pieces interlock — the component layer is discovered by building the bespoke
screens and proven by the systematic ones, and splitting that across two plans
would mean designing the components twice.

The natural split point, if it needs one mid-flight, is after the shell and the
systematic pages are green: at that moment the app is coherent and shippable, and
the four bespoke screens become an independent second pass. A plan that stalls
there has still delivered the thing that fixes the first impression.

## Risks

- **Largest diff in the project's history across the most-tested app.** The
  `data-testid` prerequisite is what keeps it safe; skipping it converts this from
  a contained change into a source of mystery failures.
- **Tailwind adds a dependency and a build step** to a repo whose CI and Docker
  builds are known-good. The build must be verified in the container, not only on
  the host — five packages already shipped a broken `docker build` that the host
  gate could not see.
- **Scope creep from "bespoke".** Four screens are bespoke; the other seven are
  explicitly not, and reopening that is how this becomes unbounded.
