/**
 * tests/architecture/static-scan.test.ts
 *
 * T060. The AI, actions (executor), and security layers must not touch the
 * network or shell directly: no child_process, vm, node:http, node:https,
 * undici, axios, pg (outside the postgres state implementation), or global
 * fetch. The scan uses the TypeScript compiler API, not regex.
 *
 * - Production scan: every non-test .ts file under the three package src
 *   trees must be clean.
 * - Positive control: in-memory fixtures must each be flagged, and clean
 *   fixtures (including pg inside state/postgres and a locally declared
 *   `fetch`) must not be.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { assertCompilerApi, REQUIRED_COMPILER_API, scanSource, scanTree } from "./static-scan.js";
import type { StaticScanFinding, StaticScanKind } from "./static-scan.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every root, with one file that must be reachable, so an empty or mistyped root can never pass vacuously. */
const SCAN_ROOTS: ReadonlyArray<readonly [string, string]> = [
  ["packages/ai/src", "packages/ai/src/tool-call.ts"],
  ["packages/actions/src", "packages/actions/src/index.ts"],
  ["packages/security/src", "packages/security/src/gateway/pipeline.ts"],
];

describe("production scan: no forbidden modules or global fetch", () => {
  for (const [root, sentinel] of SCAN_ROOTS) {
    it(`is clean in ${root}`, () => {
      const { files, findings } = scanTree(REPO_ROOT, root);
      expect(files.length).toBeGreaterThan(0);
      expect(files).toContain(sentinel);
      expect(findings).toEqual([]);
    });
  }
});

describe("positive control: forbidden constructs are flagged", () => {
  const fixtures: Array<{
    label: string;
    file: string;
    code: string;
    kind: StaticScanKind;
    module?: string;
  }> = [
    {
      label: "static import of child_process",
      file: "packages/ai/src/probe.ts",
      code: 'import { execSync } from "child_process";\nexport const run = (): string => execSync("ls").toString();\n',
      kind: "forbidden-import",
      module: "child_process",
    },
    {
      label: "static import of node:child_process",
      file: "packages/ai/src/probe.ts",
      code: 'import { execSync } from "node:child_process";\nexport const run = (): string => execSync("ls").toString();\n',
      kind: "forbidden-import",
      module: "node:child_process",
    },
    {
      label: "static import of vm",
      file: "packages/actions/src/probe.ts",
      code: 'import * as vm from "vm";\nexport const run = vm.runInNewContext;\n',
      kind: "forbidden-import",
      module: "vm",
    },
    {
      label: "static import of node:vm",
      file: "packages/actions/src/probe.ts",
      code: 'import { runInNewContext } from "node:vm";\nexport const run = runInNewContext;\n',
      kind: "forbidden-import",
      module: "node:vm",
    },
    {
      label: "static import of node:http",
      file: "packages/security/src/probe.ts",
      code: 'import { createServer } from "node:http";\nexport const makeServer = createServer;\n',
      kind: "forbidden-import",
      module: "node:http",
    },
    {
      label: "static import of https",
      file: "packages/security/src/probe.ts",
      code: 'import * as https from "https";\nexport const get = https.get;\n',
      kind: "forbidden-import",
      module: "https",
    },
    {
      label: "static import of node:https",
      file: "packages/security/src/probe.ts",
      code: 'import { get } from "node:https";\nexport const fetchLike = get;\n',
      kind: "forbidden-import",
      module: "node:https",
    },
    {
      label: "static import of undici",
      file: "packages/ai/src/probe.ts",
      code: 'import { request } from "undici";\nexport const doRequest = request;\n',
      kind: "forbidden-import",
      module: "undici",
    },
    {
      label: "static import of axios",
      file: "packages/ai/src/probe.ts",
      code: 'import axios from "axios";\nexport const get = axios.get;\n',
      kind: "forbidden-import",
      module: "axios",
    },
    {
      label: "static import of pg outside state/postgres",
      file: "packages/security/src/probe.ts",
      code: 'import pg from "pg";\nexport const client = pg.Client;\n',
      kind: "forbidden-import",
      module: "pg",
    },
    {
      label: "dynamic import of child_process",
      file: "packages/ai/src/probe.ts",
      code: 'export async function load(): Promise<unknown> {\n  const mod = await import("child_process");\n  return mod;\n}\n',
      kind: "forbidden-import",
      module: "child_process",
    },
    {
      label: "require of vm",
      file: "packages/actions/src/probe.ts",
      code: 'export const vm = require("vm");\n',
      kind: "forbidden-import",
      module: "vm",
    },
    {
      label: "export-from undici",
      file: "packages/security/src/probe.ts",
      code: 'export { request } from "undici";\n',
      kind: "forbidden-import",
      module: "undici",
    },
    {
      label: "import-equals require of pg",
      file: "packages/security/src/probe.ts",
      code: 'import pg = require("pg");\nexport const client = pg.Client;\n',
      kind: "forbidden-import",
      module: "pg",
    },
    {
      label: "global fetch call",
      file: "packages/ai/src/probe.ts",
      code: 'export async function call(url: string): Promise<unknown> {\n  const res = await fetch(url);\n  return res.json();\n}\n',
      kind: "global-fetch",
    },
    {
      label: "global fetch used without await",
      file: "packages/ai/src/probe.ts",
      code: 'export const pending = fetch("https://example.test");\n',
      kind: "global-fetch",
    },
  ];

  for (const fixture of fixtures) {
    it(`flags ${fixture.label}`, () => {
      const findings = scanSource(fixture.file, fixture.code);
      expect(findings).toHaveLength(1);
      const finding = findings[0] as StaticScanFinding;
      expect(finding.kind).toBe(fixture.kind);
      if (fixture.module) expect(finding.module).toBe(fixture.module);
      expect(finding.file).toBe(fixture.file);
      expect(finding.line).toBeGreaterThanOrEqual(1);
    });
  }
});

