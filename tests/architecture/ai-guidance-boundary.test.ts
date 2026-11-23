/**
 * T301 (Feature 003): packages/ai stays a vendor-free, authority-free leaf.
 *
 *  - Non-test sources under packages/ai/src use no network (fetch, XMLHttpRequest, WebSocket), no process.env, no dynamic import or require, no node:fs,
 *    child_process, net or http(s), no DOM globals, and import only `@dap/contracts`, `zod` and relative files inside the package.
 *  - dependency-cruiser still fails an `ai -> security | actions | walkthrough | testkit` edge (proven here on planted edges in a disposable workspace).
 * The scan reads the syntax tree, so comments and string literals never count. Test files are not scanned: they may import the testkit's neighbours
 * only through the dependency-cruiser rule below, which does cover them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AI = "packages/ai";
const NETWORK = new Set(["fetch", "XMLHttpRequest", "WebSocket"]);
const DOM = new Set(["document", "window"]);
// Time and randomness only come from injected ports: the guidance code starts no timer of its own.
const TIMERS = new Set(["setTimeout", "setInterval", "setImmediate"]);
const ALLOWED_PACKAGES = new Set(["@dap/contracts", "zod"]);

/** Violations in one non-test source file (`rel` is repository-relative, forward slashes). */
export function scan(rel: string, text: string): string[] {
  const found: string[] = [];
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const flag = (rule: string, node: ts.Node) => found.push(`${rel}: ${rule}: ${node.getText(source).slice(0, 40)}`);
  const specifierOf = (node: ts.Node): string | undefined => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier.text;
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) return node.moduleReference.expression.text;
    return undefined;
  };
  const isMemberName = (node: ts.Identifier) => (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) || (ts.isPropertyAssignment(node.parent) && node.parent.name === node);
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (NETWORK.has(node.text)) flag("network-api", node);
      if (DOM.has(node.text) && !isMemberName(node)) flag("dom-global", node);
      if (node.text === "eval" && !isMemberName(node)) flag("eval", node);
      if (TIMERS.has(node.text)) flag("real-timer", node);
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "process" && node.name.text === "env") flag("process.env", node);
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "process") flag("process-access", node);
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && ((node.expression.text === "Date" && node.name.text === "now") || (node.expression.text === "Math" && node.name.text === "random"))) flag("clock-or-random", node);
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === "Function") flag("new-Function", node);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) flag("dynamic-import", node);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") flag("require", node);
    const specifier = specifierOf(node);
    if (specifier !== undefined) {
      if (specifier.startsWith(".")) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier));
        if (!resolved.startsWith(`${AI}/`)) flag("relative-import-leaves-the-package", node);
      } else if (!ALLOWED_PACKAGES.has(specifier)) flag(specifier.startsWith("node:") ? "node-builtin-import" : "unlisted-import", node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function sourcesUnder(rel: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (/\.(ts|mts|cts|js|mjs)$/.test(entry.name) && !/\.test\.[a-z]+$/.test(entry.name)) out.push(child);
    }
  };
  walk(rel);
  return out.sort();
}

describe("the real packages/ai sources", () => {
  const files = sourcesUnder(`${AI}/src`);
  it("include the guidance sources, so a clean scan means something", () => {
    expect(files.filter((f) => f.startsWith(`${AI}/src/guidance/`)).length).toBeGreaterThanOrEqual(7);
    expect(files).toContain(`${AI}/src/index.ts`);
  });
  it("have no violation", () => {
    expect(files.flatMap((rel) => scan(rel, fs.readFileSync(path.join(ROOT, rel), "utf8")))).toEqual([]);
  });
});

