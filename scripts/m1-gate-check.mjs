import { fileURLToPath } from "node:url";

// The checks behind `npm run test:m1-gate`, kept separate so tests/architecture/m1-gate.test.ts can prove each one able to fail.
// Input: the JSON report of one vitest run (arch + security + conformance + integration). Output: a list of problems; empty means pass.

/** Suites that must exist, be non-empty, pass and have no skipped test. One or more per T071 category (see m1-gate.mjs). */
export const REQUIRED_SUITES = Object.freeze([
  "apps/reference-host/src/startup.test.ts", "packages/security/src/state/postgres/pool.test.ts",
  "tests/architecture/graph.test.ts", "tests/architecture/contracts-boundary.test.ts", "tests/architecture/module-loaders.test.ts", "tests/architecture/static-scan.test.ts", "tests/architecture/m1-gate.test.ts",
  "tests/security/test-world.gateway.test.ts", "tests/security/positive.test.ts", "tests/security/unknown-action.test.ts", "tests/security/malformed-parameters.test.ts",
  "tests/security/prompt-injection.test.ts", "tests/security/privilege-escalation.test.ts", "tests/security/cross-tenant.test.ts", "tests/security/execution-cap.test.ts",
  "tests/security/rate-replay.gateway.test.ts", "tests/security/secret-extraction.test.ts", "tests/security/audit.test.ts", "tests/security/dependency-failure.test.ts",
  "tests/security/review-fixes.test.ts", "tests/security/review-probes.test.ts",
  "tests/integration/audit-trail.test.ts", "tests/integration/audit-postgres.test.ts", "tests/integration/reference-host.test.ts",
  "packages/security/src/state/conformance/audit-migration.test.ts", "packages/security/src/state/conformance/state-postgres-audit.test.ts",
]);
/** One file at least must run in each vitest project the gate selects. */
export const PROJECT_PATHS = Object.freeze({
  arch: "tests/architecture/", security: "tests/security/", integration: "tests/integration/", conformance: "/state/conformance/",
});
/** The reference host's vertical path: each numbered group of tests/integration/reference-host.test.ts must have run and passed. */
export const REFERENCE_HOST_GROUPS = Object.freeze(["1. VALID EXECUTION", "2. MISSING, INVALID and EXPIRED", "3. an UNAUTHORIZED", "4. a persistent AUDIT", "5. a CONFIRMATION-REQUIRED", "6. the AI-facing handle"]);
// Pin the representative proof inside each group, so retaining only a harmless sibling cannot satisfy the gate.
export const REFERENCE_HOST_CASES = Object.freeze([
  [REFERENCE_HOST_GROUPS[0], "a valid dev session and a registered state-changing proposal"],
  [REFERENCE_HOST_GROUPS[1], "undefined: no AI session exists"],
  [REFERENCE_HOST_GROUPS[1], "the token of an EXPIRED session: no AI session exists"],
  [REFERENCE_HOST_GROUPS[2], "a valid session without the required permission"],
  [REFERENCE_HOST_GROUPS[3], "the REAL durable ALLOWED append fails inside PostgreSQL"],
  [REFERENCE_HOST_GROUPS[4], "HIGH: REQUIRES_CONFIRMATION"],
  [REFERENCE_HOST_GROUPS[5], "is ONE frozen function"],
].map(pair => Object.freeze(pair)));
const normalize = value => value.replaceAll("\\", "/").replace(/\/$/, "");
const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TIER = /\((?:OPTIONAL|FUTURE)\b/;

const count = (file, status) => file.assertionResults.filter((test) => test.status === status).length;


export function checkReport(report, { suites = REQUIRED_SUITES, groups = REFERENCE_HOST_GROUPS, root = DEFAULT_ROOT } = {}) {
  const problems = [];
  if (report === null || typeof report !== "object" || !Array.isArray(report.testResults)) return ["the vitest report is missing or malformed"];
  if (report.testResults.some(file => file === null || typeof file !== "object" || typeof file.name !== "string" || !Array.isArray(file.assertionResults) || file.assertionResults.some(test => !test || typeof test.title !== "string" || typeof test.status !== "string" || !Array.isArray(test.ancestorTitles)))) return ["the vitest report is missing or malformed"];
  const prefix = `${normalize(root)}/`;
  const relative = file => { const name = normalize(file.name); return name.startsWith(prefix) ? name.slice(prefix.length) : undefined; };
  const find = path => report.testResults.find(file => relative(file) === path);
  if (report.success !== true || report.numFailedTests > 0 || report.numFailedTestSuites > 0) problems.push(`vitest reported failures (${report.numFailedTests} tests, ${report.numFailedTestSuites} suites)`);
  for (const path of suites) {
    const file = find(path);
    if (file === undefined) { problems.push(`missing suite: ${path}`); continue; }
    if (count(file, "passed") === 0) problems.push(`empty suite (no passing test): ${path}`);
    if (file.status === "failed" || count(file, "failed") > 0) problems.push(`failing suite: ${path}`);
    if (count(file, "skipped") + count(file, "pending") + count(file, "disabled") > 0) problems.push(`skipped tests in: ${path}`);
  }
  for (const [project, part] of Object.entries(PROJECT_PATHS)) {
    if (!report.testResults.some((file) => (project === "conformance" ? /^packages\/[^/]+\/src\/state\/conformance\//.test(relative(file) ?? "") : (relative(file) ?? "").startsWith(part)) && count(file, "passed") > 0)) problems.push(`no test ran in the ${project} project`);
  }
  const host = find("tests/integration/reference-host.test.ts");
  if (host !== undefined) {
    for (const group of groups) {
      if (!host.assertionResults.some((test) => test.status === "passed" && (test.ancestorTitles[0] ?? "").startsWith(group))) problems.push(`reference host group did not pass: ${group}`);
    }
  }
  if (host !== undefined) for (const [group, title] of REFERENCE_HOST_CASES) {
    if (!host.assertionResults.some(test => test.status === "passed" && (test.ancestorTitles[0] ?? "").startsWith(group) && test.title.startsWith(title))) problems.push(`reference host case did not pass: ${title}`);
  }
  // Every todo that is left must say it is OPTIONAL or FUTURE; a REQUIRED one means the gate is not honest about what it proves.
  for (const file of report.testResults) {
    for (const test of file.assertionResults) {
      if (test.status !== "todo") continue;
      const title = [...test.ancestorTitles, test.title].join(" > ");
      if (!TIER.test(test.title) || /\(REQUIRED\b/.test(title)) problems.push(`todo without an OPTIONAL or FUTURE tag (or tagged REQUIRED): ${file.name.split("/tests/").pop()}: ${title.slice(0, 90)}`);
    }
  }
  return problems;
}
