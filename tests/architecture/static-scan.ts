/**
 * tests/architecture/static-scan.ts
 *
 * T060 / FR-050 / ATK-ARCH-10. Static scan of production sources using the TypeScript compiler API
 * (no regex on source text). It is a tripwire for the code review of an honest contributor, not a
 * sandbox: it cannot stop an author who is determined to hide a capability, which is why the runtime
 * boundary (no executor without a grant, no network port) is the real defence. Per file it reports:
 *
 * - forbidden-import: any static import, export-from, import-equals, dynamic `import("...")`,
 *   `require("...")` or `process.getBuiltinModule("...")` of child_process, vm, http, https, http2,
 *   net, tls, dgram, dns, inspector, repl, module, undici, axios (bare or `node:`-prefixed, with or
 *   without a subpath), or pg and its pool/native packages anywhere outside
 *   packages/security/src/state/postgres. Static `import type` / `export type` are NOT findings: they
 *   emit nothing, which the repository guarantees with `verbatimModuleSyntax` (a test pins that),
 *   whereas an inline `import { type X }` still emits a side-effect import and IS a finding.
 * - dynamic-module: a module load whose specifier is not a literal, a bare reference to `require`, `module`
 *   or `process`, an alias of `process.getBuiltinModule`, or `process.binding` / `dlopen` / `mainModule`,
 *   because the scan cannot see what they load (fail closed). `process.<member>` for any other member is fine.
 * - global-fetch / global-network: a reference to the global `fetch`, `WebSocket`, `XMLHttpRequest` or
 *   `EventSource` that does not resolve to a local binding, including `globalThis.fetch`.
 * - dynamic-code: `eval`, the `Function` constructor (any use but `x instanceof Function` and
 *   `Function.prototype`), or a function's `.constructor` used for anything but comparing, type-testing,
 *   assigning to, or inspecting it (`.name`, `.prototype`); aliasing it, calling it, or following it with
 *   `.call`/`.apply`/`.bind`/`.constructor` is a finding. None of this is needed by a production capability
 *   and each of it reaches every other capability.
 * - global-object: any reference to `globalThis`, `global`, `window` or `self` that is not a local
 *   binding. No production code needs the global object, and every alias of it (`const g = globalThis`,
 *   `const { fetch } = globalThis`, `const fetch = globalThis.fetch`) passes through such a reference.
 * - unparseable: the compiler reports a syntax error, so the rest of the scan cannot be trusted.
 *
 * Names used only as TYPES (`x: WebSocket`, `typeof fetch`, `implements Function`) emit nothing and are not
 * findings. Known limits, by design of a denylist: computed keys (`fn["con" + "structor"]`), `var` hoisted out of a
 * nested block, and code reached through a package the denylist does not name.
 *
 * The scan refuses to run (throws at import time) if the installed TypeScript lacks a node kind or
 * guard it relies on, instead of silently matching nothing.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";

export type StaticScanKind = "forbidden-import" | "dynamic-module" | "dynamic-code" | "global-fetch" | "global-network" | "global-object" | "unparseable";

export interface StaticScanFinding {
  /** The path as given to the scan (relative to the repository root for a tree scan). */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  readonly kind: StaticScanKind;
  /** Module specifier as written, for forbidden-import findings. */
  readonly module?: string;
}