describe("negative control: allowed constructs are not flagged", () => {
  const fixtures: Array<{ label: string; file: string; code: string }> = [
    {
      label: "pg inside state/postgres",
      file: "packages/security/src/state/postgres/probe.ts",
      code: 'import pg from "pg";\nexport const client = pg.Client;\n',
    },
    {
      label: "a locally declared fetch function",
      file: "packages/ai/src/probe.ts",
      code: 'export function fetch(url: string): string {\n  return url;\n}\nexport const use = fetch;\n',
    },
    {
      label: "fetch as a property access",
      file: "packages/ai/src/probe.ts",
      code: 'const client = { fetch: (url: string) => url };\nexport const run = client.fetch;\n',
    },
    {
      label: "fetch as a parameter",
      file: "packages/ai/src/probe.ts",
      code: 'export function run(fetch: (url: string) => string): string {\n  return fetch("https://example.test");\n}\n',
    },
    {
      label: "fetch destructured with a rename",
      file: "packages/ai/src/probe.ts",
      code: 'export function run(obj: { fetch: (url: string) => string }): string {\n  const { fetch: doFetch } = obj;\n  return doFetch("https://example.test");\n}\n',
    },
    {
      label: "ordinary contract and crypto imports",
      file: "packages/ai/src/probe.ts",
      code: 'import { randomUUID } from "node:crypto";\nimport type { ProposalCall } from "@dap/contracts";\nexport const id = (): string => randomUUID();\nexport const wrap = (raw: unknown, callId: string): ProposalCall => ({ callId, raw });\n',
    },
    {
      label: "fetch inside a string literal",
      file: "packages/ai/src/probe.ts",
      code: 'export const note = "no fetch here";\n',
    },
  ];

  for (const fixture of fixtures) {
    it(`allows ${fixture.label}`, () => {
      expect(scanSource(fixture.file, fixture.code)).toEqual([]);
    });
  }
});

const kinds = (code: string, file = "packages/ai/src/probe.ts"): StaticScanKind[] => [...new Set(scanSource(file, code).map((finding) => finding.kind))].sort();

describe("bypass attempts: module specifiers", () => {
  it.each([
    ["an aliased named import", 'import { request as secretly } from "node:http";\nexport const go = secretly;\n', "node:http"],
    ["a namespace import of net", 'import * as sock from "node:net";\nexport const go = sock;\n', "node:net"],
    ["a default import of tls", 'import tls from "tls";\nexport const go = tls;\n', "tls"],
    ["http2", 'import { connect } from "node:http2";\nexport const go = connect;\n', "node:http2"],
    ["a dns subpath", 'import { lookup } from "node:dns/promises";\nexport const go = lookup;\n', "node:dns/promises"],
    ["dgram", 'import dgram from "dgram";\nexport const go = dgram;\n', "dgram"],
    ["inspector", 'import inspector from "node:inspector";\nexport const go = inspector;\n', "node:inspector"],
    ["the module loader", 'import { createRequire } from "node:module";\nexport const go = createRequire;\n', "node:module"],
    ["a side-effect import", 'import "node:child_process";\n', "node:child_process"],
    ["an inline type modifier, which verbatimModuleSyntax still emits", 'import { type Pool } from "pg";\nexport type P = Pool;\n', "pg"],
    ["a pg subpath", 'import Client from "pg/lib/client";\nexport const go = Client;\n', "pg/lib/client"],
    ["an undici subpath", 'import { Agent } from "undici/types";\nexport const go = Agent;\n', "undici/types"],
    ["an axios subpath", 'import axios from "axios/dist/node/axios.cjs";\nexport const go = axios;\n', "axios/dist/node/axios.cjs"],
    ["pg-pool", 'import Pool from "pg-pool";\nexport const go = Pool;\n', "pg-pool"],
    ["export * from a forbidden module", 'export * from "node:vm";\n', "node:vm"],
    ["export * as from a forbidden module", 'export * as vm from "node:vm";\n', "node:vm"],
    ["a named re-export", 'export { request } from "node:https";\n', "node:https"],
    ["a require in a template literal", "export const vm = require(`child_process`);\n", "child_process"],
    ["a dynamic import in a template literal", "export const load = () => import(`node:vm`);\n", "node:vm"],
    ["a dynamic import with an options argument", 'export const load = () => import("node:vm", { with: {} });\n', "node:vm"],
    ["import-equals with export", 'export import vm = require("vm");\n', "vm"],
    ["getBuiltinModule with a literal", 'export const vm = process.getBuiltinModule("node:vm");\n', "node:vm"],
    ["an element-access getBuiltinModule with a literal", 'export const vm = process["getBuiltinModule"]("vm");\n', "vm"],
    ["require nested in an expression", 'export const run = (() => require("vm"))().runInNewContext;\n', "vm"],
  ])("flags %s", (_label, code, module) => {
    const findings = scanSource("packages/ai/src/probe.ts", code);
    expect(findings.map((finding) => [finding.kind, finding.module])).toEqual([["forbidden-import", module]]);
  });

  it.each([
    ["a concatenated require", 'export const vm = require("child_" + "process");\n'],
    ["a variable dynamic import", 'export const load = (name: string) => import(name);\n'],
    ["a template with a substitution", "export const load = (n: string) => import(`node:${n}`);\n"],
    ["a bare reference to require", 'const load = require;\nexport const vm = load("vm");\n'],
    ["a require with no argument", "export const x = require();\n"],
    ["getBuiltinModule with a variable", 'export const vm = (n: string) => process.getBuiltinModule(n);\n'],
    ["an element-access getBuiltinModule with a variable", 'export const vm = (n: string) => process["getBuiltinModule"](n);\n'],
  ])("cannot see through %s, so it fails closed", (_label, code) => {
    expect(kinds(code)).toContain("dynamic-module");
  });

  it("does not flag a type-only import or export, which emits nothing", () => {
    for (const code of [
      'import type { Pool } from "pg";\nexport type P = Pool;\n', 'import type pg from "pg";\nexport type P = pg.Pool;\n', 'import type * as vm from "node:vm";\nexport type V = typeof vm;\n',
      'export type { Server } from "node:http";\n', 'export type * from "node:http";\n', 'import type vm = require("vm");\nexport type V = typeof vm;\n',
    ]) expect(scanSource("packages/security/src/probe.ts", code), code).toEqual([]);
  });

  it("rests that on verbatimModuleSyntax, so the assumption cannot lapse silently", () => {
    const base = ts.readConfigFile(join(REPO_ROOT, "tsconfig.base.json"), ts.sys.readFile);
    expect((base.config as { compilerOptions: { verbatimModuleSyntax?: boolean } }).compilerOptions.verbatimModuleSyntax).toBe(true);
  });
});