describe("planted-failure proofs for the source scan", () => {
  const file = `${AI}/src/guidance/x.ts`;
  const rules = (code: string, rel = file) => scan(rel, code).map((v) => v.split(": ")[1]);
  it.each([
    ["fetch", "export const a = () => fetch('/x');", "network-api"],
    ["XMLHttpRequest", "export const a = new XMLHttpRequest();", "network-api"],
    ["WebSocket", "export const a = new WebSocket('ws://x');", "network-api"],
    ["process.env", "export const a = process.env.KEY;", "process.env"],
    ["a dynamic import", "export const a = import('./y.js');", "dynamic-import"],
    ["require", "export const a = require('x');", "require"],
    ["node:fs", "import { readFileSync } from 'node:fs'; export const a = readFileSync;", "node-builtin-import"],
    ["child_process", "import { exec } from 'node:child_process'; export const a = exec;", "node-builtin-import"],
    ["node:net", "import net from 'node:net'; export const a = net;", "node-builtin-import"],
    ["node:https", "import https from 'node:https'; export const a = https;", "node-builtin-import"],
    ["a bare fs import", "import fs from 'fs'; export const a = fs;", "unlisted-import"],
    ["a vendor SDK", "import Anthropic from '@anthropic-ai/sdk'; export const a = Anthropic;", "unlisted-import"],
    ["the security package", "import { x } from '@dap/security'; export const a = x;", "unlisted-import"],
    ["the walkthrough package", "import { x } from '@dap/walkthrough'; export const a = x;", "unlisted-import"],
    ["the testkit", "import { x } from '@dap/testkit'; export const a = x;", "unlisted-import"],
    ["a contracts subpath", "import { x } from '@dap/contracts/mint'; export const a = x;", "unlisted-import"],
    ["a relative import that leaves the package", "import { x } from '../../../security/src/index.js'; export const a = x;", "relative-import-leaves-the-package"],
    ["document", "export const a = document.title;", "dom-global"],
    ["window", "export const a = window.location;", "dom-global"],
    ["eval", "export const a = eval('1');", "eval"],
    ["a real timer", "export const a = () => setTimeout(() => undefined, 1);", "real-timer"],
    ["Date.now", "export const a = Date.now();", "clock-or-random"],
    ["Math.random", "export const a = Math.random();", "clock-or-random"],
  ] as const)("%s is reported", (_name, code, rule) => {
    expect(rules(code)).toContain(rule);
  });
  it.each([
    ["the contracts package and zod", "import type { ProposalCall } from '@dap/contracts'; import { z } from 'zod'; export const a = z;"],
    ["relative imports inside the package", "import { x } from './limits.js'; import { y } from '../tool-call.js'; export const a = [x, y];"],
    ["hostile words in strings and comments", "// fetch process.env import( node:fs\nexport const a = 'fetch(process.env) require(node:fs) document window';"],
    ["a property that merely has a banned DOM name", "export const o = { document: 2, window: 3 }; export const a = o.document + o.window;"],
  ] as const)("%s is allowed", (_name, code) => {
    expect(scan(file, code)).toEqual([]);
  });
});

describe("dependency-cruiser still forbids packages/ai reaching the trusted packages (planted edges, disposable workspace)", () => {
  const DIRS: Record<string, string> = { contracts: "packages/contracts", ai: AI, actions: "packages/actions", security: "packages/security", testkit: "packages/testkit", walkthrough: "packages/walkthrough" };
  const EDGES: [string, string | null][] = [["security", "ai-not-to-security-or-actions"], ["actions", "ai-not-to-security-or-actions"], ["walkthrough", "walkthrough-not-imported-by-trusted-packages"], ["testkit", "production-not-to-testkit"], ["contracts", null]];
  let workspace: string;
  let violations: { from: string; to: string; rule: { name: string } }[];
  const plantedFile = (to: string) => `${AI}/src/planted_${to}.ts`;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(tmpdir(), "dap-ai-guidance-"));
    const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true }); fs.writeFileSync(path.join(workspace, file), text); };
    for (const file of ["package.json", "tsconfig.base.json", "dependency-cruiser.config.cjs"]) fs.copyFileSync(path.join(ROOT, file), path.join(workspace, file));
    for (const dir of Object.values(DIRS)) put(`${dir}/src/index.ts`, "export const marker = 1;\n");
    for (const [to] of EDGES) {
      const target = path.posix.relative(path.posix.dirname(plantedFile(to)), `${DIRS[to]}/src/index.ts`).replace(/\.ts$/, ".js");
      put(plantedFile(to), `import { marker } from ${JSON.stringify(target)};\nexport const planted = marker;\n`);
    }
    const result = spawnSync(process.execPath, [path.join(ROOT, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs"), "--config", "dependency-cruiser.config.cjs", "--output-type", "json", "packages"], { cwd: workspace, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    expect(result.error).toBeUndefined();
    expect([0, 1], result.stderr).toContain(result.status);
    violations = (JSON.parse(result.stdout) as { summary: { violations: typeof violations } }).summary.violations;
  });
  afterAll(() => { if (workspace) fs.rmSync(workspace, { recursive: true, force: true }); });

  it.each(EDGES.map(([to, rule]) => [`ai -> ${to}`, to, rule] as const))("%s", (_label, to, rule) => {
    const rules = violations.filter((v) => v.from === plantedFile(to)).map((v) => v.rule.name);
    if (rule === null) expect(rules).toEqual([]);
    else expect(rules).toContain(rule);
  });
});
