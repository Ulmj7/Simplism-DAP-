/**
 * Package-boundary rules (T009). Allowed edges:
 *
 *   contracts            -> external libraries only
 *   ai, actions, security -> contracts
 *   testkit              -> contracts, security, ai
 *   apps/reference-host  -> all packages (composition root)
 *   packages/walkthrough -> nothing (leaf)
 *
 * Everything else is forbidden. Workspace packages resolve to their real paths
 * (packages/*) through the "@dap/source" export condition, so the rules are path-based.
 */
const forbid = (name, fromPath, toPath, comment) => ({
  name,
  comment,
  severity: "error",
  from: { path: fromPath },
  to: { path: toPath },
});

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    forbid("browser-runtime-leaf", "^packages/browser-runtime/", "^(packages/(?!browser-runtime/)|apps/)",
      "Browser infrastructure cannot depend on DAP domain packages."),
    forbid("browser-runtime-only-in-host", "^packages/(?!browser-runtime/)", "^packages/browser-runtime/",
      "The Node browser adapter is available only to trusted host composition and spike tooling."),
    forbid("browser-runtime-only-in-studio", "^apps/reference-host/(src|dist)/(?!studio/)", "^packages/browser-runtime/",
      "Only reference-host Studio owns browser sessions."),
    forbid("browser-vendor-no-imports", "^(packages|apps)/", "^vendor/agent-browser/",
      "The adapter invokes the native executable without importing vendor modules."),
    forbid("ai-not-to-security-or-actions", "^packages/ai/", "^packages/(security|actions)/",
      "The AI layer must not reach the Gateway internals or any executor (ATK-ARCH-01)."),
    forbid("actions-not-to-ai-or-security", "^packages/actions/", "^packages/(ai|security)/",
      "Executors depend on contracts only."),
    forbid("security-not-to-ai-or-actions", "^packages/security/", "^packages/(ai|actions)/",
      "The Gateway depends on contracts only."),
    forbid("contracts-leaf", "^packages/contracts/", "^(packages/(ai|actions|security|testkit)|apps)/",
      "contracts may depend on external libraries only."),
    forbid("testkit-allowed-edges", "^packages/testkit/", "^(packages/actions|apps)/",
      "testkit may depend on contracts, security, and ai only."),
    forbid("production-not-to-testkit", "^(packages/(contracts|ai|actions|security|walkthrough)|apps)/", "^packages/testkit/",
      "No production package may import test infrastructure."),
    forbid("walkthrough-leaf", "^packages/walkthrough/", "^(packages/(contracts|ai|actions|security|testkit)|apps)/",
      "The walkthrough runtime is a leaf: it imports no other workspace package (Feature 002), so the UI layer can never reach an executor."),
    forbid("walkthrough-not-imported-by-trusted-packages", "^packages/(contracts|ai|actions|security|testkit)/", "^packages/walkthrough/",
      "The Feature 001 packages must never depend on the walkthrough runtime."),
    forbid("nothing-imports-apps", "^packages/", "^apps/",
      "Apps are composition roots; nothing imports them."),
    {
      name: "no-deep-imports-into-contracts",
      severity: "error",
      comment:
        "Outside packages/contracts, only the two DECLARED entry points are reachable: the package root " +
        "(packages/contracts/src/index.ts) and the mint subpath (packages/contracts/src/mint/index.ts). " +
        "Deep imports into contracts' src/dist (e.g. execution-runtime, grant-registry, or the mint tree's " +
        "other files) are forbidden, so registerGrant/grantRecord-style internals stay behind the mint " +
        "boundary (ATK-ARCH-05). Applies to static, DYNAMIC, and compiled (dist) imports alike. The mint " +
        "entry itself is governed by the dedicated mint-entry-restricted rule (trusted minters may use it).",
      from: { pathNot: "^packages/contracts/" },
      to: { path: "^packages/contracts/(src|dist)/", pathNot: "^packages/contracts/src/(index|mint/index)\\.ts$" },
    },
    {
      name: "mint-entry-restricted",
      severity: "error",
      comment:
        "The mint entry (@dap/contracts/mint -> packages/contracts/src/mint/index.ts) is the ONLY way in " +
        "for the trusted minters (security, testkit). Everything outside security/testkit/contracts " +
        "(ai, actions, and the apps) must not reach it, for static OR dynamic imports (ATK-ARCH-05).",
      from: { path: "^(packages/(ai|actions)|apps)/" },
      to: { path: "^packages/contracts/src/mint/index\\.ts$" },
    },
    {
      name: "no-runtime-module-loaders",
      severity: "error",
      comment: "Runtime packages use explicit ESM imports; node:module/createRequire can hide edges from the graph.",
      from: { path: "^(packages|apps)/" },
      to: { path: "^(node:)?module$" },
    },
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies make the trust layering unverifiable.",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    // dist is NOT excluded: compiled targets must still appear as dependency EDGES (leaf nodes) so
    // no-deep-imports-into-contracts can fire on dist targets. We simply don't crawl INTO dist or
    // node_modules (doNotFollow), and we scan only the src trees as roots.
    doNotFollow: { path: "node_modules|(^|/)dist/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["@dap/source", "import", "node", "default"],
      mainFields: ["module", "main", "types"],
    },
    exclude: { path: "(^|/)(coverage|node_modules)/" },
  },
};
