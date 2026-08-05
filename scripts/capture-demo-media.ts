/**
 * Captures the README's screenshot gallery and the walkthrough recording from a
 * RUNNING demo stack (spec P6 §3, Task 9).
 *
 *   docker compose -f infra/docker-compose.yml -f infra/docker-compose.demo.yml \
 *     --profile tools run --rm migrate
 *   docker compose -f infra/docker-compose.yml -f infra/docker-compose.demo.yml up -d
 *   pnpm demo:media
 *
 * The point of automating this is that it is RE-RUNNABLE: when the UI changes,
 * regenerate the gallery instead of re-staging ten screenshots by hand. Three
 * things make that true, and all three are load-bearing:
 *
 *   1. It drives the demo stack, not a hand-prepared database. Every fact,
 *      application, listing and receipt on screen comes from
 *      `packages/db/src/demo-seed.ts`.
 *   2. It reseeds before each phase by restarting the worker, which seeds on
 *      boot. Several captures below deliberately MUTATE the demo (they archive
 *      the fact bank, promote a listing, drive a real auto-apply attempt), so a
 *      run that did not reset would produce different images the second time.
 *   3. It asserts what each image is supposed to show — a missing provenance
 *      chip or an empty panel fails the run rather than shipping a screenshot
 *      of a bug into the README.
 *
 * Every locator below targets a `data-testid`, not a CSS class: this script is
 * the sole consumer of CareerHQ's styling outside the components themselves,
 * and a `data-testid` is the one hook a restyle is not entitled to rename or
 * remove (see Task 1 of the UI redesign spec). `getByRole` calls (buttons by
 * accessible name) need no such hook and are untouched.
 *
 * Notes on the demo's own behaviour, because two captures depend on it:
 *
 *   - `AI_MODE=replay` with no `OPENROUTER_API_KEY`. Generation returns the
 *     committed fixture instantly. Fixtures exist for exactly three prompts
 *     (Wexford Health's cover letter, Silvermark Labs' email body, and the
 *     "Why do you want to work here?" screening question), so those are the
 *     only generate clicks this script makes: any other prompt is an honest
 *     `replay_miss`, which is not a screenshot anyone wants in a README.
 *   - `SUBMISSIONS_LIVE_COMPANY_SITE=false` is pinned in the demo overlay, so
 *     the walkthrough's final confirm is REFUSED (`gate_closed`) — by design,
 *     and the recording shows it. The submitted receipt it then shows is the
 *     seeded Wexford Health attempt, which went through the whole gated path.
 *
 * Environment (all optional):
 *   DEMO_BASE_URL         where the demo web app answers   (default http://127.0.0.1:3100)
 *   DEMO_MEDIA_DIR        output directory                 (default <repo>/docs/media)
 *   DEMO_COMPOSE_PROJECT  compose project to reseed        (default careerhq)
 *   DEMO_MEDIA_ATS_URL    the form the auto-apply demo reads, as the SERVER
 *                         resolves it — a compose service name, not localhost
 *                         (default http://demo-ats:3001/greenhouse/jobs/eng-1)
 *   DEMO_MEDIA_RESEED=0   skip the reseeds (faster; only safe on a fresh stack)
 *   DEMO_MEDIA_ONLY       comma-separated phase filter: "shots", "video"
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Locator, type Page } from "playwright";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MEDIA_DIR = process.env.DEMO_MEDIA_DIR ?? path.join(REPO_ROOT, "docs", "media");
const BASE_URL = (process.env.DEMO_BASE_URL ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
const COMPOSE_PROJECT = process.env.DEMO_COMPOSE_PROJECT ?? "careerhq";
const ATS_URL = process.env.DEMO_MEDIA_ATS_URL ?? "http://demo-ats:3001/greenhouse/jobs/eng-1";
const RESEED = process.env.DEMO_MEDIA_RESEED !== "0";
const ONLY = (process.env.DEMO_MEDIA_ONLY ?? "shots,video").split(",").map((s) => s.trim());

/** The README's gallery is 1440×900 — a laptop, which is what a reader is on. */
const VIEWPORT = { width: 1440, height: 900 };
/** Retina density: the gallery is read scaled down, and 1× text looks soft there. */
const SCALE = 2;
/**
 * How far below the viewport top to park a panel that is about to be framed.
 * The demo banner is `position: sticky`, so it paints over whatever sits at
 * y=0: scrolling a panel exactly to the top hides its own heading behind it.
 */
