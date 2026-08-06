import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { loadConfig } from "@careerhq/config";
import { Sidebar } from "../components/sidebar.js";
import { DemoBanner } from "../components/demo-banner.js";
import {
  COLLAPSED_ATTR,
  DEMO_BANNER_TESTID,
  SIDEBAR_TOP_OFFSET_VAR,
  STORAGE_KEY,
} from "../components/sidebar-constants.js";
import { readSidebarCounts } from "../lib/sidebar-counts.js";
import "./tokens.css";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-sans" });

export const metadata = {
  title: "CareerHQ",
  description: "Job application tracker and workspace",
};

// The layout now reads loadConfig() (for demoMode) on every render. Several
// leaf pages already force dynamic rendering because DATABASE_URL isn't
// available at image-build time (see settings/email/page.tsx) — but the
// root layout wraps EVERY route, including ones Next would otherwise
// statically prerender at build time (e.g. /_not-found), so without this the
// build fails outside an environment that has DATABASE_URL set.
export const dynamic = "force-dynamic";

// Runs synchronously, before the browser paints anything below it —
// including `Sidebar`'s own SSR markup, which always renders expanded
// (there's no access to localStorage on the server). Without this, a
// visitor who previously collapsed the sidebar sees it flash from expanded
// to collapsed after the post-mount effect in `sidebar.tsx` runs. If the
// stored preference is "collapsed", this stamps `COLLAPSED_ATTR` on `<html>`
// so the CSS rule in `globals.css` can force the rail to its collapsed
// width immediately, matching first paint to the stored state. `sidebar.tsx`
// clears the attribute once it mounts and React's own render takes over.
const COLLAPSE_FLASH_GUARD_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(
  STORAGE_KEY,
)})==="true"){document.documentElement.setAttribute(${JSON.stringify(COLLAPSED_ATTR)},"true")}}catch(e){}`;

// Runs synchronously, positioned after the demo banner in source order so
// the banner (if `demoMode` rendered it) already exists in the DOM by the
// time this executes. `Sidebar` is also `position: sticky; top: 0` (see the
// `items-start` comment below) — without this, both it and the banner pin
// to viewport y=0 once scrolled, and the banner's `z-[100]` always wins the
// stacking order, silently covering the rail's wordmark and collapse toggle
// underneath it. Measures the banner's real rendered height (it can wrap to
// two lines on a narrow viewport) and writes it to `SIDEBAR_TOP_OFFSET_VAR`
// on `<html>`, which `sidebar.tsx` uses for its own `top` offset and height
// so the rail sits below the banner instead of under it. Runs unconditionally
// (not just when `demoMode` is on) so the non-demo case explicitly gets
// `0px` — no leftover gap from a previous value. `sidebar.tsx`'s own
// `ResizeObserver` keeps this in sync afterwards, e.g. if the banner
// wraps/unwraps on a window resize.
const SIDEBAR_TOP_OFFSET_SCRIPT = `try{var b=document.querySelector('[data-testid="${DEMO_BANNER_TESTID}"]');document.documentElement.style.setProperty(${JSON.stringify(
  SIDEBAR_TOP_OFFSET_VAR,
)},(b?b.getBoundingClientRect().height:0)+"px")}catch(e){}`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { demoMode } = loadConfig();

  // The rail's live counts (spec §Shell). The shell owns this read rather than
  // a page: the rail is rendered here, on every route, and a count shown only
  // on the page it counts would be pointless. `readSidebarCounts` never
  // throws — it returns `{}` if the database is unreachable — and `Sidebar`
  // omits every undefined or zero count, so the rail degrades to the
  // no-badges rendering rather than taking every route down with it.
  const counts = await readSidebarCounts();

  return (
    <html lang="en" className={inter.variable}>
      <body className="bg-canvas font-sans text-ink">
        <script dangerouslySetInnerHTML={{ __html: COLLAPSE_FLASH_GUARD_SCRIPT }} />
        {demoMode && <DemoBanner />}
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_TOP_OFFSET_SCRIPT }} />
        {/*
          `items-start` (not the flex default `stretch`) matters here: it stops
          `main` being stretched to match its sibling, which would make its
          measured height indistinguishable from the viewport-height fallback
          `scripts/capture-demo-media.ts`'s `shot()` substitutes when
          `app-main` is missing entirely (see task-4-report.md). `Sidebar`
          instead makes itself `sticky top-[var(--sidebar-top-offset,0px)]`,
          so the rail stays pinned below the demo banner (when present — see
          `SIDEBAR_TOP_OFFSET_SCRIPT` above) for the full scroll of a page
          taller than one screen, and settles flush with the bottom once the
          page's own bottom comes into view, without ever influencing `main`'s
          own height.
        */}
        <div className="flex items-start">
          <Sidebar counts={counts} />
          {/*
            No `overflow-x` here, deliberately. A computed `overflow-x` other
            than `visible`/`clip` forces `overflow-y` to `auto` as well (CSS
            Overflow §3), which made this element the nearest scrollport for
            every descendant — including the detail page's `lg:sticky` rail
            (`applications/[id]/page.tsx`). `main` is never itself scrolled
            (its height is content-driven, see `items-start` above), so that
            rail's sticky constraint was trivially satisfied and it laid out
            as static, scrolling off the top of the window with the page. The
            one place that genuinely needs a horizontal scroller carries its
            own (`applications/board.tsx`); a page that needs another should
            do the same rather than putting it back here.

            `min-w-0` is what the removed `overflow-x` was doing for the
            layout, without the side effect: a flex item's automatic minimum
            size is its content's, so `flex-1` alone lets `main` grow WIDER
            than the flex line to fit the board's 1,716px grid — which moved
            the horizontal scrollbar from the board onto the document.
            `overflow-x: auto` used to force that minimum to zero as a
            side effect of being a scroll container. `min-w-0` says it
            directly, so the board stays the thing that scrolls sideways and
            `main` is not a scrollport.
          */}
          <main className="min-w-0 flex-1 p-6" data-testid="app-main">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