describe("bypass attempts: pg is allowed only under state/postgres, anchored at the repository root", () => {
  const pg = 'import pg from "pg";\nexport const client = pg.Client;\n';
  it.each([
    "packages/security/src/state/postgres/tenant-policy.ts", "packages/security/src/state/postgres/nested/deeper/x.ts", "packages/security/src/state/postgres/x.mjs",
  ])("allows %s", (file) => { expect(scanSource(file, pg)).toEqual([]); });

  it.each([
    "packages/ai/src/packages/security/src/state/postgres/x.ts", "packages/security/src/state/postgres-evil/x.ts", "packages/security/src/state/postgresql/x.ts",
    "packages/security/src/state/conformance/postgres/x.ts", "packages/security/src/other/state/postgres/x.ts", "evil/packages/security/src/state/postgres/x.ts",
    "packages/security/src/state/postgres.ts", "packages/actions/src/state/postgres/x.ts",
  ])("flags %s", (file) => { expect(scanSource(file, pg).map((finding) => finding.kind)).toEqual(["forbidden-import"]); });

  it("anchors an absolute path at the given repository root, and refuses an absolute path without one", () => {
    const allowed = `${REPO_ROOT}/packages/security/src/state/postgres/x.ts`;
    expect(scanSource(allowed, pg, REPO_ROOT)).toEqual([]);
    expect(scanSource(allowed, pg).map((finding) => finding.kind)).toEqual(["forbidden-import"]);
    expect(scanSource(`${REPO_ROOT}/packages/ai/src/packages/security/src/state/postgres/x.ts`, pg, REPO_ROOT)).toHaveLength(1);
    expect(scanSource("/elsewhere/packages/security/src/state/postgres/x.ts", pg, REPO_ROOT)).toHaveLength(1);
  });

  it("uses forward and back slashes alike", () => {
    expect(scanSource("packages\\security\\src\\state\\postgres\\x.ts", pg)).toEqual([]);
    expect(scanSource("packages\\ai\\src\\state\\postgres\\x.ts", pg)).toHaveLength(1);
  });
});

describe("bypass attempts: reaching the network through the global object", () => {
  it.each([
    ["globalThis.fetch", "export const go = (u: string) => globalThis.fetch(u);\n"],
    ["window.fetch", "export const go = (u: string) => window.fetch(u);\n"],
    ["self.fetch", "export const go = (u: string) => self.fetch(u);\n"],
    ["global.fetch", "export const go = (u: string) => global.fetch(u);\n"],
    ["a computed string key", 'export const go = (u: string) => globalThis["fetch"](u);\n'],
    ["a cast globalThis", "export const go = (u: string) => (globalThis as unknown as { fetch: (u: string) => unknown }).fetch(u);\n"],
    ["a non-null globalThis", "export const go = (u: string) => globalThis!.fetch(u);\n"],
    ["optional chaining", "export const go = (u: string) => globalThis?.fetch?.(u);\n"],
    ["destructuring from globalThis", "const { fetch } = globalThis;\nexport const go = (u: string) => fetch(u);\n"],
    ["a renamed destructuring from globalThis", "const { fetch: f } = globalThis;\nexport const go = (u: string) => f(u);\n"],
    ["a local alias of the global fetch", "const fetch = globalThis.fetch;\nexport const go = (u: string) => fetch(u);\n"],
    ["a local alias that hides the call", "const f = globalThis.fetch;\nexport const go = (u: string) => f(u);\n"],
    ["an alias of the global object itself", "const g = globalThis;\nexport const go = (u: string) => g.fetch(u);\n"],
    ["Reflect.get on the global object", 'export const go = Reflect.get(globalThis, "fetch");\n'],
    ["an indirect string key", 'const key = "fet" + "ch";\nexport const go = (globalThis as Record<string, unknown>)[key];\n'],
    ["fetch in a template literal", "export const go = (u: string) => `${fetch(u)}`;\n"],
    ["fetch held in an array", "export const go = (u: string) => [fetch][0]?.(u);\n"],
    ["fetch as a shorthand property", "export const bag = { fetch };\n"],
    ["fetch with optional call", "export const go = (u: string) => fetch?.(u);\n"],
    ["fetch passed as an argument", "export const go = (use: (f: unknown) => void) => use(fetch);\n"],
    ["a typeof probe followed by a call", 'export const go = (u: string) => (typeof fetch === "function" ? fetch(u) : null);\n'],
  ])("flags %s", (_label, code) => {
    expect(scanSource("packages/ai/src/probe.ts", code).length, code).toBeGreaterThan(0);
  });

  it.each([
    ["new WebSocket", 'export const go = () => new WebSocket("wss://example.test");\n'], ["new XMLHttpRequest", "export const go = () => new XMLHttpRequest();\n"],
    ["new EventSource", 'export const go = () => new EventSource("https://example.test");\n'], ["globalThis.WebSocket", 'export const go = () => new globalThis.WebSocket("wss://x");\n'],
  ])("flags %s", (_label, code) => {
    expect(kinds(code)).toEqual(expect.arrayContaining([expect.stringMatching(/global-network|global-object/)]));
  });

  it.each([
    ["an as cast", "export const go = (globalThis as unknown as { fetch: unknown }).fetch;\n"], ["a non-null assertion", "export const go = globalThis!.fetch;\n"],
    ["a type assertion", "export const go = (<{ fetch: unknown }>(<unknown>globalThis)).fetch;\n"], ["satisfies", "export const go = (globalThis satisfies object).fetch;\n"],
    ["nested parentheses", "export const go = ((globalThis)).fetch;\n"], ["a string key", 'export const go = globalThis["fetch"];\n'],
    ["an optional string key", 'export const go = globalThis?.["fetch"];\n'], ["window", "export const go = window.fetch;\n"], ["self", "export const go = self.fetch;\n"], ["global", "export const go = global.fetch;\n"],
  ])("names the fetch kind through %s", (_label, code) => {
    expect(kinds(code)).toContain("global-fetch");
  });

  it.each([["a string key", 'export const go = () => new globalThis["WebSocket"]("wss://x");\n'], ["a cast", 'export const go = () => new (globalThis as { WebSocket: new (u: string) => unknown }).WebSocket("wss://x");\n']])("names the network kind through %s", (_label, code) => {
    expect(kinds(code)).toContain("global-network");
  });

  it("names the specific kind when the member is fetch", () => {
    expect(kinds("export const go = (u: string) => globalThis.fetch(u);\n")).toEqual(["global-fetch", "global-object"]);
    expect(kinds("const g = globalThis;\nexport const go = g;\n")).toEqual(["global-object"]);
  });

  it.each([
    ["a local binding named self", "export function run(): number {\n  const self = { n: 1 };\n  return self.n;\n}\n"],
    ["a parameter named window", "export const area = (window: { w: number; h: number }) => window.w * window.h;\n"],
    ["a local named global", "export function run(): number {\n  const global = { n: 1 };\n  return global.n;\n}\n"],
    ["a property that is named like a global", "export const read = (o: { window: number; self: number; global: number; globalThis: number }) => o.window + o.self + o.global + o.globalThis;\n"],
    ["the words in a string and a comment", '// globalThis.fetch is not used here\nexport const note = "globalThis window self global";\n'],
    ["an object key", "export const options = { window: 1, self: 2, globalThis: 3 };\n"],
    ["a method named fetch", "export class Repo {\n  fetch(id: string): string { return id; }\n}\nexport const read = (r: Repo) => r.fetch('x');\n"],
    ["a function parameter shadowing fetch", "export const run = (fetch: (u: string) => string) => fetch('x');\n"],
    ["an imported local fetch", 'import { fetch } from "./local-repo.js";\nexport const run = () => fetch("x");\n'],
    ["a destructured rename from a local object", "export const run = (o: { fetch: (u: string) => string }) => { const { fetch: get } = o; return get('x'); };\n"],
    ["an interface member", "export interface Repo { fetch(id: string): string }\n"],
  ])("does not flag %s", (_label, code) => {
    expect(scanSource("packages/ai/src/probe.ts", code), code).toEqual([]);
  });
});

