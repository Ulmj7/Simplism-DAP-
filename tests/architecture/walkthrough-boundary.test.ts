/**
 * T202 (Feature 002): the walkthrough runtime's boundary.
 *
 *  - packages/walkthrough is a leaf (no @dap/* import, no runtime dependency) and only its `src/dom` may touch `document`, `window`,
 *    `HTMLElement`, `MutationObserver`, nodes or browser event objects (Constitution VII: the pure core cannot reach the page).
 *  - The core (everything in the package outside `src/dom`: semantic, privacy, walkthrough, engine, index) may not import `src/dom`.
 *  - Neither packages/walkthrough nor apps/reference-web may use eval, `new Function`, innerHTML, outerHTML, insertAdjacentHTML or document.write.
 *  - packages/walkthrough may not use fetch, XMLHttpRequest, WebSocket or a dynamic import.
 *  - apps/reference-web may import only @dap/walkthrough (and vite, vitest and its own files).
 *  - The dependency-cruiser rules that say the same are proven able to fail on planted edges in a disposable workspace.
 * The scan reads the syntax tree, so comments and string literals (for example a test's hostile text) never count.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE = "packages/walkthrough";
const APP = "apps/reference-web";

const DOM_GLOBALS = new Set([
  "document", "window", "HTMLElement", "MutationObserver",
  // browser nodes and event objects: the core only ever sees plain semantic events
  "Element", "Node", "HTMLInputElement", "Event", "MouseEvent", "KeyboardEvent", "InputEvent", "CustomEvent", "EventTarget", "DOMRect", "getComputedStyle", "localStorage", "sessionStorage", "navigator", "location",
]);
const NETWORK = new Set(["fetch", "XMLHttpRequest", "WebSocket"]);
const HTML_SINKS = new Set(["innerHTML", "outerHTML", "insertAdjacentHTML"]);
const APP_EXTERNAL = new Set(["vite", "vitest"]);

const isTest = (rel: string) => /\.test\.ts$/.test(rel);
const inDom = (rel: string) => rel.startsWith(`${CORE}/src/dom/`);

/** Violations found in one file (`rel` is repository-relative with forward slashes). */
export function scan(rel: string, text: string): string[] {
  const found: string[] = [];
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const inCore = rel.startsWith(`${CORE}/`);
  const inApp = rel.startsWith(`${APP}/`);
  const flag = (rule: string, node: ts.Node) => found.push(`${rel}: ${rule}: ${node.getText(source).slice(0, 40)}`);
  const isPropertyName = (node: ts.Identifier) => (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) || (ts.isPropertyAssignment(node.parent) && node.parent.name === node) || (ts.isPropertySignature(node.parent) && node.parent.name === node);
  const specifierOf = (node: ts.Node): string | undefined => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) return node.moduleSpecifier.text;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0];
      return first !== undefined && ts.isStringLiteralLike(first) ? first.text : "<dynamic>";
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const first = node.arguments[0];
      return first !== undefined && ts.isStringLiteralLike(first) ? first.text : "<dynamic>";
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) return node.moduleReference.expression.text;
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      if (inCore && !inDom(rel) && !isTest(rel) && DOM_GLOBALS.has(node.text) && !isPropertyName(node)) flag("dom-global-outside-src/dom", node);
      if (inCore && NETWORK.has(node.text)) flag("network-api", node);
      if (node.text === "eval" && !isPropertyName(node)) flag("eval", node);
    }
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === "Function") flag("new-Function", node);
    if (ts.isPropertyAccessExpression(node)) {
      if (HTML_SINKS.has(node.name.text)) flag("html-sink", node);
      if ((node.name.text === "write" || node.name.text === "writeln") && ((ts.isIdentifier(node.expression) && node.expression.text === "document") || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "document"))) flag("document.write", node);
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && HTML_SINKS.has(node.argumentExpression.text)) flag("html-sink", node);
    const specifier = specifierOf(node);
    if (specifier !== undefined) {
      const dynamic = ts.isCallExpression(node);
      if (inCore && dynamic) flag("dynamic-import-or-require", node);
      if (specifier === "<dynamic>") flag("non-literal-import", node);
      else if (specifier.startsWith("@dap/") && inCore) flag("core-imports-a-workspace-package", node);
      else if (specifier.startsWith("@dap/") && inApp && specifier !== "@dap/walkthrough" && specifier !== "@dap/walkthrough/dom") flag("app-imports-other-than-walkthrough", node);
      else if (specifier.startsWith(".")) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier));
        const home = inCore ? CORE : inApp ? APP : undefined;
        if (home !== undefined && !resolved.startsWith(`${home}/`)) flag("relative-import-leaves-the-tree", node);
        else if (inCore && !inDom(rel) && inDom(resolved)) flag("core-imports-src/dom", node);
      } else if (inApp && !specifier.startsWith("@dap/") && !specifier.startsWith("node:") && !APP_EXTERNAL.has(specifier)) flag("app-imports-an-unlisted-package", node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function filesUnder(rel: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (/\.(ts|mts|cts|js|mjs)$/.test(entry.name)) out.push(child);
    }
  };
  walk(rel);
  return out.sort();
}

