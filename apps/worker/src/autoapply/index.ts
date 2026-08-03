// The package surface `apps/worker` exposes to the rest of the workspace for
// driving a browser (Task 8's Playwright driver). Anything outside this app
// that needs `openSession`/`capturePage`/`fillAndSubmit` — today that is
// `apps/web`'s interactive review-screen driver — reaches them through this
// module's package export (`@careerhq/worker/autoapply`, see
// apps/worker/package.json's "exports"), never a relative import that
// crosses the app boundary. `.dependency-cruiser.cjs`'s
// `no-relative-cross-app-*` rules enforce that the relative form is
// unavailable, so this is the only door.
export {
  capturePage,
  DriverError,
  fillAndSubmit,
  openSession,
  type BrowserSession,
  type DriverDeps,
  type DriverErrorKind,
  type FillAndSubmitArgs,
  type SubmitResult,
} from "./driver.js";
