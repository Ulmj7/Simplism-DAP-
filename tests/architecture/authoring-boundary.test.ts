/**
 * T402 (Feature 004): the narrow validator subpath `@dap/walkthrough/authoring` and who may import it.
 *
 *  - The reference host may import `@dap/walkthrough/authoring` ONLY inside `apps/reference-host/src/authoring/**`.
 *  - The root `@dap/walkthrough` (the runtime) and `@dap/walkthrough/dom` stay refused EVERYWHERE in the host, as does any deep relative path into the package.
 *  - The subpath exports exactly the intended names, and its import closure contains no runtime, machine, ports, presenter, DOM or privacy module.
 *  - The package manifest has exactly the three entry points, shaped alike.
 * The scan reads the syntax tree (comments and string literals that are not import specifiers never count). guidance-host-boundary.test.ts is unchanged
 * and keeps refusing the root specifier in every host source.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOST = "apps/reference-host/src";
const AUTHORING_DIR = `${HOST}/authoring/`;
const PKG = "packages/walkthrough";

const specifiersOf = (text: string): string[] => {
  const out: string[] = [];
  const source = ts.createSourceFile("x.ts", text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) out.push(node.moduleReference.expression.text);
    else if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) out.push(first !== undefined && ts.isStringLiteralLike(first) ? first.text : "<dynamic>");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
};

/** Violations in one host file (`rel` is repository-relative, forward slashes). */
export function scanHostForWalkthrough(rel: string, text: string): string[] {
  const inAuthoring = rel.startsWith(AUTHORING_DIR);
  const found: string[] = [];
  for (const specifier of specifiersOf(text)) {
    if (specifier === "@dap/walkthrough" || specifier === "@dap/walkthrough/dom") found.push(`${rel}: ${specifier}`);
    else if (specifier === "@dap/walkthrough/authoring") { if (!inAuthoring) found.push(`${rel}: ${specifier} outside src/authoring`); }
    else if (specifier.startsWith("@dap/walkthrough/")) found.push(`${rel}: ${specifier} (unknown subpath)`);
    else if (/(^|\/)packages\/walkthrough(\/|$)/.test(specifier)) found.push(`${rel}: ${specifier} (deep path into the package)`);
    else if (specifier === "<dynamic>") found.push(`${rel}: a non-literal module load`);
  }
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

describe("who may import the validator subpath", () => {
  const files = filesUnder(HOST);
  it("the scan sees the host's sources and the authoring directory (the check is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((file) => file.startsWith(AUTHORING_DIR))).toBe(true);
  });
  it("every host file (tests included) passes: the subpath only inside src/authoring, the root specifier and /dom nowhere", () => {
    const violations = files.flatMap((rel) => scanHostForWalkthrough(rel, fs.readFileSync(path.join(ROOT, rel), "utf8")));
    expect(violations).toEqual([]);
  });
  it("the validator is really used from src/authoring (the subpath is not a dead export)", () => {
    const users = files.filter((rel) => specifiersOf(fs.readFileSync(path.join(ROOT, rel), "utf8")).includes("@dap/walkthrough/authoring"));
    expect(users.length).toBeGreaterThan(0);
    for (const user of users) expect(user.startsWith(AUTHORING_DIR), user).toBe(true);
  });
  it.each([
    ["the subpath inside src/authoring", `${AUTHORING_DIR}validate.ts`, 'import { createWalkthroughCatalog } from "@dap/walkthrough/authoring";', 0],
    ["the subpath as a type-only import inside src/authoring", `${AUTHORING_DIR}x.ts`, 'import type { WalkthroughDef } from "@dap/walkthrough/authoring";', 0],
    ["the subpath outside src/authoring", `${HOST}/http/transport.ts`, 'import { createWalkthroughCatalog } from "@dap/walkthrough/authoring";', 1],
    ["the subpath in the guidance code", `${HOST}/guidance/capability.ts`, 'export { isValidId } from "@dap/walkthrough/authoring";', 1],
    ["the root specifier inside src/authoring", `${AUTHORING_DIR}validate.ts`, 'import { createWalkthroughRuntime } from "@dap/walkthrough";', 1],
    ["the root specifier outside src/authoring", `${HOST}/compose.ts`, 'import "@dap/walkthrough";', 1],
    ["the DOM subpath inside src/authoring", `${AUTHORING_DIR}validate.ts`, 'import { x } from "@dap/walkthrough/dom";', 1],
    ["a dynamic import of the root", `${AUTHORING_DIR}validate.ts`, 'const m = await import("@dap/walkthrough");', 1],
    ["a require of the DOM subpath", `${HOST}/http/x.ts`, 'const m = require("@dap/walkthrough/dom");', 1],
    ["an unknown subpath", `${AUTHORING_DIR}validate.ts`, 'import { x } from "@dap/walkthrough/engine";', 1],
    ["a deep relative path into the package", `${AUTHORING_DIR}validate.ts`, 'import { x } from "../../../../packages/walkthrough/src/engine/runtime.js";', 1],
    ["a non-literal module load", `${AUTHORING_DIR}validate.ts`, "const m = await import(name);", 1],
    ["a mention in a comment or a string", `${AUTHORING_DIR}validate.ts`, '// import "@dap/walkthrough"\nexport const a = "@dap/walkthrough/dom";', 0],
  ])("planted: %s -> %i violation(s)", (_name, rel, code, count) => {
    expect(scanHostForWalkthrough(rel, code)).toHaveLength(count);
  });
});

