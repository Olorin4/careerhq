"use client";

import { useEffect, useState, type JSX } from "react";
import { usePathname } from "next/navigation";
import { Badge } from "./badge.js";
import {
  COLLAPSED_ATTR,
  DEMO_BANNER_TESTID,
  SIDEBAR_TOP_OFFSET_VAR,
  STORAGE_KEY,
  type SidebarCounts,
} from "./sidebar-constants.js";

export type { SidebarCounts };

const DESTINATIONS: ReadonlyArray<{
  href: string;
  label: string;
  countKey?: keyof SidebarCounts;
}> = [
  { href: "/overview", label: "Overview", countKey: "due" },
  { href: "/jobs", label: "Discovery", countKey: "discovery" },
  { href: "/applications", label: "Applications" },
  { href: "/inbox", label: "Mail", countKey: "mail" },
  { href: "/facts", label: "Facts" },
  { href: "/answers", label: "Answers" },
  { href: "/cvs", label: "CVs" },
  { href: "/settings", label: "Settings" },
];

const LINK_BASE =
  "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-white no-underline " +
  "transition-colors hover:bg-anchor-soft " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

/**
 * The application shell's left rail. `bg-anchor`/`bg-anchor-soft` is a dark
 * pair (`--anchor` #16211f measures 1.03:1 against `--ink`), so every
 * interactive element here pins its own focus ring to white
 * (16.52:1 against `--anchor`) rather than the `outline-ink` that `Button`
 * uses for controls on the light canvas/surface pair — `outline-ink` on this
 * background would be the same invisible-ring defect Task 3 found and fixed
 * on `primary`/`irreversible` buttons.
 */
export function Sidebar({ counts }: { counts: SidebarCounts }): JSX.Element {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // Server and first client render both default to expanded (no access to
  // localStorage during SSR), so there is nothing to reconcile at hydration —
  // React's own output never disagrees with the server's. The visible first
  // *paint*, though, is handled separately: `layout.tsx` inlines a blocking
  // script that runs before this component's JS even loads, and (if the
  // stored preference is "collapsed") stamps `COLLAPSED_ATTR` on `<html>` so
  // a plain CSS rule can force the rail to its collapsed width immediately.
  // That means by the time this effect runs, the visible width may already
  // be correct; this effect brings React's *state* into agreement (so labels,
  // aria-pressed, etc. also match) and then removes the attribute, handing
  // control of the width back to React's own class output so a later
  // in-session toggle isn't fought by a stale CSS override.
  // Reads/writes are both defensive: storage can be unavailable (private
  // browsing, a disabled/broken implementation) and collapse-state persistence
  // is a nice-to-have, not something worth crashing the shell over.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "true") {
        setCollapsed(true);
      }
    } catch {
      // Storage unavailable — stay expanded.
    }
    try {
      document.documentElement.removeAttribute(COLLAPSED_ATTR);
    } catch {
      // Non-fatal — worst case a later toggle briefly fights a stale
      // attribute, not a crash.
    }
  }, []);

  // Keeps `SIDEBAR_TOP_OFFSET_VAR` in sync with the demo banner's actual
  // rendered height for the lifetime of the page — `layout.tsx`'s
  // pre-hydration script sets it once, synchronously, so first paint is
  // already correct (see that script's own comment for why both this
  // element and the banner being `position: sticky; top: 0` would otherwise
  // collide), but the banner's `flex-wrap` can grow it to two lines if the
  // user resizes a narrow window afterwards, and this keeps the rail's
  // offset matched to that. No-op (and no `ResizeObserver` ever
  // constructed) when the banner isn't in the DOM at all — `demoMode` off,
  // or this component under test without one rendered.
  useEffect(() => {
    const banner = document.querySelector(`[data-testid="${DEMO_BANNER_TESTID}"]`);
    if (!banner || typeof ResizeObserver === "undefined") {
      return;
    }
    const sync = (): void => {
      document.documentElement.style.setProperty(SIDEBAR_TOP_OFFSET_VAR, `${banner.getBoundingClientRect().height}px`);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(banner);
    return () => observer.disconnect();
  }, []);

  function toggle(): void {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // Storage unavailable — the toggle still works for this render.
      }
      return next;
    });
  }

  // `var(--sidebar-top-offset,0px)` is written as a literal here (not
  // interpolated from `SIDEBAR_TOP_OFFSET_VAR`) because Tailwind's arbitrary
  // values are picked up by statically scanning source text for class
  // strings — a template-interpolated property name wouldn't be found. Keep
  // this in sync with the constant by hand if it ever changes.
  return (
    <aside
      className={`sticky top-[var(--sidebar-top-offset,0px)] flex h-[calc(100vh-var(--sidebar-top-offset,0px))] shrink-0 flex-col overflow-y-auto bg-anchor transition-[width] ${collapsed ? "w-16" : "w-64"}`}
      data-testid="sidebar"
    >
      <div className={`flex items-center px-3 py-4 ${collapsed ? "justify-center" : "justify-between"}`}>
        {!collapsed && <span className="px-1 text-sm font-semibold tracking-wide text-white">CareerHQ</span>}
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={collapsed}
          className="rounded-md p-1.5 text-white transition-colors hover:bg-anchor-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          <span aria-hidden="true">{collapsed ? "»" : "«"}</span>
        </button>
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-2 pb-4" aria-label="Primary">
        {DESTINATIONS.map(({ href, label, countKey }) => {
          const active = pathname === href || (pathname?.startsWith(`${href}/`) ?? false);
          const count = countKey ? counts[countKey] : undefined;
          const showBadge = !collapsed && typeof count === "number" && count > 0;
          return (
            <a key={href} href={href} className={`${LINK_BASE} ${active ? "bg-anchor-soft" : ""}`}>
              <span className={collapsed ? "sr-only" : "flex-1"}>{label}</span>
              {collapsed && (
                <span aria-hidden="true" className="flex-1 text-center">
                  {label.charAt(0)}
                </span>
              )}
              {showBadge && <Badge tone="neutral">{count}</Badge>}
            </a>
          );
        })}
      </nav>
    </aside>
  );
}
