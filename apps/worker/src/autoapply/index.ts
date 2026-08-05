// The package surface `apps/worker` exposes to the rest of the workspace for
// driving a browser (Task 8's Playwright driver). Anything outside this app
// that needs `openSession`/`capturePage`/`fillAndSubmit` — today that is
// `apps/web`'s interactive review-screen driver — reaches them through this
// module's package export (`@careerhq/worker/autoapply`, see
// apps/worker/package.json's "exports"), never a relative import that
// crosses the app boundary. `.dependency-cruiser.cjs`'s
// `no-relative-cross-app-*` rules enforce that the relative form is
// unavailable, so this is the only door.
//
// `./browser-limit.js` rides along because the global one-browser-at-a-time cap
// (spec P6 §3) is only global if every process that launches a browser applies
// the same configured number — and apps/web launches its own. `apps/web` also
// takes a slot DIRECTLY (`acquireBrowserSlot`), for a reservation that spans a
// whole confirm rather than a single session — see `siteBrowserReservation`.
//
// Deliberately narrow: `BrowserBusyError` and `withBrowserSlot` were on this
// surface and nothing outside this app used either (apps/web recognises the
// busy failure structurally, by `name`, precisely so the browser-free
// orchestrator never imports this graph). Unused exports on a cross-app seam
// read as sanctioned dependencies that do not exist.
export {
  acquireBrowserSlot,
  configureBrowserLimit,
  type BrowserSlot,
} from "./browser-limit.js";
export {
  capturePage,
  DriverError,
  fillAndSubmit,
  openSession,
  type BrowserSession,
  type DriverDeps,
  type DriverErrorKind,
  type FillAndSubmitArgs,
  type OpenSessionOptions,
  type SubmitResult,
} from "./driver.js";