/** Every TypeScript API the scan calls. Kept next to the code; a test proves the list matches the usage. */
export const REQUIRED_COMPILER_API = {
  functions: [
    "createSourceFile", "transpileModule", "forEachChild",
    "isImportDeclaration", "isExportDeclaration", "isImportEqualsDeclaration", "isExternalModuleReference", "isCallExpression", "isStringLiteral",
    "isNoSubstitutionTemplateLiteral", "isIdentifier", "isPropertyAccessExpression", "isElementAccessExpression", "isParenthesizedExpression",
    "isAsExpression", "isNonNullExpression", "isTypeAssertionExpression", "isSatisfiesExpression", "isPropertyAssignment", "isMethodDeclaration",
    "isMethodSignature", "isPropertyDeclaration", "isPropertySignature", "isImportSpecifier", "isExportSpecifier", "isImportClause",
    "isVariableDeclaration", "isBindingElement", "isFunctionDeclaration", "isFunctionExpression", "isArrowFunction", "isParameter", "isCatchClause",
    "isClassDeclaration", "isClassExpression", "isEnumDeclaration", "isTypeAliasDeclaration", "isModuleDeclaration",
    "isQualifiedName", "isConstructorDeclaration", "isBlock", "isSourceFile", "isVariableStatement", "isNamedImports", "isNamespaceImport",
    "isTypeReferenceNode", "isTypeQueryNode", "isBinaryExpression", "isObjectBindingPattern", "isForStatement", "isForInStatement",
    "isForOfStatement", "isVariableDeclarationList", "isCaseClause", "isDefaultClause", "isModuleBlock", "isGetAccessorDeclaration",
    "isSetAccessorDeclaration", "isEnumMember", "isLabeledStatement", "isBreakStatement", "isContinueStatement", "isTypeOfExpression",
    "isExpressionWithTypeArguments", "isHeritageClause", "isTypeParameterDeclaration", "isNamedTupleMember", "isNamespaceExport", "isObjectLiteralExpression",
    "isComputedPropertyName", "isShorthandPropertyAssignment", "isInterfaceDeclaration",
  ],
  syntaxKinds: [
    "ImportKeyword", "ExternalModuleReference", "DeclareKeyword", "InstanceOfKeyword", "ImplementsKeyword", "EqualsToken", "EqualsEqualsToken",
    "EqualsEqualsEqualsToken", "ExclamationEqualsToken", "ExclamationEqualsEqualsToken", "ThisKeyword",
  ],
  /** Other enums the scan reads: name -> members. */
  enums: { ScriptTarget: ["ES2022"], ModuleKind: ["ESNext"], JsxEmit: ["Preserve"], DiagnosticCategory: ["Error"] },
} as const;

/** Throws, naming the missing entry, unless `api` provides everything the scan depends on. */
export function assertCompilerApi(api: typeof ts): void {
  const missing: string[] = [];
  const table = api as unknown as Record<string, unknown> | undefined;
  for (const name of REQUIRED_COMPILER_API.functions) {
    if (typeof table?.[name] !== "function") missing.push(name);
  }
  const kinds = table?.SyntaxKind as Record<string, unknown> | undefined;
  for (const name of REQUIRED_COMPILER_API.syntaxKinds) {
    if (typeof kinds?.[name] !== "number") missing.push(`SyntaxKind.${name}`);
  }
  for (const [enumName, members] of Object.entries(REQUIRED_COMPILER_API.enums)) {
    const values = table?.[enumName] as Record<string, unknown> | undefined;
    if (values === undefined || values === null || typeof values !== "object") { missing.push(enumName); continue; }
    for (const member of members) if (typeof values[member] !== "number") missing.push(`${enumName}.${member}`);
  }
  // Methods the scan calls on the nodes it is given, not on the `ts` namespace.
  if (typeof table?.createSourceFile === "function") {
    try {
      const sample = (api.createSourceFile as typeof ts.createSourceFile)("probe.ts", "", ts.ScriptTarget.ES2022, true);
      if (typeof (sample as unknown as Record<string, unknown>).getLineAndCharacterOfPosition !== "function") missing.push("SourceFile.getLineAndCharacterOfPosition");
    } catch { missing.push("createSourceFile"); }
  }
  if (missing.length > 0) throw new Error(`static-scan: the installed TypeScript lacks ${missing.join(", ")}; the scan cannot be trusted`);
}
assertCompilerApi(ts);