afterEach(() => { vi.doUnmock("typescript"); });

describe("bypass attempts: loader indirection, dynamic code, remote specifiers, shadowing by declarations that emit nothing", () => {
  it.each([
    ["destructuring getBuiltinModule", 'const { getBuiltinModule } = process;\nexport const vm = getBuiltinModule("vm");\n'],
    ["aliasing getBuiltinModule", 'const load = process.getBuiltinModule;\nexport const vm = load("vm");\n'],
    ["getBuiltinModule.call", 'export const vm = process.getBuiltinModule.call(process, "vm");\n'],
    ["getBuiltinModule.bind", 'export const load = process.getBuiltinModule.bind(process);\n'],
    ["a renamed destructuring", 'const { getBuiltinModule: g } = process;\nexport const vm = g("child_process");\n'],
    ["a string-keyed destructuring", 'const { "getBuiltinModule": g } = process;\nexport const vm = g("vm");\n'],
    ["process.mainModule.require", 'export const cp = process.mainModule!.require("child_process");\n'],
    ["module.require", 'export const cp = module.require("child_process");\n'],
    ["process.binding", 'export const spawn = process.binding("spawn_sync");\n'],
    ["a computed process.binding", 'export const spawn = process["binding"]("spawn_sync");\n'],
    ["process.dlopen", "export const load = process.dlopen;\n"],
    ["destructuring binding from process", "const { binding } = process;\nexport const b = binding;\n"],
    ["an alias of process", 'const p = process;\nexport const spawn = p.binding("spawn_sync");\n'],
    ["a computed key on process", 'export const x = (k: string) => (process as unknown as Record<string, unknown>)[k];\n'],
  ])("flags %s", (_label, code) => {
    expect(scanSource("packages/ai/src/probe.ts", code).length, code).toBeGreaterThan(0);
  });

  it.each([
    ["a parenthesized callee", 'export const vm = (process.getBuiltinModule)("vm");\n', "vm"],
    ["a template-literal key", 'export const vm = process[`getBuiltinModule`]("vm");\n', "vm"],
    ["a non-null callee", 'export const vm = process.getBuiltinModule!("node:vm");\n', "node:vm"],
  ])("still names the module through %s", (_label, code, module) => {
    expect(scanSource("packages/ai/src/probe.ts", code).map((finding) => [finding.kind, finding.module])).toEqual([["forbidden-import", module]]);
  });

  it.each([
    ["eval", 'export const run = (s: string) => eval(s);\n'], ["an indirect eval", 'export const run = (s: string) => (0, eval)(s);\n'],
    ["new Function", 'export const make = (s: string) => new Function(s);\n'], ["Function called", 'export const make = (s: string) => Function(s);\n'],
    ["an aliased eval", "const e = eval;\nexport const run = e;\n"], ["Function reached through the global object", 'export const make = (s: string) => globalThis.Function(s);\n'],
    ["a constructor call", 'export const make = (s: string) => (() => 1).constructor(s)();\n'], ["a constructor construct", 'export const make = (s: string) => new (class {}).constructor(s);\n'],
    ["a computed constructor call", 'export const make = (s: string) => (() => 1)["constructor"](s);\n'],
  ])("flags dynamic code through %s", (_label, code) => {
    expect(kinds(code), code).toEqual(expect.arrayContaining([expect.stringMatching(/dynamic-code|global-object/)]));
  });

  it.each([
    ["a method that is merely named eval", "export const run = (o: { eval(s: string): string }) => o.eval('x');\n"],
    ["words that contain eval or Function", 'export const evaluate = (s: string) => s; export const functionName = "Function eval";\n'],
    ["a local Function binding", "export const make = (Function: (s: string) => string) => Function('x');\n"],
    ["Function as a type", "export type Callback = Function;\nexport const f = (c: Callback) => c;\n"],
    ["reading constructor.name", "export const name = (o: object) => o.constructor.name;\n"],
    ["a safe process member", 'export const v = () => process.version;\n'],
    ["a safe computed process member", 'export const v = () => process["env"];\n'],
    ["a local named module", "export const read = () => { const module = { n: 1 }; return module.n; };\n"],
  ])("does not flag %s", (_label, code) => {
    expect(scanSource("packages/ai/src/probe.ts", code), code).toEqual([]);
  });

  it.each(["worker_threads", "node:worker_threads", "cluster", "execa", "node-fetch", "ws", "got", "ky", "superagent", "cross-spawn", "shelljs", "vm2", "isolated-vm", "node-pty", "needle"])(
    "flags %s", (module) => {
      expect(scanSource("packages/ai/src/probe.ts", `import x from "${module}";\nexport const go = x;\n`).map((finding) => [finding.kind, finding.module])).toEqual([["forbidden-import", module]]);
    });

  it.each([
    'import "data:text/javascript,import(\'node:vm\')";\n', 'import x from "https://cdn.example.test/x.js";\nexport const go = x;\n', 'import x from "http://localhost/x.js";\nexport const go = x;\n',
    'import x from "file:///etc/x.js";\nexport const go = x;\n', 'export const load = () => import("data:text/javascript,export default 1");\n', 'import x from "blob:https://x/y";\nexport const go = x;\n',
    'import x from "../../../node_modules/undici/index.js";\nexport const go = x;\n', 'import x from "./node_modules/axios/index.js";\nexport const go = x;\n',
    'import x from "../../node_modules/pg/lib/index.js";\nexport const go = x;\n',
  ])("flags the remote or out-of-tree specifier in %s", (code) => {
    expect(kinds(code), code).toEqual(["forbidden-import"]);
  });

  it("allows ordinary relative, node: and package specifiers", () => {
    for (const specifier of ["./local.js", "../registry/build-registry.js", "node:crypto", "node:perf_hooks", "node:path", "zod", "@dap/contracts", "@dap/contracts/mint", "fast-check"]) {
      expect(scanSource("packages/security/src/gateway/probe.ts", `import x from "${specifier}";\nexport const go = x;\n`), specifier).toEqual([]);
    }
  });

  it.each([
    ["an ambient const", "declare const fetch: (u: string) => Promise<unknown>;\nexport const go = (u: string) => fetch(u);\n"],
    ["an ambient function", "declare function fetch(u: string): Promise<unknown>;\nexport const go = (u: string) => fetch(u);\n"],
    ["a type-only import", 'import type { fetch } from "./x.js";\nexport const go = (u: string) => fetch(u);\n'],
    ["an inline type-only import", 'import { type fetch } from "./x.js";\nexport const go = (u: string) => fetch(u);\n'],
    ["a type-only namespace import", 'import type * as fetch from "./x.js";\nexport const go = (u: string) => fetch(u);\n'],
    ["a type-only default import", 'import type fetch from "./x.js";\nexport const go = (u: string) => fetch(u);\n'],
    ["an ambient self", "declare const self: { fetch(u: string): Promise<unknown> };\nexport const go = (u: string) => self.fetch(u);\n"],
  ])("is not fooled into treating %s as a local binding", (_label, code) => {
    expect(scanSource("packages/ai/src/probe.ts", code).length, code).toBeGreaterThan(0);
  });
});

