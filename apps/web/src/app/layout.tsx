import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "CareerHQ",
  description: "Job application tracker and workspace",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="app-nav">
          <a href="/applications">Applications</a>
          <a href="/facts">Facts</a>
          <a href="/cvs">CVs</a>
        </nav>
        <main className="app-main">{children}</main>
      </body>
    </html>
  );
}
