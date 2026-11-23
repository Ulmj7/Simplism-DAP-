import { OPERATIONS, PRIVACY_LEVELS, ROLES } from "./types.js";
import type { SemanticElementDef, SemanticRegistry, SemanticRegistryInput } from "./types.js";

export const ID_PATTERN = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;
export const MAX_LABEL = 80;
export const MAX_DESCRIPTION = 240;
/** Text is rendered with `textContent` only, but the rule stays simple: no markup-ish characters at all. */
const MARKUP = /[<>&"'`]/;
const ROUTE_PATTERN = /^[a-z][A-Za-z0-9-]*$/;
const FORBIDDEN_IDS = new Set(["__proto__", "constructor", "prototype"]);

export class SemanticRegistryError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid semantic registry: ${issues.join("; ")}`);
    this.name = "SemanticRegistryError";
    this.issues = issues;
  }
}

/** The one text rule (also used for walkthrough text): non-blank, bounded, none of `< > & " ' `.` */
export const isPlainText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !MARKUP.test(value);

/** Builds the frozen registry, or throws a `SemanticRegistryError` listing every problem. */
export function createSemanticRegistry(input: SemanticRegistryInput): SemanticRegistry {
  const issues: string[] = [];
  const routes: string[] = [];
  const routeSet = new Set<string>();
  if (!input || !Array.isArray(input.routes) || !Array.isArray(input.elements)) throw new SemanticRegistryError(["routes and elements must be arrays"]);
  for (const route of input.routes) {
    if (typeof route !== "string" || !ROUTE_PATTERN.test(route)) issues.push(`malformed route ${JSON.stringify(route)}`);
    else if (routeSet.has(route)) issues.push(`duplicate route ${route}`);
    else { routeSet.add(route); routes.push(route); }
  }
  const byId = new Map<string, SemanticElementDef>();
  const byRoute = new Map<string, SemanticElementDef[]>();
  for (const raw of input.elements as readonly unknown[]) {
    const source = raw as Partial<Record<keyof SemanticElementDef, unknown>> | null;
    const at = typeof source?.id === "string" ? source.id : "<element>";
    if (source === null || typeof source !== "object") { issues.push("element must be an object"); continue; }
    const operations = source.operations;
    const before = issues.length;
    if (typeof source.id !== "string" || !ID_PATTERN.test(source.id) || FORBIDDEN_IDS.has(source.id)) issues.push(`${at}: malformed id`);
    else if (byId.has(source.id)) issues.push(`${at}: duplicate id`);
    if (typeof source.route !== "string" || !routeSet.has(source.route)) issues.push(`${at}: unknown route`);
    if (!(ROLES as readonly unknown[]).includes(source.role)) issues.push(`${at}: unknown role`);
    if (!isPlainText(source.label, MAX_LABEL)) issues.push(`${at}: label must be plain text of 1 to ${MAX_LABEL} characters`);
    if (!isPlainText(source.description, MAX_DESCRIPTION)) issues.push(`${at}: description must be plain text of 1 to ${MAX_DESCRIPTION} characters`);
    if (!Array.isArray(operations) || operations.length === 0 || operations.some((op: unknown) => !(OPERATIONS as readonly unknown[]).includes(op))) issues.push(`${at}: operations must be a non-empty subset of ${OPERATIONS.join("|")}`);
    if (!(PRIVACY_LEVELS as readonly unknown[]).includes(source.privacy)) issues.push(`${at}: unknown privacy`);
    if (issues.length !== before) continue;
    const def = Object.freeze({
      id: source.id, route: source.route, role: source.role, label: source.label, description: source.description,
      operations: Object.freeze([...new Set(operations as unknown[])]), privacy: source.privacy,
    }) as SemanticElementDef;
    byId.set(def.id, def);
    byRoute.set(def.route, [...(byRoute.get(def.route) ?? []), def]);
  }
  if (issues.length > 0) throw new SemanticRegistryError(issues);
  const all = Object.freeze([...byId.values()]);
  const frozenRoutes = Object.freeze([...routes]);
  return Object.freeze({
    get: (id: unknown) => (typeof id === "string" ? byId.get(id) : undefined),
    has: (id: unknown) => typeof id === "string" && byId.has(id),
    list: () => all,
    forRoute: (route: unknown) => Object.freeze([...(typeof route === "string" ? byRoute.get(route) ?? [] : [])]),
    routes: frozenRoutes,
  });
}