/** Bare module names (after dropping `node:` and any subpath) that grant a network, shell or script capability. */
const FORBIDDEN_MODULES: ReadonlySet<string> = new Set([
  "child_process", "vm", "http", "https", "http2", "net", "tls", "dgram", "dns", "inspector", "repl", "module", "worker_threads", "cluster",
  // `node:process` re-exports process.binding / dlopen / getBuiltinModule as bare names the member rules never see.
  "process",
  // The usual third-party routes to the same capabilities. A denylist is never complete: a new dependency is reviewed by a human.
  "undici", "axios", "node-fetch", "ws", "got", "ky", "superagent", "needle", "execa", "cross-spawn", "shelljs", "vm2", "isolated-vm", "node-pty",
]);
/** A specifier that is not a package at all: a URL (data: carries code inline), or an absolute or node_modules path that escapes the tree. */
const REMOTE_SCHEME = /^(?:data|http|https|file|ftp|ws|wss|blob):/i;
const isOutOfTree = (specifier: string): boolean => REMOTE_SCHEME.test(specifier) || specifier.startsWith("/") || (specifier.startsWith(".") && specifier.split("/").includes("node_modules"));

/** Loader entry points reachable as members: `process.binding(...)`, `process.dlopen`, `process.mainModule`, `process.getBuiltinModule`, and `process.process` (which is `process` again, one step removed). */
const LOADER_MEMBERS: ReadonlySet<string> = new Set(["getBuiltinModule", "binding", "dlopen", "mainModule", "_linkedBinding", "process"]);
/** The PostgreSQL driver family: allowed ONLY under the postgres state implementation. */
const PG_MODULES: ReadonlySet<string> = new Set(["pg", "pg-pool", "pg-native"]);
const PG_ALLOWED_DIR = "packages/security/src/state/postgres/";

const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(["globalThis", "global", "window", "self"]);
const NETWORK_GLOBALS: ReadonlyMap<string, "global-fetch" | "global-network"> = new Map([
  ["fetch", "global-fetch"], ["WebSocket", "global-network"], ["XMLHttpRequest", "global-network"], ["EventSource", "global-network"],
]);

/** `node:dns/promises` -> `dns`, `pg/lib/client` -> `pg`, `@scope/pkg/x` -> `@scope/pkg`. */
function packageOf(specifier: string): string {
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  const parts = bare.split("/");
  return bare.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? bare);
}

/** The file's path relative to the repository root, or undefined when it cannot be anchored there. */
function relativeToRoot(file: string, repoRoot: string | undefined): string | undefined {
  const normalized = file.replace(/\\/g, "/");
  let relative: string;
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    if (repoRoot === undefined) return undefined;
    const root = repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normalized.startsWith(`${root}/`)) return undefined;
    relative = normalized.slice(root.length + 1);
  } else {
    relative = normalized;
  }
  const clean = posix.normalize(relative);
  return clean.startsWith("../") || clean === ".." ? undefined : clean;
}

function isPgAllowed(file: string, repoRoot: string | undefined): boolean {
  return relativeToRoot(file, repoRoot)?.startsWith(PG_ALLOWED_DIR) ?? false;
}

/** True when `node` is used as a name (property, declaration, specifier) rather than a value reference. */
function isNamePosition(node: ts.Identifier, parent: ts.Node | undefined): boolean {
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isMethodSignature(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) && parent.name === node) return true;
  if ((ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) && parent.name === node) return true;
  if (ts.isEnumMember(parent) && parent.name === node) return true;
  if ((ts.isTypeParameterDeclaration(parent) || ts.isNamedTupleMember(parent) || ts.isNamespaceExport(parent) || ts.isImportEqualsDeclaration(parent)) && parent.name === node) return true;
  if ((ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return true;
  if (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) return true;
  if (ts.isExportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) return true;
  if (ts.isImportClause(parent) && parent.name && parent.name === node) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) return true;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
  if ((ts.isFunctionExpression(parent) || ts.isArrowFunction(parent)) && parent.name === node) return true;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isCatchClause(parent) && parent.variableDeclaration && parent.variableDeclaration.name === node) return true;
  if ((ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) && parent.name && parent.name === node) return true;
  if (
    (ts.isEnumDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isModuleDeclaration(parent)) &&
    parent.name === node
  ) return true;
  return false;
}

