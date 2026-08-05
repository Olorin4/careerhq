/**
 * The href sanitiser, re-exported from where the auto-apply target policy can
 * reach it.
 *
 * The implementation moved to `@careerhq/autoapply/policy` because
 * `refuseCaptureTarget` — which apps/web AND apps/worker both have to call —
 * uses it as its protocol layer, and dependency-cruiser (rightly) forbids the
 * worker importing from an app. Every UI import site keeps this short local
 * path, and the `/policy` subpath entry pulls in nothing but the URL rules, so
 * a client component rendering one anchor does not drag the form parsers into
 * its bundle.
 */
export { safeExternalHref } from "@careerhq/autoapply/policy";