const BANNER_CLEARANCE = 72;

const COMPOSE_ARGS = [
  "compose", "-p", COMPOSE_PROJECT,
  "-f", path.join(REPO_ROOT, "infra", "docker-compose.yml"),
  "-f", path.join(REPO_ROOT, "infra", "docker-compose.demo.yml"),
];

function log(message: string): void {
  console.log(`[demo:media] ${message}`);
}

async function docker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...COMPOSE_ARGS, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { err += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out + err);
      else reject(new Error(`docker ${args.join(" ")} exited ${code}\n${err}`));
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/**
 * Rebuilds the demo workspace by restarting the worker, which seeds on boot
 * (see `apps/worker/src/main.ts`). Deliberately the documented behaviour rather
 * than a private hook: if boot-seeding ever stops working, the deploy is broken
 * too, and this failing is the right way to find out.
 *
 * Waits for a NEW `demo.reset (boot)` line rather than a fixed sleep — the seed
 * replays every repo call and takes as long as it takes.
 */
async function reseed(): Promise<void> {
  if (!RESEED) {
    log("reseed skipped (DEMO_MEDIA_RESEED=0)");
    return;
  }
  const countBoots = async (): Promise<number> =>
    (await docker(["logs", "worker"])).split("\n").filter((l) => l.includes("demo.reset (boot)")).length;

  const before = await countBoots();
  log("reseeding (restarting the worker)…");
  await docker(["restart", "worker"]);
  const deadline = Date.now() + 120_000;
  for (;;) {
    if ((await countBoots()) > before) break;
    if (Date.now() > deadline) throw new Error("the worker did not reseed within 120s");
    await sleep(1_000);
  }
  // The seed commits in one transaction; give the web app's next render a
  // moment rather than racing the commit.
  await sleep(1_000);
  log("reseeded");
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

/**
 * Kills every source of frame-to-frame variation a screenshot can catch
 * mid-flight: CSS transitions/animations, and the text caret (several captures
 * are taken with an input focused, and a blinking caret makes two runs of the
 * same script differ).
 */
const STEADY_CSS = `
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
    caret-color: transparent !important;
  }
`;

async function goto(page: Page, pathname: string): Promise<void> {
  await page.goto(`${BASE_URL}${pathname}`, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: STEADY_CSS });
  // The demo banner is the first thing on every page and the proof that these
  // images come from the demo, not a dev database.
  await page.locator('[data-testid="demo-banner"]').waitFor({ state: "visible" });
}

/**
 * Scrolls `target` towards the top of the viewport. Best-effort by nature: a
 * page whose remaining content is shorter than the viewport cannot put an
 * element at the top at all, which is why framing is decided by {@link shot}'s
 * clip and not by the scroll position.
 */
async function scrollTo(page: Page, target: Locator, offset = 24): Promise<void> {
  await target.waitFor({ state: "visible" });
  await target.evaluate((el, off) => {
    const top = el.getBoundingClientRect().top + window.scrollY - off;
    window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
  }, offset);
  await page.waitForTimeout(200);
}

interface ShotFrame {
  /** Start the frame at this element instead of the top of the viewport. */
  from?: Locator;
  /** End the frame just past this element instead of where the page's content ends. */
  to?: Locator;
}

/** Viewport-relative top/bottom of an element, in CSS pixels. */
async function edges(target: Locator): Promise<{ top: number; bottom: number }> {
  await target.waitFor({ state: "visible" });
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
}

/**
 * A 1440-wide capture, framed to the thing it is a screenshot OF.
 *
 * Always the full 1440 width, so the gallery is one consistent size; the height
 * is where the interesting content ends, capped at the 900px viewport. Two
 * reasons this is not just "screenshot the viewport":
 *
 *   - the app lays out in a 960px centred column, and several of these pages
 *     finish well short of 900px. A thumbnail that is half empty white reads as
 *     an unfinished screen rather than a short page.
 *   - `window.scrollTo` clamps at the bottom of the document, so on a long page
 *     whose last section is shorter than the viewport (every application detail
 *     page here) the panel being captured cannot be scrolled to the top. The
 *     frame has to be chosen by clipping, not by scrolling.
 *
 * Playwright's `clip` is viewport-relative, which is what makes this work with
 * the sticky demo banner: a frame that starts at y=0 keeps the banner, and one
 * that starts at an element does not.
 */
