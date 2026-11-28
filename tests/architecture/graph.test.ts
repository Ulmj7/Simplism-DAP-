/**
 * T059 (ATK-ARCH-01, ATK-ARCH-05, ATK-ARCH-06): the dependency graph and the workspace manifests. Complements contracts-boundary.test.ts (the
 * mint and deep-import edges in every import form) and module-loaders.test.ts / static-scan.test.ts (eval, Function, module loaders).
 *
 * 1. The real repository's graph has no violation, and the rule set has not lost a rule.
 * 2. Every workspace manifest declares exactly the @dap edges plan.md allows (the reference host, a production composition root, does not declare the testkit).
 * 3. In a disposable workspace, each forbidden edge is a violation of the rule that names it, each allowed edge is none, and a cycle is one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import * as ts from "typescript";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cruiseBin = path.join(ROOT, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs");

interface Graph { modules: { source: string; dependencies: { couldNotResolve: boolean; resolved: string; module?: string }[] }[]; summary: { violations: { from: string; to: string; rule: { name: string } }[] } }
function cruise(cwd: string): Graph {
  const result = spawnSync(process.execPath, [cruiseBin, "--config", "dependency-cruiser.config.cjs", "--output-type", "json", "packages", "apps"], { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  expect(result.error).toBeUndefined();
  expect([0, 1], result.stderr).toContain(result.status);
  return JSON.parse(result.stdout) as Graph;
}

/** Every module reachable from the modules under `prefix` by following resolved imports (direct or transitive), the starting modules included. */
function reachableFrom(graph: Graph, prefix: string): ReadonlySet<string> {
  const byName = new Map(graph.modules.map((module) => [module.source, module]));
  const seen = new Set<string>();
  const pending = graph.modules.filter((module) => module.source.startsWith(prefix)).map((module) => module.source);
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    for (const dependency of byName.get(next)?.dependencies ?? []) pending.push(dependency.resolved);
  }
  return seen;
}
const MINT_ENTRY = "packages/contracts/src/mint/index.ts";
/** What the AI layer may reach at all among the workspace's own modules (node built-ins and external libraries are not packages of ours): itself and the contracts' public root with whatever the root re-exports. Executors (actions), the Gateway (security), the mint entry, the testkit and the apps are not on the list. */
const outsideAiBoundary = (reached: ReadonlySet<string>): string[] => [...reached].filter((source) => /^(packages|apps)\//.test(source)).filter((source) => !source.startsWith("packages/ai/") && !source.startsWith("packages/contracts/src/") || source === MINT_ENTRY).sort();

/** Guard implementations may use private registries; no runtime value from the mint tree may be PUBLICLY re-exported. */
function publicMintExports(cwd: string): string[] {
  const root = path.join(cwd, "packages/contracts/src/index.ts");
  const program = ts.createProgram([root], { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022, skipLibCheck: true, types: [] });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(root);
  const module = source && checker.getSymbolAtLocation(source);
  if (!module) throw new Error("Contracts public surface was not resolved");
  return checker.getExportsOfModule(module).filter((exported) => {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    return Boolean(symbol.flags & ts.SymbolFlags.Value) && (symbol.declarations ?? []).some((declaration) =>
      path.relative(cwd, declaration.getSourceFile().fileName).startsWith("packages/contracts/src/mint/"));
  }).map((symbol) => symbol.name).sort();
}

/** plan.md "Allowed dependency edges", as manifest dependencies. */
const ALLOWED_MANIFEST_EDGES: Readonly<Record<string, readonly string[]>> = {
  "packages/browser-runtime": [],
  "packages/contracts": [],
  "packages/ai": ["@dap/contracts"],
  "packages/actions": ["@dap/contracts"],
  "packages/security": ["@dap/contracts"],
  "packages/testkit": ["@dap/contracts", "@dap/security", "@dap/ai"],
  "apps/reference-host": ["@dap/contracts", "@dap/ai", "@dap/actions", "@dap/security", "@dap/walkthrough", "@dap/browser-runtime"], // Feature 004: @dap/walkthrough only through the pure `/authoring` subpath (tests/architecture/authoring-boundary.test.ts)
  // Feature 002: a leaf package and its demo app. The detailed rules are in tests/architecture/walkthrough-boundary.test.ts.
  "packages/walkthrough": [],
};
const RULES = ["browser-runtime-leaf", "browser-runtime-only-in-host", "browser-runtime-only-in-studio", "ai-not-to-security-or-actions", "actions-not-to-ai-or-security", "security-not-to-ai-or-actions", "contracts-leaf", "testkit-allowed-edges", "production-not-to-testkit", "nothing-imports-apps", "no-deep-imports-into-contracts", "mint-entry-restricted", "no-runtime-module-loaders", "no-circular", "walkthrough-leaf", "walkthrough-not-imported-by-trusted-packages"];

describe("the real repository", () => {
  const graph = cruise(ROOT);
  it("has no forbidden edge", () => {
    expect(graph.summary.violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`)).toEqual([]);
    expect(graph.modules.length).toBeGreaterThan(100);
  });
  it("still has every rule of the boundary configuration", () => {
    const config = (JSON.parse(spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(require('./dependency-cruiser.config.cjs').forbidden.map((rule) => rule.name)))"], { cwd: ROOT, encoding: "utf8" }).stdout) as string[]);
    expect(config.sort()).toEqual([...RULES].sort());
  });
  it("resolves every workspace import it follows (an unresolved edge could hide a violation)", () => {
    const unresolved = graph.modules.flatMap((module) => module.dependencies.filter((dep) => dep.couldNotResolve).map(() => module.source));
    expect(unresolved).toEqual([]);
  });
});

describe("the AI layer has no path to executors, the mint entry or the Gateway's internals (ATK-ARCH-01, 05)", () => {
  const graph = cruise(ROOT);
  const reached = reachableFrom(graph, "packages/ai/");
  it("follows the real import graph, transitively: everything the AI layer can reach is the AI layer itself or the contracts' public root and what it re-exports", () => {
    expect([...reached].filter((source) => source.startsWith("packages/ai/")).length, "the walk starts inside the AI layer").toBeGreaterThan(0);
    expect([...reached].some((source) => source.startsWith("packages/contracts/src/")), "and it does follow the edge into contracts (a vacuous walk would pass anything)").toBe(true);
    expect(outsideAiBoundary(reached)).toEqual([]);
  });
  it("the contracts root cannot expose a private mint value through an alias, namespace or star re-export", () => {
    expect(publicMintExports(ROOT)).toEqual([]);
  });
  it("never reaches packages/actions (the executors), packages/security (the Gateway and the minters), the testkit, an app, or the mint entry", () => {
    for (const forbidden of ["packages/actions/", "packages/security/", "packages/testkit/", "apps/", MINT_ENTRY]) expect([...reached].filter((source) => source.startsWith(forbidden)), forbidden).toEqual([]);
  });
  it("is stated by the graph itself: the AI layer's own modules have no resolved import into any of them either", () => {
    const direct = graph.modules.filter((module) => module.source.startsWith("packages/ai/")).flatMap((module) => module.dependencies.map((dependency) => dependency.resolved));
    expect(direct.filter((target) => /^(packages\/(actions|security|testkit)|apps)\//.test(target) || target === MINT_ENTRY)).toEqual([]);
  });
  it("the only way the AI layer meets the Gateway is the type of the submit surface in contracts: no AI module names a Gateway factory or a minter", () => {
    const sources = fs.readdirSync(path.join(ROOT, "packages/ai/src")).filter((name) => name.endsWith(".ts")).map((name) => fs.readFileSync(path.join(ROOT, "packages/ai/src", name), "utf8")).join("\n");
    expect(sources).not.toMatch(/createPolicyGateway|bindExecutors|mintContext|mintGrant|registerGrant|registerContext/);
    expect(sources).not.toMatch(/@dap\/(security|actions|testkit)|@dap\/contracts\/mint/);
  });
  it("is proven able to fail: the same walk over a graph with a planted AI -> mint edge, and one through an intermediate module, reports them", () => {
    const planted: Graph = {
      summary: { violations: [] },
      modules: [
        { source: "packages/ai/src/a.ts", dependencies: [{ couldNotResolve: false, resolved: "packages/ai/src/b.ts" }] },
        { source: "packages/ai/src/b.ts", dependencies: [{ couldNotResolve: false, resolved: "packages/contracts/src/index.ts" }] },
        { source: "packages/contracts/src/index.ts", dependencies: [{ couldNotResolve: false, resolved: MINT_ENTRY }] },
        { source: MINT_ENTRY, dependencies: [] },
      ],
    };
    expect(outsideAiBoundary(reachableFrom(planted, "packages/ai/"))).toEqual([MINT_ENTRY]);
    planted.modules[1]!.dependencies.push({ couldNotResolve: false, resolved: "packages/security/src/gateway/create-gateway.ts" });
    planted.modules.push({ source: "packages/security/src/gateway/create-gateway.ts", dependencies: [] });
    expect(outsideAiBoundary(reachableFrom(planted, "packages/ai/"))).toEqual([MINT_ENTRY, "packages/security/src/gateway/create-gateway.ts"]);
  });
});

/** The reference host (T131, T136): a production composition root. */
const APP = "apps/reference-host/";
/** Edges the host must never have, from the resolved graph: test infrastructure and the mint entry. (The graph leaves out external libraries, so `pg` is checked on the specifiers below.) */
function forbiddenAppEdges(graph: Graph): string[] {
  return graph.modules.filter((module) => module.source.startsWith(APP)).flatMap((module) => module.dependencies
    .filter((dependency) => dependency.resolved.startsWith("packages/testkit/") || dependency.module === "@dap/testkit" || dependency.resolved === MINT_ENTRY)
    .map((dependency) => `${module.source} -> ${dependency.module ?? dependency.resolved}`));
}
/** Every module specifier the TypeScript scanner finds in a source text: static, type-only, re-export, dynamic import() and require(). */
const specifiersOf = (text: string): string[] => ts.preProcessFile(text, true, true).importedFiles.map((imported) => imported.fileName);
/** The database driver is reachable only through @dap/security (pools come from createPostgresPool): the host's sources must not name it. */
const driverImports = (files: Readonly<Record<string, string>>): string[] => Object.entries(files).flatMap(([file, text]) => specifiersOf(text).filter((name) => name === "pg" || name.startsWith("pg/") || name === "node:pg").map((name) => `${file} -> ${name}`));
const appSources = (): Record<string, string> => {
  const found: Record<string, string> = {};
  const walk = (dir: string): void => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (entry.name.endsWith(".ts")) found[path.relative(ROOT, full)] = fs.readFileSync(full, "utf8"); } };
  walk(path.join(ROOT, APP, "src"));
  return found;
};
/** The app's production modules (its own unit tests are not wiring) that import a package, by their resolved edge into it. */
const appImportersOf = (graph: Graph, prefix: string): string[] => graph.modules.filter((module) => module.source.startsWith(APP) && !module.source.endsWith(".test.ts") && module.dependencies.some((dependency) => dependency.resolved.startsWith(prefix))).map((module) => module.source).sort();

/** The exported names of a module, and the property names of an exported type, as the TypeScript checker sees them. */
function surface(file: string): { exports: string[]; members: (name: string) => string[] } {
  const program = ts.createProgram([file], { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022, skipLibCheck: true, types: [], customConditions: ["@dap/source"] });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  const module = source && checker.getSymbolAtLocation(source);
  if (!module) throw new Error("The surface of the reference host was not resolved");
  const exported = checker.getExportsOfModule(module);
  return {
    exports: exported.map((symbol) => symbol.name).sort(),
    members: (name) => {
      const symbol = exported.find((candidate) => candidate.name === name);
      if (!symbol) throw new Error(`${name} is not exported`);
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      return checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(target)).map((property) => property.name).sort();
    },
  };
}

describe("the reference host (T131, T136): its AI-facing handle is a submit function and nothing else", () => {
  const graph = cruise(ROOT);
  it("has modules in the graph, and no edge into the testkit or the mint entry, and no import of the database driver", () => {
    expect(graph.modules.filter((module) => module.source.startsWith(APP)).length, "the check is not vacuous").toBeGreaterThan(5);
    expect(forbiddenAppEdges(graph)).toEqual([]);
    expect(Object.keys(appSources()).length, "the scan sees the host's sources").toBeGreaterThan(5);
    expect(driverImports(appSources())).toEqual([]);
  });
  it("is proven able to fail: a planted host -> testkit and host -> mint edge, and a pg import in every form, are each reported", () => {
    const planted: Graph = { summary: { violations: [] }, modules: [{ source: `${APP}src/a.ts`, dependencies: [
      { couldNotResolve: false, resolved: "packages/testkit/src/world.ts", module: "@dap/testkit" }, { couldNotResolve: false, resolved: MINT_ENTRY, module: "@dap/contracts/mint" },
      { couldNotResolve: false, resolved: "packages/security/src/index.ts", module: "@dap/security" } ] }] };
    expect(forbiddenAppEdges(planted)).toHaveLength(2);
    expect(driverImports({ "a.ts": 'import { Pool } from "pg";', "b.ts": 'import type { Pool } from "pg";', "c.ts": 'export * from "pg";', "d.ts": 'const p = import("pg");', "e.ts": 'const p = require("pg/lib");', "f.ts": 'import { ok } from "./pg-like.js"; import "@dap/security";' })).toHaveLength(5);
  });
  it("limits host imports of security and AI to the composition, configuration, and guidance and platform modules that use them", () => {
    expect(appImportersOf(graph, "packages/security/")).toEqual([`${APP}src/authoring/pool.ts`, `${APP}src/compose.ts`, `${APP}src/config.ts`, `${APP}src/guidance/compose-guidance.ts`, `${APP}src/platform/public-api.ts`, `${APP}src/platform/routes.ts`]);
    // Feature 003: the trusted guidance modules (src/guidance/) use the AI package's pure parsing, chunking, validation and result helpers; they import no other trusted package
    // (compose-guidance injects the scrubber; the capability and its executor use the contracts only). C01: the browser transport (src/http/transport.ts) reuses the same pure
    // Feature 003 helpers (query cap, context parser, fixed unsupported messages) so the wire layer re-defines no schema; nothing else under src/http imports the AI package.
    expect(appImportersOf(graph, "packages/ai/")).toEqual([`${APP}src/compose.ts`, `${APP}src/guidance/anthropic-model.ts`, `${APP}src/guidance/capability.ts`, `${APP}src/guidance/compose-guidance.ts`, `${APP}src/guidance/demo-model.ts`, `${APP}src/guidance/demo-render.ts`, `${APP}src/guidance/knowledge-loader.ts`, `${APP}src/guidance/start-bridge.ts`, `${APP}src/guidance/walkthrough-summaries.ts`, `${APP}src/http/transport.ts`, `${APP}src/platform/public-api.ts`, `${APP}src/platform/routes.ts`]);
    expect(appImportersOf(graph, "packages/actions/")).toEqual([]);
  });
  it("Feature 003 Slice 3 / Feature 004: no production module of the host imports the walkthrough runtime or the testkit; the ONLY walkthrough edge is the pure validator subpath, from src/authoring/ alone (the starter is a structural interface the composition root fills)", () => {
    const walkthroughImporters = appImportersOf(graph, "packages/walkthrough/");
    expect(walkthroughImporters.filter((source) => !source.startsWith(`${APP}src/authoring/`))).toEqual([]);
    const targets = new Set(graph.modules.filter((module) => walkthroughImporters.includes(module.source)).flatMap((module) => module.dependencies.map((dependency) => dependency.resolved).filter((resolved) => resolved.startsWith("packages/walkthrough/"))));
    expect([...targets]).toEqual(["packages/walkthrough/src/authoring/index.ts"]);
    expect(appImportersOf(graph, "packages/testkit/")).toEqual([]);
  });
  it("nothing reaches the host from the AI layer (the transitive walk above already excludes apps/): the AI layer is handed the submit function and cannot name the host", () => {
    expect([...reachableFrom(graph, "packages/ai/")].filter((source) => source.startsWith("apps/"))).toEqual([]);
  });
  const host = surface(path.join(ROOT, "apps/reference-host/src/index.ts"));
  it("the host's public exports are exactly the composition function, the configuration and dev-auth entry points and the demo's trusted-view types: no registry, executor table, store, pool, audit reader, mint API or confirmation service", () => {
    expect(host.exports).toEqual(["AiSession", "ComposeOptions", "ComposedHost", "ConfigError", "DEMO_ACTION_IDS", "DevAuthError", "DevSession", "Effect", "Environment", "HostConfig", "HostExtension", "ReceivedCall", "ReferenceHost", "TrustedHandle", "composeReferenceHost", "loadConfig"]);
  });
  it("the type the AI layer receives has exactly one member, `submit`; the host side has exactly openSession and close; the trusted view and the composition result are separate objects", () => {
    expect(host.members("AiSession")).toEqual(["submit"]);
    expect(host.members("ReferenceHost")).toEqual(["close", "openSession"]);
    expect(host.members("TrustedHandle")).toEqual(["effects", "executorCalls", "receivedCalls"]);
    expect(host.members("ComposedHost")).toEqual(["host", "trusted"]);
  });
  it("limits extensions to definitions and executors and composition options to extensions and trusted identity", () => {
    expect(host.members("HostExtension")).toEqual(["definitions", "executors"]);
    expect(host.members("ComposeOptions")).toEqual(["extensions", "identity"]);
  });
});

describe("workspace manifests", () => {
  const manifest = (dir: string) => JSON.parse(fs.readFileSync(path.join(ROOT, dir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  it.each(Object.entries(ALLOWED_MANIFEST_EDGES))("%s declares only the @dap packages it may use", (dir, allowed) => {
    const m = manifest(dir);
    const declared = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((field) => Object.keys(m[field] ?? {})).filter((name) => name.startsWith("@dap/"));
    expect(declared.filter((name) => !allowed.includes(name))).toEqual([]);
  });
  it("lists exactly the workspaces the table knows, so a new package cannot slip past it", () => {
    const dirs = ["packages", "apps"].flatMap((group) => fs.readdirSync(path.join(ROOT, group)).filter((name) => fs.existsSync(path.join(ROOT, group, name, "package.json"))).map((name) => `${group}/${name}`));
    expect(dirs.sort()).toEqual(Object.keys(ALLOWED_MANIFEST_EDGES).sort());
  });
  it("keeps the AI layer's reach to contracts only, and nothing production-side on testkit", () => {
    // Feature 003 added `zod` (validation of untrusted model output); the workspace reach stays contracts only.
    expect(Object.keys(manifest("packages/ai").dependencies ?? {}).filter((name) => name.startsWith("@dap/"))).toEqual(["@dap/contracts"]);
    for (const dir of ["packages/contracts", "packages/ai", "packages/actions", "packages/security"]) {
      for (const field of ["dependencies", "devDependencies", "peerDependencies"]) expect(Object.keys(manifest(dir)[field] ?? {}), `${dir} ${field}`).not.toContain("@dap/testkit");
    }
  });
});

describe("planted edges in a disposable workspace", () => {
  let workspace: string;
  const PACKAGES = ["contracts", "ai", "actions", "security", "testkit"] as const;
  const dirOf = (name: string) => (name === "reference-host" ? "apps/reference-host" : `packages/${name}`);
  /** [from, to, rule that must name it, or null when the edge is allowed] */
  const EDGES: [string, string, string | null][] = [
    ["reference-host", "testkit", "production-not-to-testkit"],
    ["ai", "security", "ai-not-to-security-or-actions"], ["ai", "actions", "ai-not-to-security-or-actions"],
    ["actions", "ai", "actions-not-to-ai-or-security"], ["actions", "security", "actions-not-to-ai-or-security"],
    ["security", "ai", "security-not-to-ai-or-actions"], ["security", "actions", "security-not-to-ai-or-actions"],
    ["contracts", "ai", "contracts-leaf"], ["contracts", "actions", "contracts-leaf"], ["contracts", "security", "contracts-leaf"], ["contracts", "testkit", "contracts-leaf"], ["contracts", "reference-host", "contracts-leaf"],
    ["testkit", "actions", "testkit-allowed-edges"], ["testkit", "reference-host", "testkit-allowed-edges"],
    ["ai", "testkit", "production-not-to-testkit"], ["actions", "testkit", "production-not-to-testkit"], ["security", "testkit", "production-not-to-testkit"], ["contracts", "testkit", "production-not-to-testkit"],
    ["ai", "reference-host", "nothing-imports-apps"], ["actions", "reference-host", "nothing-imports-apps"], ["security", "reference-host", "nothing-imports-apps"], ["testkit", "reference-host", "nothing-imports-apps"],
    ["ai", "contracts", null], ["actions", "contracts", null], ["security", "contracts", null], ["testkit", "contracts", null], ["testkit", "security", null], ["testkit", "ai", null],
  ];
  const planted = EDGES.map(([from, to, rule], index) => ({ file: `${dirOf(from)}/src/planted_${index}.ts`, from, to, rule }));
  let graph: Graph;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(tmpdir(), "dap-graph-"));
    expect(path.relative(ROOT, workspace).startsWith("..")).toBe(true);
    const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true }); fs.writeFileSync(path.join(workspace, file), text); };
    for (const file of ["package.json", "tsconfig.base.json", "dependency-cruiser.config.cjs"]) fs.copyFileSync(path.join(ROOT, file), path.join(workspace, file));
    for (const name of [...PACKAGES, "reference-host"]) {
      const dir = dirOf(name);
      fs.mkdirSync(path.join(workspace, dir), { recursive: true });
      fs.copyFileSync(path.join(ROOT, dir, "package.json"), path.join(workspace, dir, "package.json"));
      put(`${dir}/src/index.ts`, "export const marker = 1;\n");
    }
    fs.mkdirSync(path.join(workspace, "node_modules/@dap"), { recursive: true });
    for (const name of fs.readdirSync(path.join(ROOT, "node_modules"))) if (!name.startsWith(".") && name !== "@dap") fs.symlinkSync(path.join(ROOT, "node_modules", name), path.join(workspace, "node_modules", name), "junction");
    for (const name of PACKAGES) fs.symlinkSync(path.join(workspace, dirOf(name)), path.join(workspace, "node_modules/@dap", name), "junction");
    // The app has no package entry to import by name, so edges into it are written as the relative path a developer would type.
    const specifier = (file: string, to: string) => (to === "reference-host" ? path.posix.relative(path.posix.dirname(file), "apps/reference-host/src/index.ts").replace(/\.ts$/, ".js") : `@dap/${to}`);
    for (const { file, to } of planted) put(file, `import { marker } from ${JSON.stringify(specifier(file, to))};\nexport const planted = marker;\n`);
    // The AI layer reaching the mint entry: contracts exposes it as a subpath, so it resolves in the workspace too.
    put("packages/contracts/src/mint/index.ts", "export const mintMarker = 1;\n");
    put("packages/ai/src/planted_mint.ts", 'import { mintMarker } from "@dap/contracts/mint";\nexport const plantedMint = mintMarker;\n');
    // Real re-exports and every supported edge form, independent of the directly planted mint import.
    put("packages/contracts/src/index.ts", 'export const marker = 1; export interface Marker { value: string }\nexport * from "./bridge.js";\nexport { mintContext as constructIdentity } from "./mint/context-registry.js";\n');
    put("packages/contracts/src/bridge.ts", 'export * from "./mint/index.js";\n');
    put("packages/contracts/src/mint/context-registry.ts", 'export function mintContext() { return {}; }\n');
    for (const [name, code] of Object.entries({
      reexport: 'export * from "@dap/contracts";',
      types: 'import type { Marker } from "@dap/contracts"; export type Alias = Marker;',
      dynamic: 'export const pending = import("@dap/contracts");',
      require: 'export const loaded = require("@dap/contracts");',
    })) put(`packages/ai/src/form_${name}.ts`, `${code}\n`);
    // A two-file cycle inside the AI layer.
    put("packages/ai/src/cycle_a.ts", 'import { b } from "./cycle_b.js";\nexport const a = () => b;\n');
    put("packages/ai/src/cycle_b.ts", 'import { a } from "./cycle_a.js";\nexport const b = () => a;\n');
    graph = cruise(workspace);
  });
  afterAll(() => { if (workspace) fs.rmSync(workspace, { recursive: true, force: true }); });

  it("keeps every fixture outside the working repository", () => {
    expect(path.relative(ROOT, workspace).startsWith(`..${path.sep}`) || path.isAbsolute(path.relative(ROOT, workspace))).toBe(true);
  });

  it("resolves each planted edge (an unresolved one would be a vacuous pass)", () => {
    for (const { file, to } of planted) {
      const dependencies = graph.modules.find((module) => module.source === file)?.dependencies ?? [];
      expect(dependencies.length, file).toBeGreaterThan(0);
      expect(dependencies.some((dep) => dep.couldNotResolve), file).toBe(false);
      expect(dependencies[0]!.resolved, file).toContain(dirOf(to));
    }
  });

  it.each(planted.map((item) => [`${item.from} -> ${item.to}`, item] as const))("%s", (_label, item) => {
    const rules = graph.summary.violations.filter((violation) => violation.from === item.file).map((violation) => violation.rule.name);
    if (item.rule === null) expect(rules).toEqual([]);
    else expect(rules).toContain(item.rule);
  });

  it("ai -> @dap/contracts/mint is a violation of mint-entry-restricted, and the transitive reach walk of the AI layer names the mint entry", () => {
    const dependencies = graph.modules.find((module) => module.source === "packages/ai/src/planted_mint.ts")?.dependencies ?? [];
    expect(dependencies.map((dependency) => [dependency.couldNotResolve, dependency.resolved])).toEqual([[false, MINT_ENTRY]]);
    expect(graph.summary.violations.filter((violation) => violation.from === "packages/ai/src/planted_mint.ts").map((violation) => violation.rule.name)).toContain("mint-entry-restricted");
    expect(outsideAiBoundary(reachableFrom(graph, "packages/ai/"))).toContain(MINT_ENTRY);
  });

  it.each(["reexport", "types", "dynamic", "require"])("follows a real %s edge through the contracts re-export chain", (form) => {
    const entry = `packages/ai/src/form_${form}.ts`;
    const dependencies = graph.modules.find((module) => module.source === entry)?.dependencies;
    expect(dependencies).toBeDefined();
    expect(dependencies!.map((dependency) => [dependency.couldNotResolve, dependency.resolved])).toEqual([[false, "packages/contracts/src/index.ts"]]);
    expect(outsideAiBoundary(reachableFrom(graph, entry))).toContain(MINT_ENTRY);
  });
  it("an aliased private constructor and a star-exported mint value cannot hide behind the public root", () => {
    expect(publicMintExports(workspace)).toEqual(["constructIdentity", "mintMarker"]);
  });

  it("a cycle between two modules is a violation", () => {
    expect(graph.summary.violations.some((violation) => violation.rule.name === "no-circular" && violation.from.startsWith("packages/ai/src/cycle_"))).toBe(true);
  });
});
