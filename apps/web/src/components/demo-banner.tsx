import type { JSX } from "react";

// The source repository. This is the one place in the repo that wants the repo:
// `INGEST_USER_AGENT` and the AI client's `HTTP-Referer` both point at the
// hosted demo instead, because a board operator or a model provider wanting to
// know who is calling is better served by a running page than by a README.
const REPO_URL = "https://github.com/Olorin4/careerhq";

/**
 * Rendered only when `demoMode` is on (see `layout.tsx`). The copy and
 * `role="status"` are reviewed and verbatim — they are how a visitor learns
 * that sending is disabled and nothing leaves this server. `bg-info`/
 * `text-white` (6.17:1) is the token-palette replacement for the banner's
 * previous literal `#4b3f99` background — same solid, attention-grabbing
 * strip, no raw hex.
 */
export function DemoBanner(): JSX.Element {
  return (
    <div
      className="sticky top-0 z-[100] flex flex-wrap items-center justify-center gap-x-4 gap-y-2 bg-info px-4 py-2 text-center text-sm text-white"
      data-testid="demo-banner"
      role="status"
    >
      <span>Demo — data resets every 6 hours. Sending is disabled; nothing leaves this server.</span>
      <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap font-semibold text-white">
        View the source on GitHub
      </a>
    </div>
  );
}