describe("the subpath itself", () => {
  const entry = `${PKG}/src/authoring/index.ts`;
  function surface(file: string): string[] {
    const program = ts.createProgram([path.join(ROOT, file)], { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022, skipLibCheck: true, types: [] });
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(path.join(ROOT, file));
    const module = source && checker.getSymbolAtLocation(source);
    if (!module) throw new Error("the subpath surface was not resolved");
    return checker.getExportsOfModule(module).map((symbol) => symbol.name).sort();
  }
  it("exports exactly the intended names (values and types): the validator, the registry factory, the id check, the limits and the call types", () => {
    expect(surface(entry)).toEqual([
      "CompleteStep", "GuideStep", "MAX_ATTEMPTS_LIMIT", "MAX_DESCRIPTION", "MAX_LABEL", "MAX_TARGET_WAIT_MS", "MAX_TEXT", "MAX_TITLE", "NavigateStep", "PostconditionName",
      "SemanticElementDef", "SemanticOperation", "SemanticPrivacy", "SemanticRegistry", "SemanticRegistryInput", "SemanticRole", "Step", "StepId", "WaitKind", "WalkthroughCatalog",
      "WalkthroughCatalogError", "WalkthroughDef", "WalkthroughSummary", "createSemanticRegistry", "createWalkthroughCatalog", "isValidId",
    ]);
  });
  it("its import closure holds no runtime, state machine, ports, presenter, overlay, DOM, privacy projection or event bridge", () => {
    const seen = new Set<string>();
    const pending = [entry];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (seen.has(file)) continue;
      seen.add(file);
      for (const specifier of specifiersOf(fs.readFileSync(path.join(ROOT, file), "utf8"))) {
        expect(specifier.startsWith("."), `${file} imports ${specifier}: the subpath may import relative modules of the package only`).toBe(true);
        pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier.replace(/\.js$/, ".ts"))));
      }
    }
    const closure = [...seen].map((file) => file.slice(`${PKG}/src/`.length)).sort();
    expect(closure).toEqual(["authoring/index.ts", "semantic/registry.ts", "semantic/types.ts", "walkthrough/catalog.ts", "walkthrough/definition.ts"]);
    for (const file of closure) expect(file).not.toMatch(/^(engine|dom|privacy)\//);
  });
  it("the package manifest has exactly the three entry points, shaped alike (source condition, types, default)", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, PKG, "package.json"), "utf8")) as { exports: Record<string, Record<string, string>> };
    expect(Object.keys(manifest.exports)).toEqual([".", "./dom", "./authoring"]);
    expect(manifest.exports["./authoring"]).toEqual({ "@dap/source": "./src/authoring/index.ts", types: "./dist/authoring/index.d.ts", default: "./dist/authoring/index.js" });
    expect(Object.keys(manifest.exports["./authoring"]!)).toEqual(Object.keys(manifest.exports["./dom"]!));
  });
  it("the host declares the workspace dependency and the walkthrough package stays free of any dependency (a leaf)", () => {
    const host = JSON.parse(fs.readFileSync(path.join(ROOT, "apps/reference-host/package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(host.dependencies["@dap/walkthrough"]).toBe("*");
    const walkthrough = JSON.parse(fs.readFileSync(path.join(ROOT, PKG, "package.json"), "utf8")) as Record<string, unknown>;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) expect(walkthrough[field] ?? {}).toEqual({});
  });
});
