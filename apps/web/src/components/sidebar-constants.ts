/**
 * Shared between `sidebar.tsx` (a `"use client"` component) and the root
 * server-rendered `layout.tsx`. These must live in a plain module: a Server
 * Component that imports a named export from a `"use client"` file does not
 * get the real value back — Next's RSC compiler turns every export of a
 * client module into an opaque client reference (usable only as a JSX
 * element), not a plain value. Importing `STORAGE_KEY` directly from
 * `sidebar.tsx` into `layout.tsx` silently produced `undefined`.
 */

/** localStorage key the collapsed/expanded preference is persisted under. */
export const STORAGE_KEY = "careerhq.sidebar.collapsed";

/**
 * Stamped onto `<html>` by `layout.tsx`'s pre-hydration script when the
 * stored preference is "collapsed", so a CSS rule (see `globals.css`) can
 * force the rail's first-paint width to match before React ever runs.
 * Cleared by `sidebar.tsx` once it mounts and React's own render takes over.
 */
export const COLLAPSED_ATTR = "data-sidebar-collapsed";

/**
 * CSS custom property, set on `<html>`, holding the demo banner's current
 * rendered height in pixels (or `0px` when `demoMode` is off / the banner
 * isn't present). `Sidebar` reads it for both its sticky `top` offset and
 * its height, so the rail sits *below* the banner — which is also
 * `position: sticky; top: 0` — instead of both pinning to viewport y=0 and
 * fighting over stacking order. Set once, synchronously, by `layout.tsx`'s
 * pre-hydration script (so first paint is already correct and nothing ever
 * needs to "catch up"), and kept in sync afterwards by a `ResizeObserver` in
 * `sidebar.tsx` (the banner's `flex-wrap` can grow it to two lines on a
 * narrow viewport).
 */
export const SIDEBAR_TOP_OFFSET_VAR = "--sidebar-top-offset";

/** `data-testid` the demo banner is rendered with (see `demo-banner.tsx`). */
export const DEMO_BANNER_TESTID = "demo-banner";
