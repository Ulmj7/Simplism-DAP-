/**
 * The host validator (Feature 004, T403): `validateDefinition(unknown, registryData = TRUSTED_REGISTRY)`.
 *
 *   1. STRICT PARSE (`schema.ts`): known keys only, bounded strings, at most 24 steps and 1 to 8 guide steps. Its output is a FRESH object holding the known
 *      fields only (the normalisation: nothing the caller's object carries beyond the language survives), deeply frozen.
 *   2. THE ONE VALIDATOR: `createWalkthroughCatalog(registry, postconditionNames, [candidate])` from Feature 002, validating this definition ALONE (so one bad guide
 *      cannot hide behind another). The host never copies or re-implements its rules.
 *
 * The result is `{ ok: true, definition }` (the catalog's own frozen copy) or `{ ok: false, issues }`. `registryData` exists so a test can inject a DIFFERENT
 * registry through the REAL validator (for example to prove a stale draft is refused after the registry changed); production code always uses the trusted copy.
 *
 * Issues use fixed phrases or the catalog’s diagnostic text with positional step labels. Arbitrary field names and ids are omitted. The list is capped
 * at 20 issues of at most 200 characters, with control characters replaced.
 */
import { createSemanticRegistry, createWalkthroughCatalog, WalkthroughCatalogError } from "@dap/walkthrough/authoring";
import type { WalkthroughDef } from "@dap/walkthrough/authoring";
import { definitionSchema } from "./schema.js";
import { TRUSTED_REGISTRY } from "./trusted-registry.js";
import type { TrustedRegistryData } from "./trusted-registry.js";
import { isAuthoredId } from "./ids.js";

export const MAX_ISSUES = 20;
export const MAX_ISSUE_CHARS = 200;
/** Control characters, line and paragraph separators and bidirectional overrides. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export type ValidationResult =
  | { readonly ok: true; readonly definition: WalkthroughDef }
  | { readonly ok: false; readonly issues: readonly string[] };

/** At most 20 issues, each at most 200 characters with control characters (including line breaks) replaced by a space. */
export function capIssues(issues: readonly string[]): readonly string[] {
  return Object.freeze(issues.slice(0, MAX_ISSUES).map((issue) => String(issue).replace(CONTROL, " ").slice(0, MAX_ISSUE_CHARS)));
}

const refuse = (issues: readonly string[]): ValidationResult => Object.freeze({ ok: false, issues: capIssues(issues) });

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
};

/** A fixed phrase per zod issue: where it is (field names only) and what kind of problem, never zod's own text. */
function describeParseIssues(error: { issues: readonly { code: string; path: readonly PropertyKey[]; message?: string }[] }): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.map(String).join(".") || "definition";
    switch (issue.code) {
      case "unrecognized_keys": return `${where}: unknown field`;
      case "invalid_type": return `${where}: missing or of the wrong type`;
      case "too_big": return `${where}: too long or too many`;
      case "too_small": return `${where}: too short or too few`;
      case "custom": return issue.message === "guide-step-count" ? `${where}: a guide needs between 1 and 8 guide steps` : `${where}: not allowed`;
      default: return `${where}: not allowed`;
    }
  });
}

/** Catalog issue prefixes can contain an arbitrary author-supplied ID. Use a step position in its place. */
function describeCatalogIssues(issues: readonly string[], candidate: WalkthroughDef): string[] {
  return issues.map(issue => {
    const parts = issue.split(": ");
    const prefix = parts[0];
    const index = candidate.steps.findIndex(step => prefix === `${candidate.id}.${step.id}` || (parts.length === 3 && parts[1] === step.id));
    const location = index < 0 ? "definition" : `steps.${index}`;
    return `${location}: ${parts.at(-1)}`;
  });
}

export function validateDefinition(input: unknown, registryData: TrustedRegistryData = TRUSTED_REGISTRY): ValidationResult {
  let candidate: WalkthroughDef;
  try {
    const parsed = definitionSchema.safeParse(input);
    if (!parsed.success) return refuse(describeParseIssues(parsed.error));
    candidate = deepFreeze(parsed.data) as unknown as WalkthroughDef;
  } catch { return refuse(["definition: could not be read"]); }
  try {
    const registry = createSemanticRegistry({ routes: registryData.routes, elements: registryData.elements });
    const catalog = createWalkthroughCatalog(registry, registryData.postconditionNames, [candidate]);
    const accepted = catalog.get(candidate.id);
    if (accepted === undefined) return refuse(["definition: not accepted"]);
    return Object.freeze({ ok: true, definition: accepted });
  } catch (error) {
    if (error instanceof WalkthroughCatalogError) return refuse(describeCatalogIssues(error.issues, candidate));
    return refuse(["definition: could not be checked"]); // e.g. malformed injected registry data: never the thrown text
  }
}

/**
 * The executor's check: the id must be an authored id (the generated shape; not `wt-preview`, not a built-in id), the definition must be valid, and the definition's
 * own id must EQUAL it (a mismatch is refused, never repaired).
 */
export function validateAuthoredDefinition(walkthroughId: unknown, input: unknown, registryData: TrustedRegistryData = TRUSTED_REGISTRY):
  | { readonly ok: true; readonly definition: WalkthroughDef }
  | { readonly ok: false; readonly code: "id_refused" | "invalid_definition"; readonly issues: readonly string[] } {
  if (!isAuthoredId(walkthroughId)) return { ok: false, code: "id_refused", issues: [] };
  const result = validateDefinition(input, registryData);
  if (!result.ok) return { ok: false, code: "invalid_definition", issues: result.issues };
  if (result.definition.id !== walkthroughId) return { ok: false, code: "id_refused", issues: [] };
  return { ok: true, definition: result.definition };
}