/** Does a binding name directly bind `name`? (`const { other: name } = x` shadows; `const { name: other } = x` does not.) */
function bindsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  for (const element of binding.elements) {
    if (ts.isBindingElement(element) && bindsName(element.name, name)) return true;
  }
  return false;
}

/** `declare const x` / `declare function x` describe a binding that exists elsewhere (here: the global) and emit nothing. */
function isAmbient(statement: ts.VariableStatement | ts.FunctionDeclaration | ts.ClassDeclaration | ts.EnumDeclaration | ts.ModuleDeclaration): boolean {
  return statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ?? false;
}

function declaresInList(list: ts.VariableDeclarationList, name: string): boolean {
  return list.declarations.some((declaration) => bindsName(declaration.name, name));
}

/** A namespace that holds only types (interfaces, aliases, other such namespaces) emits nothing and binds no value. */
function isInstantiated(declaration: ts.ModuleDeclaration): boolean {
  const body = declaration.body;
  if (body === undefined) return false;
  if (ts.isModuleDeclaration(body)) return isInstantiated(body);
  if (!ts.isModuleBlock(body)) return false;
  return body.statements.some((statement) =>
    !(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && !(ts.isModuleDeclaration(statement) && !isInstantiated(statement)));
}

/** Does this statement introduce a value binding called `name` into the scope that holds it? */
function declaresStatement(statement: ts.Statement, name: string): boolean {
  if (ts.isVariableStatement(statement)) return !isAmbient(statement) && declaresInList(statement.declarationList, name);
  // A function without a body is an overload signature: it emits nothing, and its implementation declares the name.
  if (ts.isFunctionDeclaration(statement)) return !isAmbient(statement) && statement.body !== undefined && statement.name?.text === name;
  if (ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) return !isAmbient(statement) && statement.name?.text === name;
  if (ts.isModuleDeclaration(statement)) return !isAmbient(statement) && ts.isIdentifier(statement.name) && statement.name.text === name && isInstantiated(statement);
  if (ts.isImportEqualsDeclaration(statement)) return !statement.isTypeOnly && statement.name.text === name;
  if (ts.isImportDeclaration(statement)) {
    // TS 6: default and namespace bindings both live on the import clause. A type-only import binds no value.
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) return false;
    if (clause.name?.text === name) return true;
    const named = clause.namedBindings;
    if (!named) return false;
    if (ts.isNamedImports(named)) return named.elements.some((specifier) => !specifier.isTypeOnly && specifier.name.text === name);
    return ts.isNamespaceImport(named) && named.name.text === name;
  }
  return false;
}

/** Does `scope` declare a local binding called `name` directly in it? */
function declaresName(scope: ts.Node, name: string): boolean {
  if (ts.isFunctionDeclaration(scope) || ts.isFunctionExpression(scope) || ts.isArrowFunction(scope) || ts.isMethodDeclaration(scope) || ts.isConstructorDeclaration(scope) ||
    ts.isGetAccessorDeclaration(scope) || ts.isSetAccessorDeclaration(scope)) {
    if ((ts.isFunctionDeclaration(scope) || ts.isFunctionExpression(scope)) && scope.name?.text === name) return true;
    return scope.parameters.some((parameter) => bindsName(parameter.name, name));
  }
  if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) return scope.statements.some((statement) => declaresStatement(statement, name));
  // `case 1: const x = ...` with no braces declares in the whole switch block.
  if (ts.isCaseClause(scope) || ts.isDefaultClause(scope)) return scope.statements.some((statement) => declaresStatement(statement, name));
  if (ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) {
    return scope.initializer !== undefined && ts.isVariableDeclarationList(scope.initializer) && declaresInList(scope.initializer, name);
  }
  if (ts.isCatchClause(scope)) return scope.variableDeclaration !== undefined && bindsName(scope.variableDeclaration.name, name);
  // `const A = class fetch { ... }`: the class's own name is visible inside it.
  if (ts.isClassExpression(scope)) return scope.name?.text === name;
  return false;
}

/** True when the reference to `name` resolves to a local binding in an enclosing scope, i.e. it is NOT the global. */
function resolvesLocally(node: ts.Node, name: string): boolean {
  for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
    if (declaresName(scope, name)) return true;
  }
  return false;
}