describe("false positives on realistic production code, and the next layer of bypasses", () => {
  it.each([
    ["a for-of variable named module", "export function run(modules: string[]): number {\n  let n = 0;\n  for (const module of modules) { n += module.length; }\n  return n;\n}\n"],
    ["a for-of variable named self", "export function run(xs: number[]): number {\n  let n = 0;\n  for (const self of xs) { n += self; }\n  return n;\n}\n"],
    ["a for loop variable named window", "export function run(): number {\n  let n = 0;\n  for (let window = 0; window < 3; window += 1) { n += window; }\n  return n;\n}\n"],
    ["a for-in variable named global", "export function run(o: object): string[] {\n  const out: string[] = [];\n  for (const global in o) { out.push(global); }\n  return out;\n}\n"],
    ["a switch case declaration", "export function run(x: number): number {\n  switch (x) {\n    case 1: { const window = 1; return window; }\n    default: { const self = 2; return self; }\n  }\n}\n"],
    ["an unbraced switch case declaration", "export function run(x: number): number {\n  switch (x) {\n    case 1:\n      const window = 1;\n      return window;\n    default:\n      return 0;\n  }\n}\n"],
    ["a getter named self", "export class A {\n  get self(): number { return 1; }\n  set value(self: number) { void self; }\n}\n"],
    ["enum members named like globals", "export enum E { self, global, window }\nexport const e = E.self;\n"],
    ["a label named self", "export function run(): number {\n  self: for (;;) { break self; }\n  return 1;\n}\n"],
    ["a class declared in a block", "export function run(): number {\n  class fetch { n = 1; }\n  return new fetch().n;\n}\n"],
    ["a namespace named like a global", "export namespace self { export const x = 1; }\nexport const y = self.x;\n"],
    ["a declaration inside a namespace body", "export namespace Box {\n  const window = 1;\n  export const w = window;\n}\n"],
    ["typeof fetch in a type", "export type FetchLike = typeof fetch;\n"],
    ["a WebSocket annotation", "export const socket: WebSocket | null = null;\nexport let events: EventSource | undefined;\n"],
    ["a qualified typeof", "export type G = typeof globalThis.fetch;\n"],
    ["instanceof Function", "export const isFn = (v: unknown): boolean => v instanceof Function;\n"],
    ["Function.prototype", "export const call = Function.prototype.call;\n"],
    ["a Function type predicate", "export const isFn = (v: unknown): v is Function => typeof v === 'function';\n"],
    ["reading constructor.name", "export const name = (o: object): string => o.constructor.name;\n"],
    ["an overload with an implementation", "export function pick(a: string): string;\nexport function pick(a: number): number;\nexport function pick(a: string | number): string | number { return a; }\n"],
  ])("does not flag %s", (_label, code) => {
    expect(scanSource("packages/ai/src/probe.ts", code), code).toEqual([]);
  });

  it.each([
    ["an aliased constructor", "export const F = (async () => {}).constructor;\n"], ["a tagged-template constructor", "export const f = (() => 1).constructor`return 1`;\n"],
    ["a destructured constructor", "export const { constructor: F } = (() => 1);\n"], ["a computed constructor read", 'export const F = (() => 1)["constructor"];\n'],
    ["a constructor passed on", "export const run = (use: (f: unknown) => void) => use((() => 1).constructor);\n"], ["a class extending Function", "export class Callable extends Function {}\n"],
    ["Function aliased", "export const F = Function;\n"], ["Function passed on", "export const run = (use: (f: unknown) => void) => use(Function);\n"],
  ])("flags dynamic code through %s", (_label, code) => {
    expect(kinds(code), code).toContain("dynamic-code");
  });

  it.each([
    ["a bodiless function declaration", "function fetch(u: string): Promise<unknown>;\nexport const go = (u: string) => fetch(u);\n"],
    ["an overload list with no implementation", "function fetch(u: string): Promise<unknown>;\nfunction fetch(u: number): Promise<unknown>;\nexport const go = (u: string) => fetch(u);\n"],
  ])("is not fooled into treating %s as a local binding", (_label, code) => {
    expect(kinds(code), code).toContain("global-fetch");
  });

  it.each([
    "../../../apps/server/http-client.js", "../../testkit/src/net.js", "../../../packages/security/src/x.js", "../../../../outside/x.js", "./../../actions/src/x.js",
    "../.././../apps/x.js",
  ])("flags the relative specifier %s, which leaves the scanned package tree", (specifier) => {
    expect(scanSource("packages/ai/src/gateway/probe.ts", `import x from "${specifier}";\nexport const go = x;\n`).map((finding) => [finding.kind, finding.module])).toEqual([["forbidden-import", specifier]]);
  });

  it.each([
    ["packages/ai/src/probe.ts", "./local.js"], ["packages/ai/src/gateway/probe.ts", "../planner-port.js"], ["packages/ai/src/gateway/deep/probe.ts", "../../tool-call.js"],
    ["packages/security/src/gateway/probe.ts", "../registry/build-registry.js"], ["packages/ai/src/probe.ts", "./a/b/../c.js"],
  ])("allows %s importing %s, which stays inside its own package", (file, specifier) => {
    expect(scanSource(file, `import x from "${specifier}";\nexport const go = x;\n`)).toEqual([]);
  });

  it("applies the escape rule to dynamic and re-exported specifiers too", () => {
    expect(kinds('export const load = () => import("../../../apps/x.js");\n').sort()).toEqual(["forbidden-import"]);
    expect(kinds('export * from "../../../apps/x.js";\n')).toEqual(["forbidden-import"]);
    expect(kinds('export const x = require("../../../apps/x.js");\n')).toEqual(["forbidden-import"]);
  });
});