async function shot(page: Page, name: string, frame: ShotFrame = {}): Promise<void> {
  await page.waitForTimeout(250);
  const top = frame.from ? Math.max(0, Math.floor((await edges(frame.from)).top) - 12) : 0;
  const contentBottom = frame.to
    ? Math.ceil((await edges(frame.to)).bottom) + 12
    : await page.evaluate(() => {
        // Runs in the browser context, so it cannot reference the Node-side
        // locator helpers above — it re-selects by the same `data-testid`.
        const main = document.querySelector('[data-testid="app-main"]');
        return main ? Math.ceil(main.getBoundingClientRect().bottom) + 24 : window.innerHeight;
      });
  const height = Math.max(240, Math.min(VIEWPORT.height - top, contentBottom - top));

  const file = path.join(MEDIA_DIR, `${name}.png`);
  await page.screenshot({ path: file, clip: { x: 0, y: top, width: VIEWPORT.width, height } });
  const { size } = await stat(file);
  log(`captured ${name}.png (${VIEWPORT.width}×${height}, ${Math.round(size / 1024)} KB)`);
}

/** The application id for a seeded company, found the way a visitor would: from the board. */
async function applicationIdFor(page: Page, company: string): Promise<string> {
  await goto(page, "/applications");
  const link = page.locator('[data-testid="board-card-link"]', { hasText: company }).first();
  await link.waitFor({ state: "visible" });
  const href = await link.getAttribute("href");
  const id = href?.split("/").pop();
  if (!id) throw new Error(`no application card for ${company}`);
  return id;
}

/** Fails the run rather than shipping a screenshot of an empty or broken panel. */
async function assertVisible(locator: Locator, what: string): Promise<void> {
  if (await locator.count() === 0) throw new Error(`nothing to capture: ${what}`);
  if (!(await locator.first().isVisible())) throw new Error(`not visible: ${what}`);
}

// ---------------------------------------------------------------------------
// The ten shots
// ---------------------------------------------------------------------------

async function captureShots(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
  const page = await context.newPage();
  try {
    // 1 — the funnel and the overdue follow-up.
    await goto(page, "/overview");
    await assertVisible(page.locator('[data-testid="overview-due-item"]'), "a due follow-up on /overview");
    await assertVisible(page.locator('[data-testid="overview-counts-item"]'), "the state counts on /overview");
    await shot(page, "01-overview");

    // 2 — the Kanban board. Scrolled so the board's own column headings are the
    // top of the frame: the "log an application" form sits above it, and a shot
    // that catches half of that form reads as a page cut in two. The board is a
    // 9-column grid inside the app's 960px column, so it scrolls sideways for
    // the later states — that is what the product does at this width.
    await goto(page, "/applications");
    await assertVisible(page.locator('[data-testid="board-card"]'), "application cards on /applications");
    const board = page.locator('[data-testid="board"]').first();
    await scrollTo(page, board, 8);
    await shot(page, "02-applications-board", { from: board, to: board });

    // 4 — the scored discovery inbox with one score breakdown expanded. Framed
    // from the top of the page so the "N in inbox" summary is in shot.
    await goto(page, "/jobs");
    await assertVisible(page.locator('[data-testid="job-row-rationale"]'), "an LLM rationale on /jobs");
    const firstBreakdown = page.locator('[data-testid="job-row-breakdown"]').first();
    await firstBreakdown.locator("summary").click();
    await assertVisible(firstBreakdown.locator("li"), "an expanded score breakdown");
    await shot(page, "04-discovery-inbox");

    // 7 — the reusable answer bank.
    await goto(page, "/answers");
    await assertVisible(page.locator('[data-testid="answers-row"]'), "reusable answers on /answers");
    await shot(page, "07-answer-bank");

    // 10 — the reply classification awaiting a decision.
    await goto(page, "/inbox");
    await assertVisible(page.locator('[data-testid="inbox-row"]'), "a pending suggestion on /inbox");
    await assertVisible(page.locator('[data-testid="inbox-row-evidence"]'), "the quoted evidence on /inbox");
    await shot(page, "10-inbox-suggestion");

    // 3 — the submitted application: the receipt its auto-apply attempt left,
    // and the event log underneath it. Framed from the auto-apply heading so
    // the shot is "what happened to this application", top to bottom.
    const wexford = await applicationIdFor(page, "Wexford Health");
    await goto(page, `/applications/${wexford}`);
    await assertVisible(page.locator('[data-testid="detail-timeline-item"]'), "the event timeline");
    await assertVisible(page.locator('[data-testid="site-attempt-row"]'),
      "the submitted attempt in the history");
    const sitePanel = page.locator('[data-testid="site-panel"]').first();
    await scrollTo(page, sitePanel, 8);
    await shot(page, "03-application-timeline", {
      from: sitePanel, to: page.locator('[data-testid="detail-timeline"]'),
    });

    // 5 — a freshly generated cover letter, with a provenance chip per fact it
    // cited. Generated rather than screenshotting the seeded one on purpose:
    // this is the actual output of the grounded-generation path (replayed from
    // the committed fixture), and it is the draft state — "AI-generated, not
    // yet approved" — that the panel exists to make reviewable.
    await goto(page, `/applications/${wexford}`);
    const coverLetter = page.locator('[data-testid="materials-section"]').filter({ hasText: "Cover letter" }).first();
    await coverLetter.getByRole("button", { name: "Generate with AI" }).click();
    await coverLetter.locator('[data-testid="badge-ai-draft"]').waitFor({ state: "visible", timeout: 60_000 });
    await assertVisible(coverLetter.locator('[data-testid="chip"]'),
      "provenance chips on the generated draft");
    await scrollTo(page, coverLetter, BANNER_CLEARANCE);
    await shot(page, "05-materials-provenance", {
      from: coverLetter, to: coverLetter.locator('[data-testid="materials-doc-actions"]'),
    });
  } finally {
    await context.close();
  }
}