const stringKey = (expression: ts.Expression): string | undefined =>
  ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) ? expression.text : undefined;
const memberName = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined =>
  ts.isPropertyAccessExpression(access) ? access.name.text : stringKey(access.argumentExpression);

/** A name used only as a type (`x: WebSocket`, `typeof fetch`, `typeof globalThis.fetch`) emits nothing. */
function inTypePosition(node: ts.Node): boolean {
  let parent = node.parent;
  while (parent && ts.isQualifiedName(parent)) parent = parent.parent;
  if (parent === undefined) return false;
  if (ts.isTypeReferenceNode(parent) || ts.isTypeQueryNode(parent)) return true;
  // `interface I extends X` and `class C implements X` name types only; `class C extends X` is a runtime use.
  if (ts.isExpressionWithTypeArguments(parent) && ts.isHeritageClause(parent.parent)) {
    return parent.parent.token === ts.SyntaxKind.ImplementsKeyword || ts.isInterfaceDeclaration(parent.parent.parent);
  }
  return false;
}

/** Members that turn a function's `.constructor` into a way to build code from text. */
const CONSTRUCTOR_ESCAPES: ReadonlySet<string> = new Set(["call", "apply", "bind", "constructor"]);

/** `x.constructor` read in a way that grants nothing: compared, type-tested, assigned to, or only inspected (`.name`, `.prototype`, `.registry`). */
function constructorReadIsHarmless(node: ts.Node): boolean {
  let top: ts.Node = node;
  while (top.parent && (ts.isParenthesizedExpression(top.parent) || ts.isNonNullExpression(top.parent) || ts.isAsExpression(top.parent) ||
    ts.isTypeAssertionExpression(top.parent) || ts.isSatisfiesExpression(top.parent))) top = top.parent;
  const parent = top.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === top) return !CONSTRUCTOR_ESCAPES.has(parent.name.text);
  if (ts.isElementAccessExpression(parent) && parent.expression === top) {
    const key = stringKey(parent.argumentExpression);
    return key !== undefined && !CONSTRUCTOR_ESCAPES.has(key);
  }
  if (ts.isTypeOfExpression(parent)) return true;
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    if (operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsEqualsToken || operator === ts.SyntaxKind.InstanceOfKeyword) return true;
    // Writing to it (`this.constructor = F`) reads nothing.
    return operator === ts.SyntaxKind.EqualsToken && parent.left === top;
  }
  return false;
}

/** Look through parentheses, `as`, `!`, `<T>x` and `satisfies`, which change nothing at runtime. */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)
  ) current = current.expression;
  return current;
}

/** Syntax errors only (TS1xxx): the scan walks an error-tolerant tree, which can hide an import behind a parse failure. */
function syntaxErrors(file: string, text: string): ts.Diagnostic[] {
  const output = ts.transpileModule(text, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve },
  });
  return (output.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error && diagnostic.code >= 1000 && diagnostic.code < 2000);
}

/**
 * Scan one source file. `file` is the path reported in findings; for the pg allow-list it is anchored at
 * `repoRoot` when absolute (an absolute path with no root can never be allowed). Pure in-memory: nothing is read.
 */
