/**
 * @dap/ai: tool-call.test.ts
 *
 * T069. `toProposalCall` passes the provider's raw argument text through
 * untouched (no parse, no trim, no normalization), and the public surface of
 * @dap/ai is exactly the allowlisted planner seam — no executor, registry,
 * context, confirmation, or state-store types.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as ai from "./index.js";
import { toProposalCall } from "./tool-call.js";
import ts from "typescript";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const INDEX_PATH = join(PACKAGE_ROOT, "src", "index.ts");

/**
 * EVERY name the package exposes, value or type, however it is declared (`export type {}`, `export *`,
 * `export interface`, `export const`, `export default`, namespace re-exports...). Asked of the compiler's
 * checker, so no syntactic form can slip past a hand-written walk of export declarations.
 */
function exportedNames(): string[] {
  const configPath = join(PACKAGE_ROOT, "tsconfig.json");
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); },
  });
  if (!config) throw new Error("cannot read the @dap/ai tsconfig");
  const program = ts.createProgram({ rootNames: [INDEX_PATH], options: config.options });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(INDEX_PATH);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error("index.ts is not a module");
  return checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.name);
}

/** Every module specifier (static, re-export, import-equals, dynamic, require) with the names it imports. */
function importsOf(file: string): Array<{ specifier: string; names: string[] | "*" }> {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
  const found: Array<{ specifier: string; names: string[] | "*" }> = [];
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      const names: string[] = [];
      let wildcard = false;
      if (node.importClause?.name) names.push("default");
      if (bindings && ts.isNamespaceImport(bindings)) wildcard = true;
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) names.push((element.propertyName ?? element.name).text);
      found.push({ specifier: node.moduleSpecifier.text, names: wildcard ? "*" : names });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      found.push({ specifier: node.moduleSpecifier.text, names: clause && ts.isNamedExports(clause) ? clause.elements.map((element) => (element.propertyName ?? element.name).text) : "*" });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      found.push({ specifier: node.moduleReference.expression.text, names: "*" });
    } else if (ts.isImportTypeNode(node)) {
      // `import("x").Name` in a type position still names another module's type.
      const argument = node.argument;
      const specifier = ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal) ? argument.literal.text : "<non-literal>";
      const first = node.qualifier ? (ts.isIdentifier(node.qualifier) ? node.qualifier.text : node.qualifier.left.getText()) : undefined;
      found.push({ specifier, names: first === undefined ? "*" : [first] });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const first = node.arguments[0];
      found.push({ specifier: first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) ? first.text : "<non-literal>", names: "*" });
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

describe("toProposalCall: raw text identity", () => {
  const samples: Array<[string, string]> = [
    ["plain", '{"action":"sendEmail","params":{"to":"a@b.c"}}'],
    [
      "surrounding whitespace",
      '  {"action":"sendEmail","params":{}}  \n',
    ],
    [
      "duplicate keys stay in the text",
      '{"action":"x","a":1,"a":2}',
    ],
    ["empty string", ""],
    ["whitespace only", " \t\n"],
    ["not JSON", "not json at all"],
    ["unicode", '{"s":"héllo 🀄"}'],
  ];

  for (const [label, text] of samples) {
    it(`passes the ${label} text through byte-for-byte`, () => {
      const call = toProposalCall("call-1", text);
      expect(call.callId).toBe("call-1");
      // Same string reference: untouched, not a copy.
      expect(call.raw).toBe(text);
    });
  }

  it("accepts an empty trusted callId as given", () => {
    const call = toProposalCall("", "x");
    expect(call.callId).toBe("");
    expect(call.raw).toBe("x");
  });
});

describe("@dap/ai export surface", () => {
  /** The complete public surface of @dap/ai (compile-time). */
  // Feature 003 added the guidance contract (Slice 1): its limits, its closed reason list, three functions and the types of the guidance port.
  const GUIDANCE_VALUES = ["GUIDANCE_LIMITS", "GUIDANCE_REASONS", "MAX_ANSWER_CHARS", "MAX_CONTEXT_ELEMENTS", "MAX_DESCRIPTION_CHARS", "MAX_ID_CHARS", "MAX_LABEL_CHARS", "MAX_MESSAGE_CHARS", "MAX_MODEL_CALLS", "MAX_QUERY_CHARS", "MAX_ROUTE_CHARS", "MAX_SOURCES", "MAX_SOURCE_CHARS", "MAX_SUMMARIES", "MAX_TITLE_CHARS", "MODEL_DEADLINE_MS", "callGuidanceModel", "createModelCallGuard", "parseGuidanceDecision", "parseGuidanceModelRequest", "unsupportedResult", "MAX_KNOWLEDGE_DOCS", "MAX_DOC_CHARS", "MAX_DOC_TAGS", "MAX_TOPIC_CHARS", "MAX_PROMPT_CHARS", "chunkDocument", "chunkKnowledge", "parseKnowledgeDoc", "parseKnowledgeSet", "MIN_RELEVANCE", "createRetriever", "renderGuidancePrompt", "GUIDANCE_SYSTEM_PROMPT", "groundDecision", "fitRequestToBudget", "parseSemanticContextInput", "MIN_SELECTION_SCORE", "SELECTION_MARGIN", "SELECTION_TOP_N", "judgeProposal", "parseCatalogSummaries", "rankSummaries", "validateProposedWalkthrough", "createGuidanceService", "WALKTHROUGH_ID"] as const;
  const GUIDANCE_TYPES = ["Cancel", "GuidanceDecision", "GuidanceInput", "GuidanceModel", "GuidanceModelRequest", "GuidanceReason", "GuidanceResult", "GuidanceSource", "GuidanceTimers", "ModelCallFailure", "ModelCallGuard", "ModelCallOutcome", "RequestParse", "SafeWalkthroughSummary", "SanitizeQuery", "SemanticContextElementInput", "SemanticContextInput", "SemanticPrivacy", "SemanticRole", "WalkthroughCatalogView", "DocParse", "KnowledgeChunk", "KnowledgeDoc", "SetParse", "RetrievedChunk", "Retriever", "RenderedPrompt", "AnswerChunk", "FittedRequest", "RankedSummary", "SelectionVerdict", "GuidanceService", "GuidanceServiceDeps"] as const;
  const ALLOWLIST = ["PlannerPort", "RawToolCall", "toProposalCall", ...GUIDANCE_VALUES, ...GUIDANCE_TYPES] as const;
  it("exposes exactly the allowlisted names (compile-time, as the type checker sees them)", () => {
    expect(exportedNames().sort()).toEqual([...ALLOWLIST].sort());
  });

  it("exposes exactly the allowlisted runtime values", () => {
    // Type exports are erased at runtime; the values are toProposalCall and the guidance limits, reasons and functions.
    expect(Object.keys(ai).sort()).toEqual(["toProposalCall", ...GUIDANCE_VALUES].sort());
  });
});