/**
 * 8 + 9 — the auto-apply review screen and the confirm screen, driven against
 * the bundled demo-ats through the real Playwright driver in the web container.
 * Mutating: it creates a genuine attempt row, which is why `main` reseeds after.
 */
async function captureAutoApply(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
  const page = await context.newPage();
  try {
    const silvermark = await applicationIdFor(page, "Silvermark Labs");
    await goto(page, `/applications/${silvermark}`);
    await page.locator('[data-testid="site-url-input"]').fill(ATS_URL);
    await page.getByRole("button", { name: "Prepare" }).click();
    // The driver launches Chromium in the web container and reads the page.
    await page.locator('[data-testid="site-review"]').waitFor({ state: "visible", timeout: 120_000 });

    await settleBlockingFields(page);

    // Step 2 of the parsed form is where both things the plan asks for live:
    // the two 🔒 Sensitive eligibility questions CareerHQ refuses to fill, and
    // the consent attestation, now ticked by (this script standing in for) a
    // human. Framed from that step's heading so both are in one shot.
    // `fill` leaves a small textarea scrolled to the end of what was typed, so
    // the shot would show the tail of an answer with its first line cut off.
    await page.locator('[data-testid="site-field-textarea"]')
      .evaluateAll((els) => els.forEach((el) => { (el as HTMLTextAreaElement).scrollTop = 0; }));

    await assertVisible(page.locator('[data-testid~="site-field-consent"]'),
      "the consent row on the auto-apply review screen");
    await assertVisible(
      page.locator('[data-testid="site-review"]').locator('[data-testid="badge-sensitivity"]'),
      "a sensitive lock badge on the auto-apply review screen");
    const step2 = page.locator('[data-testid="site-step"]').nth(1);
    await scrollTo(page, step2, BANNER_CLEARANCE);
    await shot(page, "08-autoapply-review", { from: step2, to: step2 });

    await page.locator('[data-testid="site-review"]').getByRole("button", { name: "Preview" }).click();
    await page.locator('[data-testid="site-preview"]').waitFor({ state: "visible", timeout: 120_000 });
    const host = new URL(ATS_URL).hostname;
    await page.locator('[data-testid="site-retype-input"]').fill(host);
    await assertVisible(page.locator('[data-testid="site-preview-fields"]'), "the preview payload");
    const preview = page.locator('[data-testid="site-preview"]');
    await scrollTo(page, preview, BANNER_CLEARANCE);
    await shot(page, "09-preview-confirm", { from: preview, to: preview });
  } finally {
    await context.close();
  }
}

/**
 * What "Alex Demo" answers when the planner refuses to. The values are the
 * persona's, not arbitrary: the demo's own `authorization` fact says EU
 * citizen, no sponsorship required, and a screenshot that answered those two
 * the other way round would contradict the fact bank two panels above it.
 */