export function scanSource(file: string, text: string, repoRoot?: string): StaticScanFinding[] {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const findings: StaticScanFinding[] = [];
  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const report = (node: ts.Node, kind: StaticScanKind, module?: string): void => {
    findings.push({ file, line: lineOf(node), kind, ...(module === undefined ? {} : { module }) });
  };

  const [syntaxError] = syntaxErrors(file, text);
  if (syntaxError) {
    const line = syntaxError.start === undefined ? 1 : sourceFile.getLineAndCharacterOfPosition(syntaxError.start).line + 1;
    findings.push({ file, line, kind: "unparseable" });
  }

  // A relative import must stay inside the package's own src tree: anything outside is code this scan never reads.
  const packageSrc = /^(packages\/[^/]+\/src)\//.exec(relativeToRoot(file, repoRoot) ?? "")?.[1];
  const escapesPackage = (specifier: string): boolean => {
    if (!specifier.startsWith(".") || packageSrc === undefined) return false;
    const resolved = posix.normalize(posix.join(posix.dirname(relativeToRoot(file, repoRoot) ?? ""), specifier));
    return resolved !== packageSrc && !resolved.startsWith(`${packageSrc}/`);
  };

  const checkModule = (specifier: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): void => {
    const name = packageOf(specifier.text);
    if (isOutOfTree(specifier.text) || escapesPackage(specifier.text) || FORBIDDEN_MODULES.has(name) || (PG_MODULES.has(name) && !isPgAllowed(file, repoRoot))) report(specifier, "forbidden-import", specifier.text);
  };

  const isLoaderCall = (node: ts.CallExpression): boolean => {
    const callee = unwrap(node.expression);
    if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
    // A user-defined `require` (a parameter, a helper function) is not the module loader.
    if (ts.isIdentifier(callee) && callee.text === "require") return !resolvesLocally(callee, "require");
    return (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) && memberName(callee) === "getBuiltinModule";
  };

  /** Is `node` (a member access) the callee of a call whose first argument is a literal specifier? Then the call path already judged it. */
  const isDirectLiteralCall = (node: ts.Node): boolean => {
    let top: ts.Node = node;
    while (top.parent && (ts.isParenthesizedExpression(top.parent) || ts.isNonNullExpression(top.parent) || ts.isAsExpression(top.parent))) top = top.parent;
    const call = top.parent;
    if (!call || !ts.isCallExpression(call) || call.expression !== top) return false;
    const first = call.arguments[0];
    return first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first));
  };

  const checkNode = (node: ts.Node): void => {
    // Static forms. A type-only declaration emits nothing, so it grants nothing.
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) checkModule(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) checkModule(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      // TS 6 names this node ExternalModuleReference (formerly ImportRequires).
      if (!node.isTypeOnly && reference.kind === ts.SyntaxKind.ExternalModuleReference && ts.isExternalModuleReference(reference) && ts.isStringLiteral(reference.expression)) {
        checkModule(reference.expression);
      }
    } else if (ts.isCallExpression(node) && isLoaderCall(node)) {
      // Loader calls: a literal specifier is checked; anything else cannot be seen, so it is a finding itself.
      const first = node.arguments[0];
      if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) checkModule(first);
      else report(node, "dynamic-module");
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const target = unwrap(node.expression);
      const member = memberName(node);
      const global = ts.isIdentifier(target) && !resolvesLocally(target, target.text) ? target.text : undefined;
      // `globalThis.fetch`, `window["fetch"]`, `(globalThis as X).WebSocket`: name what is being reached.
      const kind = member === undefined ? undefined : NETWORK_GLOBALS.get(member);
      if (kind && global !== undefined && GLOBAL_OBJECTS.has(global)) report(node, kind);
      // A loader reached through a member: only a direct call with a literal specifier is visible to this scan.
      if (member === "getBuiltinModule" && !isDirectLiteralCall(node)) report(node, "dynamic-module");
      else if (member !== undefined && member !== "getBuiltinModule" && LOADER_MEMBERS.has(member) && global === "process") report(node, "dynamic-module");
      // `x.constructor` is how a function's Function constructor is reached; see constructorReadIsHarmless for what is fine.
      // `this.constructor` in a method is the instance's own class (a class that extends Function is a finding by itself).
      if (member === "constructor" && target.kind !== ts.SyntaxKind.ThisKeyword && !constructorReadIsHarmless(node)) report(node, "dynamic-code");
    }

    // `const { constructor: F } = fn`, `const { ["constructor"]: F } = fn`, `({ constructor: F } = fn)`, `({ constructor } = fn)`.
    const destructuredKey = (key: ts.PropertyName): string | undefined =>
      ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : ts.isComputedPropertyName(key) ? stringKey(key.expression) : undefined;
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      if (destructuredKey(node.propertyName ?? (node.name as ts.PropertyName)) === "constructor") report(node, "dynamic-code");
    } else if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ts.isObjectLiteralExpression(node.parent)) {
      const assignment = node.parent.parent;
      if (ts.isBinaryExpression(assignment) && assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken && assignment.left === node.parent && destructuredKey(node.name) === "constructor") {
        report(node, "dynamic-code");
      }
    }

    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const name = node.text;
      if (isNamePosition(node, parent) || inTypePosition(node) || resolvesLocally(node, name)) return;
      const network = NETWORK_GLOBALS.get(name);
      if (network) report(node, network);
      else if (GLOBAL_OBJECTS.has(name)) report(node, "global-object");
      // A bare `require` (not a call this scan already judged) can be aliased and called later: fail closed.
      else if (name === "require" && !(parent && ts.isCallExpression(parent) && parent.expression === node)) report(node, "dynamic-module");
      else if (name === "module") report(node, "dynamic-module");
      // `process` may only be used as `process.<member>`; an alias, a destructuring or a computed key can reach any loader.
      else if (name === "process") {
        let top: ts.Node = node;
        while (top.parent && (ts.isParenthesizedExpression(top.parent) || ts.isNonNullExpression(top.parent) || ts.isAsExpression(top.parent) ||
          ts.isTypeAssertionExpression(top.parent) || ts.isSatisfiesExpression(top.parent))) top = top.parent;
        const outer = top.parent;
        const usedAsMember = outer && ((ts.isPropertyAccessExpression(outer) && outer.expression === top) ||
          (ts.isElementAccessExpression(outer) && outer.expression === top && stringKey(outer.argumentExpression) !== undefined));
        // `typeof process` only asks whether it exists.
        if (!usedAsMember && !(outer && ts.isTypeOfExpression(outer))) report(node, "dynamic-module");
      } else if (name === "eval") report(node, "dynamic-code");
      // `Function` is the code-from-text constructor. Testing against it (`x instanceof Function`) or reading `Function.prototype` is not a use of it.
      else if (name === "Function") {
        const testsAgainst = parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword;
        const readsPrototype = parent && ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "prototype";
        if (!testsAgainst && !readsPrototype) report(node, "dynamic-code");
      }
    }
  };

  sourceFile.forEachChild(function walk(node: ts.Node): void {
    checkNode(node);
    ts.forEachChild(node, walk);
  });

  return findings;
}

