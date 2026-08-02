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
};

export default nextConfig;
