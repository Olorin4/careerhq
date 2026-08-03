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
  // "flight action" pass that does not consult it, and still tries to
  // statically bundle `playwright-core`'s internals — including two
  // BiDi-protocol modules (`chromium-bidi/...`) that are not installed at
  // all, because they are optional and this driver only ever launches
  // Chromium over CDP, never BiDi. The `webpack()` externals below are the
  // one config surface both compilations respect.
  serverExternalPackages: ["playwright", "playwright-core"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      const missingOptionalBidiModules = [
        "chromium-bidi/lib/cjs/bidiMapper/BidiMapper",
        "chromium-bidi/lib/cjs/cdp/CdpConnection",
      ];
      config.externals = Array.isArray(config.externals)
        ? [...config.externals, ...missingOptionalBidiModules]
        : [config.externals, ...missingOptionalBidiModules].filter(Boolean);
    }
    return config;
  },
};

export default nextConfig;