describe("the real trees", () => {
  const files = [...filesUnder(CORE), ...filesUnder(APP)];
  it("are not empty, so a clean scan means something", () => {
    expect(files.filter((f) => f.startsWith(`${CORE}/src/`) && !f.startsWith(`${CORE}/src/dom/`) && !isTest(f)).length).toBeGreaterThan(2);
    expect(files.filter((f) => inDom(f) && !isTest(f)).length).toBeGreaterThan(1);
    expect(files.filter((f) => f.startsWith(`${APP}/src/`)).length).toBeGreaterThan(5);
  });
  it("have no violation", () => {
    const violations = files.flatMap((rel) => scan(rel, fs.readFileSync(path.join(ROOT, rel), "utf8")));
    expect(violations).toEqual([]);
  });
  it("only src/dom of the walkthrough package touches the page: the DOM files really do use document", () => {
    const usesDocument = filesUnder(`${CORE}/src/dom`).filter((f) => !isTest(f)).some((f) => /\bdocument\b|\bownerDocument\b/.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
    expect(usesDocument).toBe(true);
  });
  it("packages/walkthrough has no runtime dependency and names no workspace package in its manifest", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, CORE, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) expect(Object.keys(manifest[field] ?? {}), field).toEqual([]);
  });
  it("apps/reference-web declares only @dap/walkthrough among workspace packages", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, APP, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    const declared = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((f) => Object.keys(manifest[f] ?? {})).filter((n) => n.startsWith("@dap/"));
    expect(declared).toEqual(["@dap/walkthrough"]);
  });
});

