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
        "themselves (autoapply's own *.test.ts fixtures and fixture-generation scripts are exempt — they import " +
        "the pure @careerhq/demo-ats page builders as a devDependency, never db)",
      severity: "error",
      from: { path: "^packages/(ingest|ai|email|autoapply)", pathNot: "(\\.test\\.ts$|/scripts/)" },
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
        "production package code must never import from apps; *.test.ts fixtures and fixture-generation " +
        "scripts are exempt (e.g. autoapply's tests and scripts/write-fixture.ts build fixtures from the pure " +
        "@careerhq/demo-ats page builders)",
      severity: "error",
      from: { path: "^packages", pathNot: "(\\.test\\.ts$|/scripts/)" },
      to: { path: "^apps" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.depcruise.json" },
  },
};