describe("third round: node:process, constructor idioms, heritage clauses and type-level names", () => {
  it.each([
    ["a default import of node:process", 'import process from "node:process";\nexport const b = process.binding("spawn_sync");\n', "node:process"],
    ["a namespace import of process", 'import * as proc from "process";\nexport const b = proc;\n', "process"],
    ["a named getBuiltinModule from node:process", 'import { getBuiltinModule } from "node:process";\nexport const cp = getBuiltinModule("child_process");\n', "node:process"],
    ["a named dlopen from node:process", 'import { dlopen } from "node:process";\nexport const d = dlopen;\n', "node:process"],
    ["a dynamic import of node:process", 'export const load = () => import("node:process");\n', "node:process"],
  ])("flags %s", (_label, code, module) => {
    expect(scanSource("packages/ai/src/probe.ts", code).map((finding) => [finding.kind, finding.module])).toEqual([["forbidden-import", module]]);
  });

  it.each([
    ["a static-member access through this.constructor", "export class Base {\n  static registry = 1;\n  read(): number { return (this.constructor as typeof Base).registry; }\n}\n"],
    ["a plain-object check", "export const isPlain = (v: object): boolean => v.constructor === Object;\n"],
    ["a negated plain-object check", "export const notPlain = (v: object): boolean => v.constructor !== Object;\n"],
    ["a loose comparison", "export const same = (a: object, b: object): boolean => a.constructor == b.constructor;\n"],
    ["an instanceof against a constructor", "export const sameKind = (a: object, b: object): boolean => a instanceof (b.constructor as new () => object);\n"],
    ["a typeof probe", 'export const callable = (v: { constructor?: unknown }): boolean => typeof v.constructor === "function";\n'],
    ["an assignment to constructor", "export class A { constructor() { (this as { constructor: unknown }).constructor = A; } }\n"],
    ["reading constructor.prototype", "export const proto = (o: object): object => o.constructor.prototype;\n"],
    ["reading constructor.name through an optional chain", "export const name = (o?: object): string | undefined => o?.constructor.name;\n"],
    ["a class constructor declaration", "export class A {\n  constructor(readonly n: number) {}\n}\n"],
  ])("does not flag %s", (_label, code) => {
    expect(scanSource("packages/ai/src/probe.ts", code), code).toEqual([]);
  });

  it.each([
    ["constructor.call", 'export const F = (f: () => void) => f.constructor.call(null, "return 1");\n'],
    ["constructor.apply", 'export const F = (f: () => void) => f.constructor.apply(null, ["return 1"]);\n'],
    ["constructor.bind", "export const F = (f: () => void) => f.constructor.bind(null);\n"],
    ["constructor.constructor", 'export const F = (f: () => void) => f.constructor.constructor("return 1");\n'],
    ["a computed constructor.call", 'export const F = (f: () => void) => f["constructor"]["call"](null, "x");\n'],
    ["a returned constructor", "export const F = (f: () => void) => f.constructor;\n"],
    ["an alias", "export const F = (f: () => void) => { const g = f.constructor; return g; };\n"],
  ])("still flags %s", (_label, code) => {
    expect(kinds(code), code).toContain("dynamic-code");
  });

  it.each([
    ["an interface extending a global class", "export interface S extends EventSource { extra: number }\n"],
    ["a class implementing Function", "export class C implements Function {\n  apply = () => 1;\n}\n"],
    ["a class implementing a global type", "export class C implements WebSocket {}\n"],
    ["a type parameter named like a global", "export function f<self>(x: self): self { return x; }\n"],
    ["a named tuple member", "export type T = [fetch: number, window: string];\n"],
  ])("does not flag %s: it emits nothing", (_label, code) => {
    expect(scanSource("packages/ai/src/probe.ts", code), code).toEqual([]);
  });

  it("still flags a class that really extends a watched global at runtime", () => {
    expect(kinds("export class Callable extends Function {}\n")).toContain("dynamic-code");
    expect(kinds("export class Sock extends WebSocket {}\n")).toContain("global-network");
  });
});

