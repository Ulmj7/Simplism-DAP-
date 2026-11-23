/**
 * T071: the M1 gate's own checks (scripts/m1-gate-check.mjs) are able to fail. A gate that cannot reject a missing, empty, skipped or failing suite, a reference-host
 * group that did not run, or an untagged todo would pass vacuously. Pure data in, problems out; no database.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { PROJECT_PATHS, REFERENCE_HOST_CASES, REFERENCE_HOST_GROUPS, REQUIRED_SUITES, checkReport as inspectReport } from "../../scripts/m1-gate-check.mjs";

const checkReport = (report: unknown, options: { suites?: readonly string[]; groups?: readonly string[]; root?: string } = {}) => inspectReport(report, { root: "/repo", ...options });

type Status = "passed" | "failed" | "skipped" | "todo";
const test = (status: Status, title = "t", group = "g") => ({ ancestorTitles: [group], title, status });
const file = (path: string, tests: ReturnType<typeof test>[]) => ({ name: `/repo/${path}`, assertionResults: tests });
const hostTests = REFERENCE_HOST_CASES.map(([group, title]) => test("passed", title, group));
/** One passing file for every required suite, one for every project, the host with all its groups. */
const healthy = () => ({
  success: true, numFailedTests: 0, numFailedTestSuites: 0,
  testResults: [
    ...REQUIRED_SUITES.map((path) => file(path, path.endsWith("reference-host.test.ts") ? hostTests : [test("passed")])),
  ],
});
const without = (report: ReturnType<typeof healthy>, path: string) => ({ ...report, testResults: report.testResults.filter((entry) => !entry.name.endsWith(path)) });
const replace = (report: ReturnType<typeof healthy>, path: string, tests: ReturnType<typeof test>[]) => ({ ...report, testResults: report.testResults.map((entry) => (entry.name.endsWith(path) ? file(path, tests) : entry)) });
const HOST = "tests/integration/reference-host.test.ts";

describe("the M1 gate's checks", () => {
  it("passes a healthy report, and every project and the reference host are part of it", () => {
    expect(checkReport(healthy())).toEqual([]);
    expect(Object.keys(PROJECT_PATHS).sort()).toEqual(["arch", "conformance", "integration", "security"]);
    expect(REQUIRED_SUITES).toContain(HOST);
    expect(REFERENCE_HOST_GROUPS).toHaveLength(6);
  });
  it.each(REQUIRED_SUITES)("a missing suite is a failure: %s", (path) => {
    expect(checkReport(without(healthy(), path))).toContain(`missing suite: ${path}`);
  });
  it("an empty suite (todo only, or skipped only) is a failure", () => {
    expect(checkReport(replace(healthy(), "tests/security/positive.test.ts", [test("todo", "x (OPTIONAL)")]))).toContain("empty suite (no passing test): tests/security/positive.test.ts");
    expect(checkReport(replace(healthy(), "tests/security/positive.test.ts", [test("skipped")]))).toContain("empty suite (no passing test): tests/security/positive.test.ts");
    expect(checkReport(replace(healthy(), "tests/security/positive.test.ts", []))).toContain("empty suite (no passing test): tests/security/positive.test.ts");
  });
  it("a skipped test inside an otherwise passing suite, and a failing one, are failures", () => {
    expect(checkReport(replace(healthy(), "tests/security/positive.test.ts", [test("passed"), test("skipped")]))).toContain("skipped tests in: tests/security/positive.test.ts");
    expect(checkReport(replace(healthy(), "tests/security/positive.test.ts", [test("passed"), test("failed")]))).toContain("failing suite: tests/security/positive.test.ts");
  });
  it("a run vitest itself calls unsuccessful is a failure, even if every selected file looks healthy", () => {
    expect(checkReport({ ...healthy(), success: false, numFailedTests: 2 }).join("\n")).toMatch(/vitest reported failures/);
  });
  it.each(REFERENCE_HOST_GROUPS)("a reference-host group that did not pass is a failure: %s", (group) => {
    const tests = hostTests.filter(entry => entry.ancestorTitles[0] !== group);
    expect(checkReport(replace(healthy(), HOST, tests))).toContain(`reference host group did not pass: ${group}`);
    const skipped = hostTests.map(entry => test(entry.ancestorTitles[0] === group ? "skipped" : "passed", entry.title, entry.ancestorTitles[0]));
    expect(checkReport(replace(healthy(), HOST, skipped))).toContain(`reference host group did not pass: ${group}`);
  });
  it("a project in which no test ran is a failure", () => {
    const report = healthy();
    const noArch = { ...report, testResults: report.testResults.filter((entry) => !entry.name.includes("tests/architecture/")) };
    expect(checkReport(noArch, { suites: [] })).toContain("no test ran in the arch project");
  });
  it("a todo must say OPTIONAL or FUTURE: an untagged one and a REQUIRED one are failures, a tagged one is not", () => {
    const withTodo = (title: string) => replace(healthy(), "tests/security/positive.test.ts", [test("passed"), test("todo", title)]);
    expect(checkReport(withTodo("ATK-X (OPTIONAL, T108) later"))).toEqual([]);
    expect(checkReport(withTodo("ATK-X (FUTURE, T123) later"))).toEqual([]);
    expect(checkReport(withTodo("ATK-X later")).join("\n")).toMatch(/todo without an OPTIONAL or FUTURE tag/);
    expect(checkReport(withTodo("ATK-X (REQUIRED) later")).join("\n")).toMatch(/todo without an OPTIONAL or FUTURE tag/);
    expect(checkReport(withTodo("ATK-X (OPTIONAL) and (REQUIRED)")).join("\n")).toMatch(/todo without an OPTIONAL or FUTURE tag/);
  });
  it("a missing or malformed report is a failure", () => {
    expect(checkReport(undefined)).toEqual(["the vitest report is missing or malformed"]);
    expect(checkReport({})).toEqual(["the vitest report is missing or malformed"]);
  });
});