describe("planted-failure proofs for the source scan", () => {
  const core = `${CORE}/src/semantic/x.ts`;
  const domFile = `${CORE}/src/dom/x.ts`;
  const app = `${APP}/src/x.ts`;
  const rules = (rel: string, code: string) => scan(rel, code).map((v) => v.split(": ")[1]);
  it.each([
    ["document in the pure core", core, "export const a = document.title;", "dom-global-outside-src/dom"],
    ["window in the pure core", core, "export const a = window.location;", "dom-global-outside-src/dom"],
    ["HTMLElement type in the pure core", core, "export type A = HTMLElement;", "dom-global-outside-src/dom"],
    ["MutationObserver in the pure core", core, "export const a = new MutationObserver(() => {});", "dom-global-outside-src/dom"],
    ["eval", app, "export const a = eval('1');", "eval"],
    ["new Function", core, "export const a = new Function('return 1');", "new-Function"],
    ["innerHTML in the app", app, "export const a = (e: Element) => { e.innerHTML = 'x'; };", "html-sink"],
    ["outerHTML in the DOM adapter", domFile, "export const a = (e: Element) => e.outerHTML;", "html-sink"],
    ["insertAdjacentHTML", app, "export const a = (e: Element) => e.insertAdjacentHTML('beforeend', 'x');", "html-sink"],
    ["a string-keyed innerHTML", app, "export const a = (e: any) => e['innerHTML'];", "html-sink"],
    ["document.write", domFile, "export const a = () => document.write('x');", "document.write"],
    ["fetch in the DOM adapter", domFile, "export const a = () => fetch('/x');", "network-api"],
    ["XMLHttpRequest", core, "export const a = new XMLHttpRequest();", "network-api"],
    ["WebSocket", domFile, "export const a = new WebSocket('ws://x');", "network-api"],
    ["a dynamic import in the core", core, "export const a = import('./y.js');", "dynamic-import-or-require"],
    ["a core file importing the DOM adapter", `${CORE}/src/engine/x.ts`, "import { createTargets } from '../dom/targets.js'; export const a = createTargets;", "core-imports-src/dom"],
    ["the package root importing the DOM adapter", `${CORE}/src/index.ts`, "export { createOverlay } from './dom/overlay.js';", "core-imports-src/dom"],
    ["a core test file importing the DOM adapter", `${CORE}/src/walkthrough/x.test.ts`, "import { createTargets } from '../dom/index.js'; export const a = createTargets;", "core-imports-src/dom"],
    ["a browser event object in the engine", `${CORE}/src/engine/x.ts`, "export const a = (e: MouseEvent) => e.target;", "dom-global-outside-src/dom"],
    ["a node type in the engine", `${CORE}/src/engine/x.ts`, "export const a = (n: Node) => n;", "dom-global-outside-src/dom"],
    ["getComputedStyle in the walkthrough definitions", `${CORE}/src/walkthrough/x.ts`, "export const a = getComputedStyle;", "dom-global-outside-src/dom"],
    ["a workspace import in the core", core, "import { x } from '@dap/contracts'; export const a = x;", "core-imports-a-workspace-package"],
    ["a relative import that leaves the core", core, "import { x } from '../../../security/src/index.js'; export const a = x;", "relative-import-leaves-the-tree"],
    ["the app importing the security package", app, "import { x } from '@dap/security'; export const a = x;", "app-imports-other-than-walkthrough"],
    ["the app importing a deep walkthrough path", app, "import { x } from '@dap/walkthrough/src/semantic/registry.js'; export const a = x;", "app-imports-other-than-walkthrough"],
    ["the app importing an unlisted package", app, "import { x } from 'left-pad'; export const a = x;", "app-imports-an-unlisted-package"],
    ["the app reaching into packages by path", app, "import { x } from '../../../packages/security/src/index.js'; export const a = x;", "relative-import-leaves-the-tree"],
  ] as const)("%s is reported", (_name, rel, code, rule) => {
    expect(rules(rel, code)).toContain(rule);
  });
  it.each([
    ["document inside src/dom", domFile, "export const a = document.title;"],
    ["document inside a core test file", `${CORE}/src/semantic/x.test.ts`, "export const a = document.title;"],
    ["a property that is merely named document or fetch-free text", core, "export const o = { document: 1 }; export const b = o.document;"],
    ["hostile text in a string literal and a comment", app, "// innerHTML eval fetch\nexport const a = '<img src=x onerror=alert(1)> innerHTML = document.write';"],
    ["the app importing the walkthrough package and its DOM entry", app, "import { a } from '@dap/walkthrough'; import { b } from '@dap/walkthrough/dom'; import { c } from './y.js'; export const d = [a, b, c];"],
    ["the app's config importing vite", `${APP}/vite.config.ts`, "import { defineConfig } from 'vite'; export default defineConfig({});"],
    ["the DOM adapter importing the core", `${CORE}/src/dom/x.ts`, "import { createSemanticRegistry } from '../semantic/registry.js'; export const a = createSemanticRegistry;"],
    ["the engine importing the privacy module", `${CORE}/src/engine/x.ts`, "import { buildSemanticContext } from '../privacy/privacy.js'; export const a = buildSemanticContext;"],
    ["a relative import inside the tree", core, "import { x } from '../privacy/privacy.js'; export const a = x;"],
  ] as const)("%s is allowed", (_name, rel, code) => {
    expect(scan(rel, code)).toEqual([]);
  });
});

