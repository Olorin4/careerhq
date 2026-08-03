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
      comment: "ingest, ai, and email are consumed by the worker/apps but must not reach into db or apps themselves",
      severity: "error",
      from: { path: "^packages/(ingest|ai|email)" },
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
      severity: "error",
      from: { path: "^packages" },
      to: { path: "^apps" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.depcruise.json" },
  },
};
