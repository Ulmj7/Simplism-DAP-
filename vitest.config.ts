// T010. Vitest 5 replaced the separate `vitest.workspace.ts` file with `test.projects`,
// so the workspace definition lives here. Workspace packages resolve to source through
// the "@dap/source" export condition (same condition as tsconfig.base.json).
import { defineConfig } from "vitest/config";

const shared = {
  resolve: { conditions: ["@dap/source"] },
  ssr: { resolve: { conditions: ["@dap/source"] } },
} as const;

export default defineConfig({
  test: {
    // Early phases have no tests for some projects yet; an empty project must not fail CI.
    passWithNoTests: true,
    projects: [
      {
        ...shared,
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
          exclude: ["**/state/conformance/**", "packages/walkthrough/src/dom/**", "apps/reference-web/src/**", "**/node_modules/**", "**/dist/**"],
        },
      },
      {
        ...shared,
        test: {
          name: "conformance",
          include: ["packages/*/src/state/conformance/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**"],
          // These files share one PostgreSQL database; the T118 purge deletes expired rows database-wide,
          // which would remove rows that fake-clock files in other workers still rely on.
          fileParallelism: false,
        },
      },
      {
        ...shared,
        test: { name: "arch", include: ["tests/architecture/**/*.test.ts"], testTimeout: 60_000 },
      },
      {
        ...shared,
        test: { name: "security", include: ["tests/security/**/*.test.ts"] },
      },
      {
        // Feature 002: the browser adapter and the reference web app run under jsdom.
        ...shared,
        test: { name: "dom", environment: "jsdom", include: ["packages/walkthrough/src/dom/**/*.test.ts", "apps/reference-web/src/**/*.test.ts"], exclude: ["**/node_modules/**", "**/dist/**"] },
      },
      {
        ...shared,
        test: { name: "integration", include: ["tests/integration/**/*.test.ts"], testTimeout: 30_000 },
      },
    ],
  },
});