it("the gate requires the existing dev-auth startup and PostgreSQL pool guards, not only integration files", () => {
  expect(REQUIRED_SUITES).toContain("apps/reference-host/src/startup.test.ts");
  expect(REQUIRED_SUITES).toContain("packages/security/src/state/postgres/pool.test.ts");
});


it("matches required files inside the repository, never an unrelated suffix or conformance look-alike", () => {
  const report = healthy();
  const unrelated = { ...report, testResults: report.testResults.map(entry => ({ ...entry, name: `/unrelated${entry.name}` })) };
  expect(checkReport(unrelated)).toContain(`missing suite: ${HOST}`);
  const impostor = { ...report, testResults: report.testResults.filter(entry => !entry.name.includes("/state/conformance/")).concat(file("unrelated/state/conformance/fake.test.ts", [test("passed")])) };
  expect(checkReport(impostor, { suites: [] })).toContain("no test ran in the conformance project");
});
it("supports a different repository root and Windows report separators", () => {
  const report = healthy();
  const windows = { ...report, testResults: report.testResults.map(entry => ({ ...entry, name: entry.name.replace("/repo", "C:/work/repo").replaceAll("/", "\\") })) };
  expect(checkReport(windows, { root: "C:/work/repo" })).toEqual([]);
});
it("rejects a file-level failure even if Vitest's aggregate counts and test statuses look healthy", () => {
  const report = healthy();
  expect(checkReport({ ...report, testResults: report.testResults.map(entry => ({ ...entry, status: "failed" })) })).not.toEqual([]);
});
it("requires the state-changing proof, not just some passing test under its numbered group", () => {
  const report = replace(healthy(), HOST, hostTests.filter(entry => !entry.title.startsWith("a valid dev session and a registered state-changing proposal")));
  expect(checkReport(report).join("\n")).toMatch(/reference host case did not pass/);
});
it("a tier in an ancestor title cannot excuse an untagged or REQUIRED todo", () => {
  expect(checkReport(replace(healthy(), "tests/security/positive.test.ts", [test("passed"), test("todo", "x (OPTIONAL)", "parent (REQUIRED)")])).join("\n")).toMatch(/todo without/);
  expect(checkReport(replace(healthy(), "tests/security/positive.test.ts", [test("passed"), test("todo", "untagged", "parent (OPTIONAL)")])).join("\n")).toMatch(/todo without/);
});
it("the runner refuses focused tests and assertion-free early returns", () => {
  const source = readFileSync(new URL("../../scripts/m1-gate.mjs", import.meta.url), "utf8");
  expect(source).toContain('"--allowOnly=false"');
  expect(source).toContain("requireAssertions: true");
});


it("the CLI rejects a nonzero Vitest exit despite a healthy report, and removes temporary output on failure", () => {
  const root = mkdtempSync(join(tmpdir(), "qa-gate-cli-"));
  let generated: string | undefined;
  try {
    for (const dir of ["scripts", "db", "node_modules/vitest"]) mkdirSync(join(root, dir), { recursive: true });
    for (const name of ["m1-gate.mjs", "m1-gate-check.mjs"]) cpSync(new URL(`../../scripts/${name}`, import.meta.url), join(root, "scripts", name));
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "db/migrate.mjs"), "// This CLI protocol test never connects to a database.\n");
    writeFileSync(join(root, "node_modules/vitest/vitest.mjs"), `import {writeFileSync} from 'node:fs'; const out = process.argv.find(a => a.startsWith('--outputFile.json=')).split('=')[1]; console.log('QA_REPORT='+out); writeFileSync(out, process.env.QA_REPORT); process.exit(7);`);
    const report = healthy();
    const adjusted = { ...report, testResults: report.testResults.map(entry => ({ ...entry, name: entry.name.replace("/repo", root) })) };
    const result = spawnSync(process.execPath, [join(root, "scripts/m1-gate.mjs")], { cwd: tmpdir(), encoding: "utf8", timeout: 10_000, env: { ...process.env, DAP_DATABASE_URL: "unused", DAP_MIGRATE_DATABASE_URL: "unused", QA_REPORT: JSON.stringify(adjusted) } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("vitest exited with status 7");
    generated = /QA_REPORT=(.+)/.exec(result.stdout)?.[1];
    expect(generated).toBeDefined();
    expect(existsSync(generated!)).toBe(false);
  } finally {
    if (generated !== undefined) rmSync(join(generated, ".."), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