const SOURCE_EXTENSION = /\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;
const DECLARATION_FILE = /\.d\.(?:ts|mts|cts)$/;
const TEST_FILE = /\.test\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;

function listSources(repoRoot: string, relativeDir: string, into: string[]): void {
  for (const entry of readdirSync(join(repoRoot, relativeDir), { withFileTypes: true })) {
    const relative = `${relativeDir}/${entry.name}`;
    // A link could point anywhere, including at code the scan never reads.
    if (entry.isSymbolicLink()) throw new Error(`static-scan: refusing symbolic link ${relative}`);
    if (entry.isDirectory()) listSources(repoRoot, relative, into);
    else if (entry.isFile() && SOURCE_EXTENSION.test(entry.name) && !DECLARATION_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) into.push(relative);
  }
}

/**
 * Scan every production source file under `repoRoot/relativeRoot` (recursive; `*.test.*` and `*.d.ts` files are
 * excluded, every other JS/TS flavour is scanned). Fails loudly if the root is missing or holds no source files,
 * so a mistyped root can never pass vacuously. Paths in `files` and in findings are relative to `repoRoot`.
 */
export function scanTree(repoRoot: string, relativeRoot: string): { readonly files: string[]; readonly findings: StaticScanFinding[] } {
  const files: string[] = [];
  listSources(repoRoot, relativeRoot.replace(/\/+$/, ""), files);
  if (files.length === 0) throw new Error(`static-scan: no source files under ${relativeRoot}`);
  files.sort();
  const findings = files.flatMap((file) => scanSource(file, readFileSync(join(repoRoot, file), "utf8")));
  return { files, findings };
}
