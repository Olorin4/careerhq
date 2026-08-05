import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { loadConfig } from "@careerhq/config";
import { Sidebar } from "../components/sidebar.js";
import { DemoBanner } from "../components/demo-banner.js";
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

export default function RootLayout({ children }: { children: ReactNode }) {
  const { demoMode } = loadConfig();

  // The shell fetches nothing itself — `counts` is empty until Task 5 wires a
  // page's own data in. `Sidebar` already omits every undefined/zero count,
  // so an empty object here renders the same destinations with no badges,
  // not a broken one.
  return (
    <html lang="en" className={inter.variable}>
      <body className="bg-canvas font-sans text-ink">
        {demoMode && <DemoBanner />}
        {/*
          `items-start` (not the flex default `stretch`) matters here: `Sidebar`
          sets its own `min-h-screen` so the rail always reads as a persistent
          shell even on a short page, but `main` must NOT be stretched to match
          it. `scripts/capture-demo-media.ts`'s `shot()` reads `app-main`'s
          `getBoundingClientRect().bottom` to find where a page's content
          actually ends — a stretched `main` would report ~900px on every
          short page (the viewport height, not the content height), silently
          reframing the gallery to the same number `shot()` would have picked
          had the `app-main` testid gone missing entirely (see layout.tsx's
          git history / task-4-report.md for how this was caught).
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
