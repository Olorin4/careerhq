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

export default function RootLayout({ children }: { children: ReactNode }) {
  const { demoMode } = loadConfig();

  // The shell fetches nothing itself — `counts` is empty until Task 5 wires a
  // page's own data in. `Sidebar` already omits every undefined/zero count,
  // so an empty object here renders the same destinations with no badges,
  // not a broken one.
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
          <Sidebar counts={{}} />
          <main className="flex-1 overflow-x-auto p-6" data-testid="app-main">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