const USER_ANSWERS: ReadonlyArray<{ match: RegExp; value: string }> = [
  { match: /sponsorship/i, value: "no" },
  { match: /authorized to work/i, value: "yes" },
  { match: /linkedin/i, value: "https://www.linkedin.com/in/alex-demo" },
  {
    match: /why do you want to work/i,
    value: "I want to build the second version of a system rather than maintain the first. "
      + "Your posting describes greenfield TypeScript with PostgreSQL as the record of truth, "
      + "which is the shape of system I spent nine months migrating towards at Northwind Robotics.",
  },
];

function answerFor(label: string): string | null {
  return USER_ANSWERS.find((a) => a.match.test(label))?.value ?? null;
}

/**
 * Answers every field the planner left for a human, the way a human would.
 *
 * It is driven by the review screen's own `needs-you` rows rather than a fixed
 * field list, because that set is exactly the product's claim: the consent
 * attestation is never pre-ticked, the two sensitive eligibility questions are
 * never auto-filled, and a screening question with no matching saved answer is
 * left blank. A field this script cannot answer from {@link USER_ANSWERS} and
 * which offers "Skip / leave blank" is skipped — that is the honest action for
 * the voluntary self-identification block, which is optional by law and by
 * form.
 */
async function settleBlockingFields(page: Page): Promise<void> {
  for (let round = 0; round < 24; round += 1) {
    const rows = page.locator('[data-testid~="site-field-needs-you"]');
    if (await rows.count() === 0) return;
    const row = rows.first();
    const label = (await row.innerText()).split("\n")[0] ?? "";
    const wanted = answerFor(label);

    const checkbox = row.locator("input[type=checkbox]");
    const select = row.locator("select");
    const textarea = row.locator("textarea");
    const text = row.locator("input[type=text], input[type=email], input[type=tel], input[type=url]");
    const skip = row.getByRole("button", { name: "Skip / leave blank" });

    if (await checkbox.count() > 0) {
      await checkbox.first().check();
    } else if (wanted !== null && await select.count() > 0) {
      await select.first().selectOption(wanted);
    } else if (wanted !== null && await textarea.count() > 0) {
      await textarea.first().fill(wanted);
      await textarea.first().blur();
    } else if (wanted !== null && await text.count() > 0) {
      await text.first().fill(wanted);
      await text.first().blur();
    } else if (await skip.count() > 0) {
      await skip.first().click();
    } else {
      throw new Error(`a required field needs an answer this script does not have: ${label}`);
    }
    await page.waitForTimeout(600);
  }
  throw new Error("could not settle every field the review screen still needs");
}

/**
 * 6 — the NEEDS_FACTS block: generation refusing to write something the fact
 * bank cannot support.
 *
 * There is no way to stage this on the seeded workspace, and that is the point:
 * `selectFactsForGeneration` gives every experience/skill fact a baseline
 * score, so the demo persona always has something to ground in. So the capture
 * empties the fact bank first — through the UI's own Archive button, one real
 * server action per fact — and then asks for a cover letter. `main` reseeds
 * immediately after.
 */