describe("fourth round: namespaces, assignment destructuring, process casts, this.constructor and exported names", () => {
  it.each([
    ["a type-only namespace", "namespace fetch { export type T = 1 }\nexport const r = (u: string) => fetch(u);\n"],
    ["an interface-only namespace", "namespace self { export interface I { n: number } }\nexport const r = (u: string) => self.fetch(u);\n"],
    ["a nested type-only namespace", "namespace fetch { export namespace inner { export type T = 1 } }\nexport const r = (u: string) => fetch(u);\n"],
    ["an ambient namespace", "declare namespace fetch { const x: number }\nexport const r = (u: string) => fetch(u);\n"],
    ["a dotted type-only namespace", "namespace fetch.inner { export type T = 1 }\nexport const r = (u: string) => fetch(u);\n"],
  ])("is not fooled by %s, which emits nothing", (_label, code) => {
    expect(scanSource("packages/ai/src/probe.ts", code).length, code).toBeGreaterThan(0);
  });

  it.each([
    ["an instantiated namespace", "namespace fetch { export const x = 1 }\nexport const r = fetch.x;\n"],
    ["a namespace with a function", "namespace self { export function f(): number { return 1; } }\nexport const r = self.f();\n"],
    ["a namespace with an enum", "namespace window { export enum E { A } }\nexport const r = window.E.A;\n"],
    ["a nested instantiated namespace", "namespace self { export namespace inner { export const y = 1 } }\nexport const r = self.inner.y;\n"],
    ["a dotted instantiated namespace", "namespace self.inner { export const y = 1 }\nexport const r = self.inner.y;\n"],
  ])("still treats %s as a local binding", (_label, code) => {
    expect(scanSource("packages/ai/src/probe.ts", code), code).toEqual([]);
  });

  it.each([
    ["assignment destructuring", "let F: unknown;\nexport const go = (fn: object) => { ({ constructor: F } = fn); return F; };\n"],
    ["assignment destructuring with a computed literal key", 'let F: unknown;\nexport const go = (fn: object) => { ({ ["constructor"]: F } = fn); return F; };\n'],
    ["shorthand assignment destructuring", "let constructor: unknown;\nexport const go = (fn: object) => { ({ constructor } = fn); return constructor; };\n"],
    ["a computed literal key in a declaration", 'export const go = (fn: object) => { const { ["constructor"]: F } = fn; return F; };\n'],
    ["a quoted key in a declaration", 'export const go = (fn: object) => { const { "constructor": F } = fn; return F; };\n'],
  ])("flags .constructor reached through %s", (_label, code) => {
    expect(kinds(code), code).toContain("dynamic-code");
  });

  it.each([
    ["a cast", "export const env = () => (process as NodeJS.Process).env;\n"], ["a non-null assertion", "export const env = () => process!.env;\n"],
    ["parentheses", "export const env = () => (process).env;\n"], ["a typeof guard", 'export const hasProcess = (): boolean => typeof process !== "undefined";\n'],
    ["a typeof guard on a member", 'export const hasEnv = (): boolean => typeof process.env === "object";\n'], ["a computed safe member", 'export const v = () => (process as NodeJS.Process)["version"];\n'],
  ])("allows process through %s", (_label, code) => {
    expect(scanSource("packages/ai/src/probe.ts", code), code).toEqual([]);
  });

  it.each([
    ["a cast alias", "export const p = process as unknown as Record<string, unknown>;\n"], ["a cast loader member", 'export const b = (process as NodeJS.Process & { binding: (n: string) => unknown }).binding("fs");\n'],
    ["a non-null alias", "export const p = process!;\n"],
  ])("still flags process through %s", (_label, code) => {
    expect(kinds(code), code).toContain("dynamic-module");
  });

  it.each([
    ["new this.constructor", "export class A {\n  clone(): A { return new (this.constructor as new () => A)(); }\n}\n"],
    ["a this.constructor alias", "export class A {\n  static make(): number { return 1; }\n  run(): number { const C = this.constructor as typeof A; return C.make(); }\n}\n"],
    ["this.constructor passed on", "export class A {\n  register(use: (c: unknown) => void): void { use(this.constructor); }\n}\n"],
  ])("does not flag %s: a class instance's constructor is its class", (_label, code) => {
    expect(scanSource("packages/ai/src/probe.ts", code), code).toEqual([]);
  });

  it("still flags a call on a non-this constructor, and a class that really extends Function", () => {
    expect(kinds('export const make = (f: () => void) => new (f.constructor as new (s: string) => () => void)("return 1");\n')).toContain("dynamic-code");
    expect(kinds("export class C extends Function { m(): unknown { return new (this.constructor as new () => unknown)(); } }\n")).toContain("dynamic-code");
  });

  it.each([
    ["a namespace re-export named process", 'export * as process from "./process.js";\n'], ["named module", 'export * as module from "./m.js";\n'], ["named self", 'export * as self from "./s.js";\n'],
    ["named fetch", 'export * as fetch from "./f.js";\n'], ["a class expression's own name", "export const A = class fetch { x = (): unknown => fetch; };\n"],
    ["an import-equals alias", 'import fetch = require("./local.js");\nexport const r = (u: string) => fetch(u);\n'],
  ])("does not flag %s as a use of the global", (_label, code) => {
    expect(scanSource("packages/ai/src/probe.ts", code), code).toEqual([]);
  });
});

describe("fifth round: process.process and a local require", () => {
  it.each([
    ["process.process.binding", 'export const b = process.process.binding("spawn_sync");\n'], ['a string-keyed process.process', 'export const b = process["process"].dlopen;\n'],
    ["a cast process.process", 'export const b = (process as NodeJS.Process).process.mainModule;\n'], ["a bare process.process", "export const p = process.process;\n"],
  ])("flags %s", (_label, code) => {
    expect(kinds(code), code).toContain("dynamic-module");
  });

  it.each([
    ["a function named require", "export function require(condition: unknown, message: string): asserts condition {\n  if (!condition) throw new Error(message);\n}\nexport const check = (x: unknown): void => require(x !== undefined, 'missing');\n"],
    ["a parameter named require", "export const run = (require: (ok: boolean) => void, x: unknown): void => require(x !== undefined);\n"],
    ["a const named require", "const require = (ok: boolean): boolean => ok;\nexport const run = (x: unknown): boolean => require(x !== undefined);\n"],
  ])("does not mistake %s for a module load", (_label, code) => {
    expect(scanSource("packages/ai/src/probe.ts", code), code).toEqual([]);
  });

  it("still flags the real require, and one with a literal forbidden specifier even next to a local helper", () => {
    expect(kinds("export const x = (n: string) => require(n);\n")).toContain("dynamic-module");
    expect(scanSource("packages/ai/src/probe.ts", 'export const vm = require("vm");\n').map((finding) => finding.module)).toEqual(["vm"]);
  });
});

