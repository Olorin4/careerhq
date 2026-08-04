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
