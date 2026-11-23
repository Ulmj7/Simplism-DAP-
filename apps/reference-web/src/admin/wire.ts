import { ID_PATTERN, OPERATIONS } from "@dap/walkthrough";

/**
 * The wire vocabulary shared by every admin and Studio parser: ONE place for the bounds and the shapes, so the three parsers (Studio browser, applications, targets) cannot drift
 * from each other or from the host (V1A's parser-vs-host mismatch came from bounds restated in several places). Every number here is an edge that the parser tests exercise on both sides.
 */
export const LIMITS = Object.freeze({
  sessionId: 64, applicationName: 80, origin: 200, origins: 5, applications: 50, registries: 20, registryId: 64, registryLabel: 80,
  url: 300, page: 200, managedPage: 120, route: 40, candidateName: 120, role: 40, candidates: 64, hidden: 100_000,
  targetId: 80, label: 80, description: 240, operations: OPERATIONS.length,
  issues: 20, issueChars: 200, targets: 200, routes: 20, registryRoutes: 20, registryElements: 200, postconditions: 50, postconditionChars: 80, pages: 40,
  references: 100_000, updatedAt: 32, revision: 1_000_000, usage: 100, changes: 100, actor: 256, results: 200, problems: 20, checks: 100, expected: 120, attributeExpected: 40, counts: 100_000,
});

export const APPLICATION_ID = /^app-[a-f0-9]{12}$/u;
export const REF_PATTERN = /^@e[1-9]\d{0,8}$/u;
export const ROUTE_KEY = /^[a-z][A-Za-z0-9]{0,39}$/u;
export const REGISTRY_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
/** A hash-routed page as the adapter returns it: `/path` plus an optional `#/route`, no query, no escapes (the same shape as the adapter's "any" routes). */
export const PAGE_PATTERN = /^\/[A-Za-z0-9._~/-]*(?:#\/?[A-Za-z0-9._~/-]*)?$/u;
export const POSTCONDITION = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/u;

export type Bag = Record<string, unknown>;
export const record = (value: unknown): value is Bag => value !== null && typeof value === "object" && !Array.isArray(value);
/** Own keys exactly `keys` (any order): a closed shape. A reply with an extra or a missing key is refused whole. */
export const exact = (value: Bag, keys: readonly string[]) => {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every(key => present.includes(key));
};
export const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
export const count = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
export const applicationIdOf = (value: unknown): value is string => typeof value === "string" && APPLICATION_ID.test(value);
export const reference = (value: unknown): value is string => typeof value === "string" && REF_PATTERN.test(value);
export const routeKey = (value: unknown): value is string => bounded(value, LIMITS.route) && ROUTE_KEY.test(value);
export const routeOrNull = (value: unknown): value is string | null => value === null || routeKey(value);
export const pageOf = (value: unknown): value is string => bounded(value, LIMITS.page) && PAGE_PATTERN.test(value);
export const managedPageOf = (value: unknown): value is string => bounded(value, LIMITS.managedPage) && /^\/(?:#\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/u.test(value);
export const targetIdOf = (value: unknown): value is string => bounded(value, LIMITS.targetId) && ID_PATTERN.test(value);
export const operationList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.length >= 1 && value.length <= LIMITS.operations
  && new Set(value as unknown[]).size === value.length && (value as unknown[]).every(item => (OPERATIONS as readonly unknown[]).includes(item));
export const managedOperations = (role: unknown, value: unknown): value is readonly string[] => {
  if (typeof role !== "string" || !["button", "link", "textbox", "checkbox", "select", "text", "heading"].includes(role)) return false;
  // `text` (status and alert regions) and `heading` can only be highlighted: their operations are exactly ["highlight"].
  if (role === "text" || role === "heading") return operationList(value) && value.length === 1 && value[0] === "highlight";
  return operationList(value) && value.includes("highlight") && !value.includes(role === "textbox" ? "click" : "input");
};
export const unsafeKey = (key: string) => key === "__proto__" || key === "constructor" || key === "prototype";

/** A normalized `scheme://host[:port]` origin: what a URL parser gives back unchanged. */
export function normalizedOrigin(value: unknown): value is string {
  if (!bounded(value, LIMITS.origin)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && url.origin === value;
  } catch { return false; }
}