async function captureNeedsFacts(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
  const page = await context.newPage();
  try {
    const kestrel = await applicationIdFor(page, "Kestrel Mobility");

    await goto(page, "/facts");
    for (let i = 0; i < 40; i += 1) {
      const archive = page.getByRole("button", { name: "Archive" });
      if (await archive.count() === 0) break;
      await archive.first().click();
      await page.waitForTimeout(400);
    }
    if (await page.getByRole("button", { name: "Archive" }).count() > 0) {
      throw new Error("the fact bank did not empty");
    }

    await goto(page, `/applications/${kestrel}`);
    const coverLetter = page.locator('[data-testid="materials-section"]').filter({ hasText: "Cover letter" }).first();
    await coverLetter.getByRole("button", { name: "Generate with AI" }).click();
    const block = coverLetter.locator('[data-testid="materials-needs-facts"]');
    await block.waitFor({ state: "visible", timeout: 60_000 });
    await scrollTo(page, coverLetter, BANNER_CLEARANCE);
    await shot(page, "06-needs-facts", { from: coverLetter, to: block });
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// The walkthrough
// ---------------------------------------------------------------------------

/**
 * Pause long enough for a viewer to read what just happened. Everything the
 * demo does is instant — AI generation is a fixture read, the ATS is on the
 * same Docker network — so without these the whole walkthrough is over in
 * twenty seconds and legible in none of them. The pace is the deliverable.
 */
const BEAT = 3_000;

/**
 * Records discovery → promote → generate a grounded cover letter → auto-apply
 * review → consent tick → preview → confirm, and then the receipt.
 *
 * The confirm is REFUSED: `SUBMISSIONS_LIVE_COMPANY_SITE` is false on the demo
 * and no visitor can flip it, so what the recording shows at that moment is the
 * env gate doing its job. The receipt it finishes on is the seeded Wexford
 * Health attempt, which went through the whole gated path when the workspace
 * was built.
 */
async function recordWalkthrough(browser: Browser): Promise<string> {
  const videoDir = path.join(MEDIA_DIR, ".video-raw");
  await rm(videoDir, { recursive: true, force: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    // 1× for the recording: the video is played at its natural size and a 2×
    // frame is four times the pixels to encode for no visible gain.
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: VIEWPORT },
  });
  const page = await context.newPage();
  try {
    // 0. Where the pipeline stands: the funnel and what is overdue.
    await goto(page, "/overview");
    await page.waitForTimeout(BEAT * 2);

    // 1. The scored discovery inbox, and what a score is made of.
    await goto(page, "/jobs");
    await page.waitForTimeout(BEAT);
    const breakdown = page.locator('[data-testid="job-row-breakdown"]').first();
    await breakdown.locator("summary").click();
    await page.waitForTimeout(BEAT * 2);
    await breakdown.locator("summary").click();
    await page.waitForTimeout(BEAT / 2);
    // Further down the ranking, a listing the re-rank flagged rather than hid.
    await scrollTo(page, page.locator('[data-testid="job-row-flags"]').first(), 220);
    await page.waitForTimeout(BEAT * 2);
    await page.evaluate(() => { window.scrollTo({ top: 0, behavior: "instant" }); });
    await page.waitForTimeout(BEAT / 2);

    // 2. Promote the top-ranked listing, then show where it landed. A promoted
    //    listing leaves the inbox, so the proof is the board, not the row: wait
    //    for the row to go, then let the new Discovered card be the payoff.
    const topRow = page.locator('[data-testid="job-row"]').first();
    const topTitle = (await topRow.locator('[data-testid="job-row-link"]').innerText()).split("\n")[0] ?? "";
    await topRow.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await topRow.getByRole("button", { name: "Promote" }).click();
    await page.locator('[data-testid="job-row-link"]', { hasText: topTitle }).first()
      .waitFor({ state: "detached", timeout: 30_000 });
    await page.waitForTimeout(BEAT);

    await goto(page, "/applications");
    await scrollTo(page, page.locator('[data-testid="board"]').first(), BANNER_CLEARANCE);
    await page.waitForTimeout(BEAT * 2);

    // 3. Generate a grounded cover letter — replayed from a committed fixture,
    //    which is why it is the Wexford Health application (see the header).
    const wexford = await applicationIdFor(page, "Wexford Health");
    await goto(page, `/applications/${wexford}`);
    const materials = page.locator('[data-testid="materials-section"]').filter({ hasText: "Cover letter" }).first();
    await scrollTo(page, materials, BANNER_CLEARANCE);
    await page.waitForTimeout(BEAT);
    await materials.getByRole("button", { name: "Generate with AI" }).click();
    await materials.locator('[data-testid="badge-ai-draft"]').waitFor({ state: "visible", timeout: 60_000 });
    await scrollTo(page, materials, BANNER_CLEARANCE);
    await page.waitForTimeout(BEAT * 3);
    // The chips: one per fact the draft is allowed to have used.
    await scrollTo(page, materials.locator('[data-testid="chip-list"]').first(), 420);
    await page.waitForTimeout(BEAT * 2);

    // 4. Auto-apply: read a real form, review every planned answer.
    const silvermark = await applicationIdFor(page, "Silvermark Labs");
    await goto(page, `/applications/${silvermark}`);
    await scrollTo(page, page.locator('[data-testid="site-panel"]'), BANNER_CLEARANCE);
    await page.waitForTimeout(BEAT);
    await page.locator('[data-testid="site-url-input"]').pressSequentially(ATS_URL, { delay: 25 });
    await page.waitForTimeout(BEAT);
    await page.getByRole("button", { name: "Prepare" }).click();
    await page.locator('[data-testid="site-review"]').waitFor({ state: "visible", timeout: 120_000 });
    await scrollTo(page, page.locator('[data-testid="site-review"]'), BANNER_CLEARANCE);
    await page.waitForTimeout(BEAT * 2);
    // Step by step, so the sources (Profile / Document / Saved answer) and the
    // two things CareerHQ refuses to fill are both legible.
    for (const step of [0, 1, 2]) {
      await scrollTo(page, page.locator('[data-testid="site-step"]').nth(step), BANNER_CLEARANCE);
      await page.waitForTimeout(BEAT * 1.5);
    }

    // 5. The consent tick, and every other field the planner left for a human.
    await settleBlockingFields(page);
    await scrollTo(page, page.locator('[data-testid~="site-field-consent"]'), 300);
    await page.waitForTimeout(BEAT * 2);

    // 6. Preview: the exact payload, its fingerprint, and a countdown.
    await page.locator('[data-testid="site-review"]').getByRole("button", { name: "Preview" }).click();
    await page.locator('[data-testid="site-preview"]').waitFor({ state: "visible", timeout: 120_000 });
    await scrollTo(page, page.locator('[data-testid="site-preview"]'), BANNER_CLEARANCE);
    await page.waitForTimeout(BEAT * 3);

    // 7. Retype the target host, then confirm — and be refused, because the
    //    hosted demo's live-submission gate is shut and no visitor can open it.
    await page.locator('[data-testid="site-retype-input"]').pressSequentially(new URL(ATS_URL).hostname, { delay: 120 });
    await page.waitForTimeout(BEAT);
    await page.getByRole("button", { name: "Confirm and submit" }).click();
    await page.locator('[data-testid="site-outcome"]').waitFor({ state: "visible", timeout: 120_000 });
    await scrollTo(page, page.locator('[data-testid="site-outcome"]'), BANNER_CLEARANCE);
    await page.waitForTimeout(BEAT * 3);

    // 8. What a submission that DID go through leaves behind: the seeded
    //    Wexford Health attempt, its receipt, and the event log it wrote.
    await goto(page, `/applications/${wexford}`);
    await scrollTo(page, page.locator('[data-testid="site-panel"]'), BANNER_CLEARANCE);
    await page.waitForTimeout(BEAT * 2);
    await scrollTo(page, page.locator('[data-testid="detail-timeline"]'), 260);
    await page.waitForTimeout(BEAT * 2);

    // 9. And the reply that came back, waiting for a decision.
    await goto(page, "/inbox");
    await page.waitForTimeout(BEAT * 3);
  } finally {
    await context.close();
  }

  const [raw] = (await readdir(videoDir)).filter((f) => f.endsWith(".webm"));
  if (!raw) throw new Error("playwright recorded no video");
  const webm = path.join(MEDIA_DIR, "walkthrough.webm");
  await rename(path.join(videoDir, raw), webm);
  await rm(videoDir, { recursive: true, force: true });
  return webm;
}

/** MP4 when ffmpeg is on PATH (it plays inline in more places), else the WebM. */
async function toMp4(webm: string): Promise<string | null> {
  const mp4 = webm.replace(/\.webm$/, ".mp4");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("ffmpeg", [
        "-y", "-i", webm,
        "-c:v", "libx264", "-preset", "slow", "-crf", "26",
        // yuv420p + even dimensions: what browsers and QuickTime will play.
        "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-movflags", "+faststart", "-an", mp4,
      ], { stdio: "ignore" });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
    });
    return mp4;
  } catch (err) {
    log(`ffmpeg unavailable (${err instanceof Error ? err.message : String(err)}) — keeping the WebM`);
    return null;
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await mkdir(MEDIA_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    if (ONLY.includes("shots")) {
      await reseed();
      await captureShots(browser);
      await captureAutoApply(browser);
      await captureNeedsFacts(browser);
    }
    if (ONLY.includes("video")) {
      await reseed();
      const webm = await recordWalkthrough(browser);
      const mp4 = await toMp4(webm);
      if (mp4) {
        await rm(webm, { force: true });
        const { size } = await stat(mp4);
        log(`recorded ${path.basename(mp4)} (${Math.round(size / 1024)} KB)`);
      } else {
        const { size } = await stat(webm);
        log(`recorded ${path.basename(webm)} (${Math.round(size / 1024)} KB)`);
      }
    }
  } finally {
    await browser.close();
  }
  // Leave the demo as the seed made it: this script archived the fact bank and
  // drove a real attempt, and the next visitor should not see the leftovers.
  await reseed();
  log(`done — ${MEDIA_DIR}`);
}

await main();
