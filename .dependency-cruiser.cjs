module.exports = {
  forbidden: [
    {
      name: "core-purity",
      comment: "core may import only contracts (architecture §2)",
      severity: "error",
      from: { path: "^packages/core" },
      to: { path: "^(packages/(db|ai|ingest|email|autoapply|config)|apps)" },
    },
    {
      name: "ingest-and-ai-purity",
      comment:
        "ingest, ai, email, and autoapply are consumed by the worker/apps but must not reach into db or apps " +
        "themselves. The ONLY carve-out is autoapply's own *.test.ts fixtures and fixture-generation scripts, " +
        "which import the pure @careerhq/demo-ats page builders as a devDependency, never db — ingest/ai/email " +
        "get no exemption and stay fully fenced.",
      severity: "error",
      from: { path: "^packages/(ingest|ai|email|autoapply)", pathNot: "^packages/autoapply/(.*\\.test\\.ts|scripts/.*)$" },
      to: { path: "^(packages/db|apps)" },
    },
    {
      name: "contracts-zero-deps",
      severity: "error",
      from: { path: "^packages/contracts" },
      to: { path: "^(packages/(?!contracts)|apps)" },
    },
    {
      name: "packages-not-into-apps",
      comment:
        "production package code must never import from apps. The ONLY carve-out is autoapply's own *.test.ts " +
        "fixtures and scripts/write-fixture.ts, which build fixtures from the pure @careerhq/demo-ats page " +
        "builders — every other package stays fully fenced from apps.",
      severity: "error",
      from: { path: "^packages", pathNot: "^packages/autoapply/(.*\\.test\\.ts|scripts/.*)$" },
      to: { path: "^apps" },
    },
    {
      name: "no-relative-cross-app-web-to-worker",
      comment:
        "apps/web may depend on apps/worker only through its package export surface (a workspace:* " +
        "dependency resolving @careerhq/worker's own \"exports\", e.g. @careerhq/worker/autoapply) — " +
        "never a relative import (`../../../worker/...`) that reaches across the app boundary directly " +
        "into the other app's src tree. Task 12 shipped the relative form; Task 13 replaced it with the " +
        "package seam and added this rule so it cannot come back.",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { path: "^apps/worker/", dependencyTypes: ["local"] },
    },
    {
      name: "no-relative-cross-app-worker-to-web",
      comment: "Same rule, the other direction: apps/worker must never relative-import into apps/web.",
      severity: "error",
      from: { path: "^apps/worker/" },
      to: { path: "^apps/web/", dependencyTypes: ["local"] },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.depcruise.json" },
  },
};
