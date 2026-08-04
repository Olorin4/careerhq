import type { ReactNode } from "react";
import { loadConfig } from "@careerhq/config";
import "./globals.css";

export const metadata = {
  title: "CareerHQ",
  description: "Job application tracker and workspace",
};

// The placeholder used elsewhere in the repo (INGEST_USER_AGENT, the AI
// client's HTTP-Referer) for "a link back to this project" — kept in sync
// with those rather than inventing a second one.
const REPO_URL = "https://github.com/careerhq";

// The layout now reads loadConfig() (for demoMode) on every render. Several
// leaf pages already force dynamic rendering because DATABASE_URL isn't
// available at image-build time (see settings/email/page.tsx) — but the
// root layout wraps EVERY route, including ones Next would otherwise
// statically prerender at build time (e.g. /_not-found), so without this the
// build fails outside an environment that has DATABASE_URL set.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  const { demoMode } = loadConfig();

  return (
    <html lang="en">
      <body>
        {demoMode && (
          <div className="demo-banner" role="status">
            <span>
              Demo — data resets every 6 hours. Sending is disabled; nothing leaves this server.
            </span>
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
              View the source on GitHub
            </a>
          </div>
        )}
        <nav className="app-nav">
          <a href="/overview">Overview</a>
          <a href="/jobs">Discovery</a>
          <a href="/applications">Applications</a>
          <a href="/inbox">Mail</a>
          <a href="/facts">Facts</a>
          <a href="/answers">Answers</a>
          <a href="/cvs">CVs</a>
          <a href="/settings">Settings</a>
        </nav>
        <main className="app-main">{children}</main>
      </body>
    </html>
  );
}
