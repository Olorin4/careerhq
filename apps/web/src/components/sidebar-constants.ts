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