describe("@dap/ai depends on @dap/contracts and zod only, and takes nothing but the planner seam from contracts", () => {
  // Recursive and every JS/TS flavour: a file in a subdirectory or a .mts must not escape the import allow-list.
  const sources = (readdirSync(join(PACKAGE_ROOT, "src"), { recursive: true }) as string[])
    .filter((name) => /\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx)$/.test(name) && !/\.test\.[a-z]+$/.test(name))
    .map((name) => join(PACKAGE_ROOT, "src", name));
  const ALLOWED_CONTRACT_NAMES = new Set(["PlannerFeedback", "ProposalCall"]);

  it("finds the production sources it is about to check", () => {
    expect(sources.map((file) => file.slice(PACKAGE_ROOT.length)).sort()).toEqual(["src/guidance/answer.ts", "src/guidance/call-model.ts", "src/guidance/context-input.ts", "src/guidance/decision.ts", "src/guidance/knowledge/document.ts", "src/guidance/knowledge/retriever.ts", "src/guidance/limits.ts", "src/guidance/prompt.ts", "src/guidance/request.ts", "src/guidance/result.ts", "src/guidance/selection.ts", "src/guidance/service.ts", "src/guidance/snapshot.ts", "src/guidance/text.ts", "src/guidance/types.ts", "src/index.ts", "src/planner-port.ts", "src/tool-call.ts"]);
  });

  it("imports only relative modules, zod and @dap/contracts, and only the two allowlisted contract types", () => {
    for (const file of sources) {
      for (const { specifier, names } of importsOf(file)) {
        if (specifier.startsWith("./") || specifier.startsWith("../") || specifier === "zod") continue; // relative imports stay inside the package (tests/architecture/ai-guidance-boundary.test.ts)
        expect(specifier, `${file}`).toBe("@dap/contracts");
        expect(names, `${file} must not use a namespace or dynamic import of @dap/contracts`).not.toBe("*");
        for (const name of names) expect(ALLOWED_CONTRACT_NAMES.has(name), `${file} imports ${name} from @dap/contracts`).toBe(true);
      }
    }
  });

  it("declares @dap/contracts and zod as its only dependencies of any kind", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.dependencies).toEqual({ "@dap/contracts": "*", zod: "^4.6.7" });
    for (const field of ["devDependencies", "peerDependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies"]) expect(manifest, field).not.toHaveProperty(field);
    const tsconfig = JSON.parse(readFileSync(join(PACKAGE_ROOT, "tsconfig.json"), "utf8")) as { references?: Array<{ path: string }> };
    expect(tsconfig.references).toEqual([{ path: "../contracts" }]);
  });
});

describe("toProposalCall: hostile text", () => {
  it.each([
    ["an unpaired surrogate", "{\"a\":\"\ud800\"}"], ["a NUL byte", "{\"a\":\"x\u0000y\"}"], ["a BOM", "\ufeff{}"], ["CRLF", "{}\r\n"], ["a lone backslash", "\\"],
    ["one megabyte", "x".repeat(1_000_000)], ["escape-looking text", '{"a":"\\u0041"}'], ["a prototype key", '{"__proto__":{"polluted":true}}'], ["a duplicate key", '{"a":1,"a":2}'],
  ])("passes %s through untouched, without parsing or judging it", (_label, text) => {
    const call = toProposalCall("id", text);
    expect(call.raw).toBe(text);
    expect(call.raw).toHaveLength(text.length);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("does not coerce, parse or copy a value that is not text; intake judges it", () => {
    const parsed = { action: "x", params: {} };
    expect(toProposalCall("id", parsed as never).raw).toBe(parsed);
    const exotic = { get raw() { return 1; } };
    expect(toProposalCall("id", exotic as never).raw).toBe(exotic);
    expect(toProposalCall("id", undefined as never).raw).toBeUndefined();
  });

  it("returns a frozen call that carries exactly callId and raw", () => {
    const call = toProposalCall("id", "{}");
    expect(Object.keys(call)).toEqual(["callId", "raw"]);
    expect(Object.isFrozen(call)).toBe(true);
    expect(() => { (call as { raw: unknown }).raw = "changed"; }).toThrow(TypeError);
    expect(toProposalCall("id", "{}")).not.toBe(call);
  });
});