describe("planted edges against the dependency-cruiser rules (disposable workspace)", () => {
  const DIRS: Record<string, string> = { contracts: "packages/contracts", ai: "packages/ai", actions: "packages/actions", security: "packages/security", testkit: "packages/testkit", walkthrough: CORE, "reference-host": "apps/reference-host", "reference-web": APP };
  /** [from, to, rule that must name it, or null when the edge is allowed] */
  const EDGES: [string, string, string | null][] = [
    ["walkthrough", "contracts", "walkthrough-leaf"], ["walkthrough", "ai", "walkthrough-leaf"], ["walkthrough", "actions", "walkthrough-leaf"], ["walkthrough", "security", "walkthrough-leaf"],
    ["walkthrough", "testkit", "walkthrough-leaf"], ["walkthrough", "testkit", "production-not-to-testkit"], ["walkthrough", "reference-host", "walkthrough-leaf"],
    ["contracts", "walkthrough", "walkthrough-not-imported-by-trusted-packages"], ["ai", "walkthrough", "walkthrough-not-imported-by-trusted-packages"],
    ["actions", "walkthrough", "walkthrough-not-imported-by-trusted-packages"], ["security", "walkthrough", "walkthrough-not-imported-by-trusted-packages"],
    ["testkit", "walkthrough", "walkthrough-not-imported-by-trusted-packages"],
    ["reference-web", "contracts", "reference-web-only-walkthrough"], ["reference-web", "ai", "reference-web-only-walkthrough"], ["reference-web", "actions", "reference-web-only-walkthrough"],
    ["reference-web", "security", "reference-web-only-walkthrough"], ["reference-web", "testkit", "reference-web-only-walkthrough"], ["reference-web", "testkit", "production-not-to-testkit"],
    ["reference-web", "reference-host", "reference-web-only-walkthrough"],
    ["reference-web", "walkthrough", null], ["reference-host", "walkthrough", null], ["testkit", "security", null],
  ];
  let workspace: string;
  let violations: { from: string; to: string; rule: { name: string } }[];
  let planted: { file: string; from: string; to: string; rule: string | null }[];

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(tmpdir(), "dap-walkthrough-"));
    const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true }); fs.writeFileSync(path.join(workspace, file), text); };
    for (const file of ["package.json", "tsconfig.base.json", "dependency-cruiser.config.cjs"]) fs.copyFileSync(path.join(ROOT, file), path.join(workspace, file));
    for (const dir of Object.values(DIRS)) put(`${dir}/src/index.ts`, "export const marker = 1;\n");
    planted = EDGES.map(([from, to, rule], index) => ({ file: `${DIRS[from]}/src/planted_${index}.ts`, from, to, rule }));
    for (const { file, to } of planted) {
      const target = path.posix.relative(path.posix.dirname(file), `${DIRS[to]}/src/index.ts`).replace(/\.ts$/, ".js");
      put(file, `import { marker } from ${JSON.stringify(target)};\nexport const planted = marker;\n`);
    }
    const result = spawnSync(process.execPath, [path.join(ROOT, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs"), "--config", "dependency-cruiser.config.cjs", "--output-type", "json", "packages", "apps"], { cwd: workspace, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    expect(result.error).toBeUndefined();
    expect([0, 1], result.stderr).toContain(result.status);
    violations = (JSON.parse(result.stdout) as { summary: { violations: typeof violations } }).summary.violations;
  });
  afterAll(() => { if (workspace) fs.rmSync(workspace, { recursive: true, force: true }); });

  it("keeps the fixture outside the repository", () => {
    expect(path.relative(ROOT, workspace).startsWith("..")).toBe(true);
  });
  it.each(EDGES.map(([from, to, rule], index) => [`${from} -> ${to} (${rule ?? "allowed"})`, index] as const))("%s", (_label, index) => {
    const item = (planted ?? [])[index]!;
    const rules = violations.filter((violation) => violation.from === item.file).map((violation) => violation.rule.name);
    if (item.rule === null) expect(rules).toEqual([]);
    else expect(rules).toContain(item.rule);
  });
  it("the real configuration still names every Feature 002 rule", () => {
    const config = fs.readFileSync(path.join(ROOT, "dependency-cruiser.config.cjs"), "utf8");
    for (const name of ["walkthrough-leaf", "walkthrough-not-imported-by-trusted-packages", "reference-web-only-walkthrough", "production-not-to-testkit"]) expect(config).toContain(`"${name}"`);
  });
});
