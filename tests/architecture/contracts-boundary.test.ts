import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cruiseBin = path.join(ROOT, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs");
const ORIGINS = ["ai", "actions", "security", "testkit"].map((name) => ({
  dir: `packages/${name}/src`,
  mintAllowed: name === "security" || name === "testkit",
})).concat({ dir: "apps/reference-host/src", mintAllowed: false });

type Form = "static" | "dynamic" | "require";
interface Case {
  file: string;
  code: string;
  lintBlocked: boolean;
  depBlocked: boolean;
}

function buildCases(): Case[] {
  const cases: Case[] = [];
  function add(dir: string, spec: string, form: Form, lintBlocked: boolean, depBlocked: boolean) {
    const code = form === "static" ? `import * as value from ${JSON.stringify(spec)}; export { value };`
      : form === "dynamic" ? `export const value = import(${JSON.stringify(spec)});`
        : `export const value = require(${JSON.stringify(spec)});`;
    cases.push({ file: `${dir}/boundary_${cases.length}.ts`, code, lintBlocked, depBlocked });
  }
  for (const origin of ORIGINS) {
    for (const form of ["static", "dynamic", "require"] as const) {
      // CommonJS globals are forbidden in the ESM runtime tree, independently of edge permissions.
      add(origin.dir, "@dap/contracts", form, form === "require", false);
      add(origin.dir, "@dap/contracts/mint", form, form === "require" || !origin.mintAllowed, !origin.mintAllowed);
      add(origin.dir, "node:module", form, true, true);
      add(origin.dir, "module", form, true, true);
      for (const tree of ["src", "dist"]) {
        for (const module of ["execution-runtime", "mint/grant-registry", "mint/context-registry"]) {
          for (const ext of tree === "src" ? ["js", "ts"] : ["js"]) {
            const spec = path.relative(origin.dir, `packages/contracts/${tree}/${module}.${ext}`);
            add(origin.dir, spec, form, true, true);
          }
        }
      }
    }
  }
  for (const form of ["static", "dynamic"] as const) {
    add("packages/contracts/src", "./core.js", form, false, false);
    add("packages/contracts/src", "./mint/grant-registry.js", form, false, false);
    add("packages/contracts/src", "node:module", form, true, true);
    add("packages/contracts/src", "module", form, true, true);
  }
  return cases;
}

const CASES = buildCases();
let workspace: string | undefined;
let eslint: ESLint;
function abs(file: string): string {
  if (!workspace) throw new Error("Boundary fixture workspace is not initialized");
  return path.join(workspace, file);
}

beforeAll(() => {
  expect(fs.existsSync(path.join(ROOT, "packages/contracts/dist/index.js")), "Run npm run typecheck first").toBe(true);
  workspace = fs.mkdtempSync(path.join(tmpdir(), "dap-contracts-boundary-"));
  // A crash can leave a temporary directory, never fixture source files in the real workspace.
  const relative = path.relative(ROOT, workspace);
  expect(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "Use a TMPDIR outside the repository").toBe(true);
  for (const file of ["package.json", "tsconfig.base.json", "dependency-cruiser.config.cjs"]) {
    fs.copyFileSync(path.join(ROOT, file), abs(file));
  }
  const packageDirs = ORIGINS.map(({ dir }) => path.dirname(dir)).concat("packages/contracts");
  for (const dir of packageDirs) {
    fs.mkdirSync(abs(dir), { recursive: true });
    fs.copyFileSync(path.join(ROOT, dir, "package.json"), abs(`${dir}/package.json`));
  }
  for (const tree of ["src", "dist"]) {
    fs.cpSync(path.join(ROOT, "packages/contracts", tree), abs(`packages/contracts/${tree}`), { recursive: true });
  }
  // Workspace links must resolve to the disposable copy, not the real contracts tree.
  fs.mkdirSync(abs("node_modules/@dap"), { recursive: true });
  for (const name of fs.readdirSync(path.join(ROOT, "node_modules"))) {
    if (name.startsWith(".") || name === "@dap") continue;
    fs.symlinkSync(path.join(ROOT, "node_modules", name), abs(`node_modules/${name}`), "junction");
  }
  for (const dir of packageDirs) {
    const pkg = JSON.parse(fs.readFileSync(abs(`${dir}/package.json`), "utf8")) as { name: string };
    fs.symlinkSync(abs(dir), abs(`node_modules/${pkg.name}`), "junction");
  }
  for (const c of CASES) {
    fs.mkdirSync(path.dirname(abs(c.file)), { recursive: true });
    fs.writeFileSync(abs(c.file), c.code, { flag: "wx" });
  }
  eslint = new ESLint({ cwd: ROOT, overrideConfigFile: path.join(ROOT, "eslint.config.js") });
});

afterAll(() => {
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
});

interface Graph {
  modules: { source: string; dependencies: { couldNotResolve: boolean }[] }[];
  summary: { violations: { from: string; rule: { name: string } }[] };
}

describe("contracts mint boundary (architecture regression)", () => {
  it("keeps every fixture outside the working repository", () => {
    for (const c of CASES) {
      const relative = path.relative(ROOT, abs(c.file));
      expect(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)).toBe(true);
    }
  });

  it("checks static, dynamic and require edges without altering real package sources", async () => {
    const result = spawnSync(process.execPath, [
      cruiseBin, "--config", "dependency-cruiser.config.cjs", "--output-type", "json", "packages", "apps",
    ], { cwd: workspace, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    expect(result.error).toBeUndefined();
    expect([0, 1], result.stderr).toContain(result.status);
    const graph = JSON.parse(result.stdout) as Graph;
    const failures: string[] = [];
    for (const c of CASES) {
      // Use real package paths only as virtual ESLint filenames; nothing is written there.
      const results = await eslint.lintText(c.code, { filePath: path.join(ROOT, c.file) });
      const messages = results.flatMap((r) => r.messages);
      expect(messages.filter((message) => message.fatal), c.file).toEqual([]);
      const lintBlocked = messages.some((m) => ["no-restricted-imports", "no-restricted-syntax", "no-restricted-globals"]
        .includes(m.ruleId ?? ""));
      const dependency = graph.modules.find((m) => m.source === c.file)?.dependencies;
      expect(dependency?.length, `Missing dependency edge: ${c.file}`).toBeGreaterThan(0);
      expect(dependency?.some((d) => d.couldNotResolve), c.file).toBe(false);
      const depBlocked = graph.summary.violations.some((v) => v.from === c.file);
      if (lintBlocked !== c.lintBlocked || depBlocked !== c.depBlocked) {
        failures.push(`${c.file}: ${c.code} lint=${lintBlocked}, depcruise=${depBlocked}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