describe("failing loudly", () => {
  it("reports a file the compiler cannot parse instead of silently scanning half of it", () => {
    const findings = scanSource("packages/ai/src/broken.ts", 'import { exec } from "node:child_process";\nexport const = ;\nexport function (\n');
    expect(findings.map((finding) => finding.kind)).toContain("unparseable");
    expect(scanSource("packages/ai/src/ok.ts", "export const fine = 1;\n")).toEqual([]);
  });

  it("reports 1-based lines for findings on later lines", () => {
    const findings = scanSource("packages/ai/src/probe.ts", '\n\nexport const a = 1;\nimport { request } from "node:http";\n\nexport const b = fetch;\n');
    expect(findings.map((finding) => [finding.kind, finding.line])).toEqual([["forbidden-import", 4], ["global-fetch", 6]]);
  });

  it("refuses to run on a TypeScript API that lacks a node kind or guard the scan depends on", () => {
    expect(() => assertCompilerApi(ts)).not.toThrow();
    for (const name of REQUIRED_COMPILER_API.functions) {
      expect(() => assertCompilerApi({ ...ts, [name]: undefined } as unknown as typeof ts), name).toThrow(name);
    }
    for (const name of REQUIRED_COMPILER_API.syntaxKinds) {
      const kinds = { ...ts.SyntaxKind } as Record<string, unknown>;
      delete kinds[name];
      expect(() => assertCompilerApi({ ...ts, SyntaxKind: kinds } as unknown as typeof ts), name).toThrow(name);
    }
    expect(() => assertCompilerApi({} as typeof ts)).toThrow();
  });

  it("refuses at import time to load against a TypeScript that lacks a required guard", async () => {
    vi.resetModules();
    vi.doMock("typescript", () => ({ default: { ...ts, isImportEqualsDeclaration: undefined } }));
    try {
      await expect(import("./static-scan.js")).rejects.toThrow(/isImportEqualsDeclaration/);
    } finally {
      vi.doUnmock("typescript");
      vi.resetModules();
    }
  });

  it("lists every compiler API the scan uses and uses every one it lists, in both directions", () => {
    const text = readFileSync(join(REPO_ROOT, "tests/architecture/static-scan.ts"), "utf8");
    // Drop comments and string literals so prose never counts as use.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/`(?:[^`\\]|\\.)*`/g, "``").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
    const functionsUsed = new Set([...code.matchAll(/\bts\.([a-z]\w*)\b/g)].map((match) => match[1] as string));
    const memberUsed = new Map<string, Set<string>>();
    for (const [, enumName, member] of code.matchAll(/\bts\.([A-Z]\w*)\.(\w+)\b/g)) {
      memberUsed.set(enumName as string, (memberUsed.get(enumName as string) ?? new Set()).add(member as string));
    }
    expect([...functionsUsed].sort()).toEqual([...REQUIRED_COMPILER_API.functions].sort());
    expect([...(memberUsed.get("SyntaxKind") ?? [])].sort()).toEqual([...REQUIRED_COMPILER_API.syntaxKinds].sort());
    const enumsUsed = Object.fromEntries([...memberUsed].filter(([name]) => name !== "SyntaxKind").map(([name, members]) => [name, [...members].sort()]));
    expect(enumsUsed).toEqual(Object.fromEntries(Object.entries(REQUIRED_COMPILER_API.enums).map(([name, members]) => [name, [...members].sort()])));
  });

  it("also refuses a TypeScript whose enums or source-file methods the scan relies on are missing", () => {
    for (const [name, members] of Object.entries(REQUIRED_COMPILER_API.enums)) {
      expect(() => assertCompilerApi({ ...ts, [name]: undefined } as unknown as typeof ts), name).toThrow(name);
      for (const member of members) {
        const trimmed = { ...(ts as unknown as Record<string, Record<string, unknown>>)[name] };
        delete trimmed[member];
        expect(() => assertCompilerApi({ ...ts, [name]: trimmed } as unknown as typeof ts), `${name}.${member}`).toThrow(member);
      }
    }
    const withoutLineMethod = { ...ts, createSourceFile: (...args: Parameters<typeof ts.createSourceFile>) => Object.assign(ts.createSourceFile(...args), { getLineAndCharacterOfPosition: undefined }) };
    expect(() => assertCompilerApi(withoutLineMethod as unknown as typeof ts)).toThrow(/getLineAndCharacterOfPosition/);
  });
});

describe("walking the tree", () => {
  const withTree = (build: (root: string) => void, check: (root: string) => void): void => {
    const root = mkdtempSync(join(tmpdir(), "static-scan-"));
    try { build(root); check(root); } finally { rmSync(root, { recursive: true, force: true }); }
  };
  const put = (root: string, relative: string, text: string): void => {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), text);
  };
  const vm = 'import { runInNewContext } from "node:vm";\nexport const run = runInNewContext;\n';

  it.each(["x.ts", "x.mts", "x.cts", "x.tsx", "x.js", "x.mjs", "x.cjs", "x.jsx", "x.test-support.ts", "deep/er/x.ts"])("scans %s as production code", (name) => {
    const jsx = /\.[tj]sx$/.test(name);
    withTree((root) => put(root, `packages/ai/src/${name}`, jsx ? `${vm}export const view = <div>{run.name}</div>;\n` : vm), (root) => {
      const { files, findings } = scanTree(root, "packages/ai/src");
      expect(files).toEqual([`packages/ai/src/${name}`]);
      // The forbidden import is reported, and a JSX file is neither flagged as unparseable nor skipped.
      expect(findings.map((finding) => finding.kind)).toEqual(["forbidden-import"]);
    });
  });

  it("skips tests and declaration files only", () => {
    withTree((root) => {
      for (const name of ["a.test.ts", "a.test.mts", "a.test.js", "a.d.ts", "a.d.mts", "a.json", "a.md", "a.txt"]) put(root, `packages/ai/src/${name}`, vm);
      put(root, "packages/ai/src/prod.ts", "export const fine = 1;\n");
    }, (root) => {
      const { files, findings } = scanTree(root, "packages/ai/src");
      expect(files).toEqual(["packages/ai/src/prod.ts"]);
      expect(findings).toEqual([]);
    });
  });

  it("reports relative file paths and applies the pg allow-list against the repository root", () => {
    withTree((root) => {
      put(root, "packages/security/src/state/postgres/ok.ts", 'import pg from "pg";\nexport const c = pg;\n');
      put(root, "packages/security/src/state/other.ts", 'import pg from "pg";\nexport const c = pg;\n');
    }, (root) => {
      const { findings } = scanTree(root, "packages/security/src");
      expect(findings.map((finding) => finding.file)).toEqual(["packages/security/src/state/other.ts"]);
    });
  });

  it("fails loudly on a missing or empty scan root, and on symbolic links", () => {
    withTree(() => undefined, (root) => {
      expect(() => scanTree(root, "packages/ai/src")).toThrow();
      mkdirSync(join(root, "packages/ai/src"), { recursive: true });
      expect(() => scanTree(root, "packages/ai/src")).toThrow(/no source files/);
    });
    withTree((root) => {
      put(root, "packages/ai/src/real.ts", "export const fine = 1;\n");
      put(root, "elsewhere/vm.ts", vm);
      symlinkSync(join(root, "elsewhere/vm.ts"), join(root, "packages/ai/src/link.ts"));
    }, (root) => {
      expect(() => scanTree(root, "packages/ai/src")).toThrow(/symbolic link/);
    });
  });
});
