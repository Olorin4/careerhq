import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// Next only auto-loads .env files from the app directory (apps/web), but the
// repo keeps a single .env at the root. next.config.ts is evaluated before the
// server starts and its process.env is inherited by everything Next spawns, so
// this is the earliest place the whole app can see the root file. Variables
// already exported in the shell win over the file (Node's own rule).
const envFile = path.resolve(process.cwd(), "../../.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const nextConfig: NextConfig = {
  // The workspace's TS files import local modules with a ".js" extension
  // (NodeNext/verbatimModuleSyntax convention: `import { x } from "./foo.js"`
  // resolving to `./foo.ts`). Next's webpack resolver doesn't map that
  // extension to TypeScript sources unless told to.
  experimental: {
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js"],
    },
    serverActions: {
      // The application's own CV size caps must be the ones that decide.
      //
      // Next 15 rejects any server-action request body over 1 MB by default,
      // with a 413 raised BEFORE the action function runs — so `uploadCvAction`
      // never saw it, `demoRateLimit` and `reserveCvUpload` were never reached,
      // and neither `DEMO_MAX_CV_BYTES` (2 MB) nor `MAX_CV_BYTES` (5 MB) could
      // ever fire. A visitor uploading a routine 1.5 MB designed CV got the
      // whole page replaced by "Application error: a server-side exception has
      // occurred", which is exactly the overlay the `useActionState` rewrite
      // exists to eliminate, and SECURITY.md published a 2 MB bound that no
      // code enforced.
      //
      // 6 MB, deliberately ABOVE `MAX_CV_BYTES` (5 MB) plus multipart overhead,
      // so every refusal is one this app can phrase: the demo cap refuses at
      // 2 MB and the global cap at 5 MB, both as a sentence rendered in the
      // form. Raising either cap means raising this first — the framework bound
      // has to stay the outer one, or the inner ones go quiet again.
      //
      // It applies to every server action, not just this one, so it is also the
      // bound on the free-text row writes; those are all small, and the rate
      // limiter is what governs them.
      bodySizeLimit: "6mb",
    },
  },
  // `site-driver.ts`'s server actions reach `@careerhq/worker/autoapply`,
  // which pulls in `playwright`/`playwright-core` — a Node-only package Next's
  // webpack bundler should not try to bundle at all (it launches a real
  // browser process; there is nothing here for a bundler to usefully inline).
  // `serverExternalPackages` handles that for the ordinary server-render
  // compilation, but Next.js compiles Server Actions through a separate
  // "flight action" pass that does NOT consult it, so the action layer used to
  // get its own bundled copy of playwright-core's internals. That copy is not
  // merely wasteful, it is broken: `playwright-core/src/package.ts` locates its
  // own `package.json` relative to `__dirname`, and inside the bundle
  // `__dirname` is `.next/server/app/(dashboard)/applications`, so importing
  // it threw `MODULE_NOT_FOUND` at module init and EVERY server action on
  // `/applications/[id]` returned HTTP 500 (the P6 task-3 review's advisory A).
  // The `webpack()` externals below are the one config surface both
  // compilations respect: they keep `require("playwright")` a real runtime
  // require against node_modules, where the package's own `__dirname` is
  // correct. Externalising the whole package also means webpack never walks
  // into playwright-core's optional BiDi imports (`chromium-bidi/...`, not
  // installed — this driver only ever launches Chromium over CDP), so those no
  // longer need externalising one module at a time.
  serverExternalPackages: ["playwright", "playwright-core"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      const nodeOnlyPackages = new Set(["playwright", "playwright-core"]);
      // A function external rather than a bare string: it also catches deep
      // subpath requests (`playwright-core/lib/...`) that a string would miss.
      const externalizeNodeOnly = (
        { request }: { request?: string },
        callback: (err?: Error | null, result?: string) => void,
      ): void => {
        const pkg = request?.split("/").slice(0, request.startsWith("@") ? 2 : 1).join("/");
        if (request && pkg && nodeOnlyPackages.has(pkg)) return callback(null, `commonjs ${request}`);
        callback();
      };
      config.externals = Array.isArray(config.externals)
        ? [...config.externals, externalizeNodeOnly]
        : [config.externals, externalizeNodeOnly].filter(Boolean);
    }
    return config;
  },
};

export default nextConfig;
