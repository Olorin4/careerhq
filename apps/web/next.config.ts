import type { NextConfig } from "next";

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
