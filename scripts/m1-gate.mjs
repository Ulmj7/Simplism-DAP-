// Feature 001 M1 gate (T071): `npm run test:m1-gate`. The authoritative REQUIRED check; it adds no tests of its own, it runs the existing vitest projects
// arch + security + conformance + integration plus the focused dev-auth startup and PostgreSQL pool unit guards against the PostgreSQL in DAP_DATABASE_URL, migrating it first with DAP_MIGRATE_DATABASE_URL,
// and FAILS if a selected suite is missing, empty, skipped or failing, if a reference-host group did not run, or if a left-over todo is not tagged OPTIONAL/FUTURE.
// Representative coverage only; nothing here claims exhaustive security coverage. Category -> where it is proven (see m1-gate-check.mjs for the exact files):
//   positive path, executor once, trusted context, frozen params : security/test-world.gateway, positive, integration/reference-host
//   unknown / reserved action, malformed params, hostile text    : security/unknown-action, malformed-parameters, prompt-injection, privilege-escalation
//   authorization, foreign resources, host-supplied context      : security/privilege-escalation, cross-tenant, test-world.gateway
//   architecture bypass, mint internals, contracts re-exports    : architecture/graph, contracts-boundary, module-loaders, static-scan
//   risk, confirmation placeholder, FORBIDDEN never executes     : security/test-world.gateway, execution-cap, unknown-action, reference-host
//   execution cap (denials free, failures keep their slot)       : security/execution-cap
//   replay and rate (bounded representative behaviour only)      : security/rate-replay.gateway
//   audit order, one decision, durable ALLOWED, no canaries      : security/audit, secret-extraction, review-fixes, integration/audit-trail, audit-postgres, conformance/audit-migration
//   dependency failures of the key trusted ports (no 36-case matrix): security/dependency-failure, test-world.gateway, review-fixes
//   reference host, dev auth -> Gateway -> PostgreSQL audit -> executor : integration/reference-host (six numbered groups)
// Not part of M1 and not run here: exhaustive catalogue, mutation, determinism double-run, flood and multi-replica tests, the confirmation service.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkReport } from "./m1-gate-check.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fail = (message) => { throw new Error(message); };
const run = (args) => spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env: process.env });

function main() {
  for (const name of ["DAP_DATABASE_URL", "DAP_MIGRATE_DATABASE_URL"]) if (!process.env[name]) fail(`${name} is not set (use a throwaway database, never a shared one)`);
  if (run(["db/migrate.mjs"]).status !== 0) fail("the migration step failed");
  const dir = mkdtempSync(join(tmpdir(), "m1-gate-"));
  const out = join(dir, "report.json");
  try {
    // Vitest does not inherit the root CLI expect options into inline projects. Apply assertion checks to each project explicitly.
    const config = join(dir, "vitest.config.mjs");
    writeFileSync(config, `import base from ${JSON.stringify(pathToFileURL(join(root, "vitest.config.ts")).href)}; export default { ...base, test: { ...base.test, projects: base.test.projects.map(project => ({ ...project, test: { ...project.test, allowOnly: false, expect: { ...project.test?.expect, requireAssertions: true } } })) } };`);
    const projects = ["unit", "arch", "security", "conformance", "integration"].flatMap((name) => ["--project", name]);
    const selected = ["tests/architecture/", "tests/security/", "/state/conformance/", "tests/integration/", "apps/reference-host/src/startup.test.ts", "packages/security/src/state/postgres/pool.test.ts"];
    const vitest = run(["node_modules/vitest/vitest.mjs", "run", "--config", config, "--maxWorkers=2", ...projects, ...selected, "--allowOnly=false", "--expect.requireAssertions=true", "--reporter=default", "--reporter=json", `--outputFile.json=${out}`]);
    let report;
    try { report = JSON.parse(readFileSync(out, "utf8")); } catch { fail("vitest produced no report"); }
    const problems = checkReport(report);
    if (vitest.status !== 0) problems.unshift(`vitest exited with status ${vitest.status}`);
    if (problems.length > 0) { for (const problem of problems) console.error(`m1-gate: ${problem}`); fail(`${problems.length} problem(s)`); }
    const files = report.testResults.length;
    console.log(`m1-gate: PASS (${files} files, ${report.numPassedTests} passed, ${report.numTodoTests} todo, every todo tagged OPTIONAL or FUTURE)`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { main(); } catch (error) { console.error(`m1-gate: FAIL: ${error.message}`); process.exitCode = 1; }
}
