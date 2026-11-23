import { isPlainText, MAX_LABEL as MAX_TITLE, MAX_DESCRIPTION as MAX_TEXT } from "@dap/walkthrough";
import type { SemanticElementDef, WalkthroughDef } from "@dap/walkthrough";
import { applicationIdOf, LIMITS, POSTCONDITION, managedOperations, managedPageOf, normalizedOrigin, routeKey, targetIdOf } from "../admin/wire.js";
import { CHECK_ATTRIBUTES, CHECK_KINDS, CHECK_NAME, expectedOf, MAX_ATTRIBUTE_EXPECTED, MAX_CHECKS, MAX_EXPECTED, VALUE_ROLES } from "./checks.js";
import type { CheckDef } from "./checks.js";

export interface EmbeddedApplication { readonly id: string; readonly name: string; readonly origin: string }
/** `marker`: the `data-ai-id` the page carries for this target (the durable DAP id stays `id`). Absent = the marker is the id. */
export type EmbeddedElement = SemanticElementDef & { readonly marker?: string };
export type Routing = "hash" | "history";
export interface EmbeddedRegistry {
  readonly routes: readonly string[];
  readonly elements: readonly EmbeddedElement[];
  readonly postconditionNames: readonly string[];
  readonly pages: Readonly<Record<string, string>>;
  /** Verification checks (managed registries); each one is a named postcondition `check.v…`. Absent = none. */
  readonly checks?: readonly CheckDef[];
  /** How the application addresses pages (`pages` keys are hash pages or pathnames). Absent = `hash`. */
  readonly routing?: Routing;
}
export interface ManagedBundle {
  readonly definition: WalkthroughDef;
  readonly application: EmbeddedApplication;
  readonly registry: EmbeddedRegistry;
  /** The live version number of a published guide (standalone delivery); informational. */
  readonly version?: number;
}

const states = ["RESOLVING", "PRESENTING", "WAITING", "VERIFYING", "COMPLETED", "FAILED", "CANCELLED"] as const;
const reasons = ["invalid_bundle", "already_running", "unsupported_version", "invalid_registry"] as const;
export type Refusal = typeof reasons[number];
export const failureCodes = ["target_unavailable", "verification_failed", "route_mismatch", "timeout", "cancelled", "invalid"] as const;
export type FailureCode = typeof failureCodes[number];
/** Why a run stopped. Names, routes and ids only: never a value, text or any other content of the page. */
export interface RunFailure { readonly code: FailureCode; readonly targetId?: string; readonly expectedRoute?: string; readonly currentRoute?: string; readonly check?: string }
export type RunStatus =
  | { readonly status: typeof states[number]; readonly stepIndex?: number; readonly stepCount?: number; readonly failure?: RunFailure }
  | { readonly status: "refused"; readonly reason: Refusal };
export const terminal = (status: RunStatus["status"]) => status === "COMPLETED" || status === "FAILED" || status === "CANCELLED" || status === "refused";

type Bag = Record<string, unknown>;
function plain(value: unknown): value is Bag {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key => {
    if (typeof key !== "string" || key === "__proto__" || key === "constructor" || key === "prototype") return false;
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field?.enumerable === true && "value" in field;
  });
}
function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Bag {
  return plain(value) && required.every(key => Object.hasOwn(value, key))
    && Reflect.ownKeys(value).every(key => required.includes(key as string) || optional.includes(key as string));
}
function array<T>(value: unknown, max: number, guard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) => Object.getOwnPropertyDescriptor(value, index)).every(desc => desc?.enumerable === true && "value" in desc && guard(desc.value));
}
const isValidId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value);
const optional = (value: Bag, key: string, check: (field: unknown) => boolean) => !Object.hasOwn(value, key) || check(value[key]);
const within = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const routeName = (name: unknown): name is string => typeof name === "string" && name.startsWith("route.") && routeKey(name.slice(6));
const postconditionName = (name: unknown): name is string => routeName(name) || (typeof name === "string" && CHECK_NAME.test(name));
/** Pathnames of a history-routed application: static, `[A-Za-z0-9._~/-]`, at most 200 characters, no empty segment, no trailing slash except `/`. */
export const historyPageOf = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= LIMITS.page
  && /^\/[A-Za-z0-9._~/-]*$/u.test(value) && !value.includes("//") && (value === "/" || !value.endsWith("/"));
/** Postconditions of one bundle: every route plus at most 100 checks. */
export const MAX_EMBED_POSTCONDITIONS = LIMITS.registryRoutes + MAX_CHECKS;

function step(value: unknown): value is WalkthroughDef["steps"][number] {
  if (!plain(value)) return false;
  const common = ["id", "kind", "next"];
  const extra = ["recover", "maxAttempts"];
  const text = (field: unknown) => isPlainText(field, MAX_TEXT);
  if (!isValidId(value.id)) return false;
  if (value.kind === "complete") return shape(value, ["id", "kind", "text"]) && text(value.text);
  if (!isValidId(value.next) || !optional(value, "recover", isValidId) || !optional(value, "maxAttempts", field => within(field, 1, 10))) return false;
  if (value.kind === "navigate") return shape(value, [...common, "route"], [...extra, "text"]) && routeKey(value.route) && optional(value, "text", text);
  return value.kind === "guide" && shape(value, [...common, "target", "text", "wait"], [...extra, "verify", "targetWaitMs"])
    && targetIdOf(value.target) && text(value.text) && ["click", "input", "ack"].includes(value.wait as string)
    && optional(value, "verify", postconditionName) && optional(value, "targetWaitMs", field => within(field, 0, 10_000));
}

const element = (item: unknown): item is EmbeddedElement => shape(item, ["id", "route", "role", "label", "description", "operations", "privacy"], ["marker"])
  && targetIdOf(item.id) && routeKey(item.route) && isPlainText(item.label, MAX_TITLE) && isPlainText(item.description, MAX_TEXT)
  && item.privacy === "public" && array(item.operations, LIMITS.operations, (value): value is string => typeof value === "string")
  && (managedOperations(item.role, item.operations) || ((item.role === "text" || item.role === "heading") && (item.operations as readonly string[]).length === 1 && (item.operations as readonly string[])[0] === "highlight"))
  && optional(item, "marker", targetIdOf);

/** One check, as a closed shape per kind. The name is the deterministic `check.v<10 hex>` of the host; the expected value is short plain data. */
function check(value: unknown): value is CheckDef {
  if (!plain(value) || typeof value.kind !== "string" || !(CHECK_KINDS as readonly string[]).includes(value.kind) || typeof value.name !== "string" || !CHECK_NAME.test(value.name)) return false;
  switch (value.kind) {
    case "route.equals": return shape(value, ["name", "kind", "route"]) && routeKey(value.route);
    case "element.visible": case "element.hidden": return shape(value, ["name", "kind", "targetId"]) && targetIdOf(value.targetId);
    case "element.text.equals": case "element.value.equals": return shape(value, ["name", "kind", "targetId", "expected"]) && targetIdOf(value.targetId) && expectedOf(value.expected, MAX_EXPECTED);
    default: return shape(value, ["name", "kind", "targetId", "attribute", "expected"]) && targetIdOf(value.targetId)
      && (CHECK_ATTRIBUTES as readonly unknown[]).includes(value.attribute) && expectedOf(value.expected, MAX_ATTRIBUTE_EXPECTED);
  }
}

export type BundleResult = { readonly ok: true; readonly bundle: ManagedBundle } | { readonly ok: false; readonly reason: "invalid_bundle" | "invalid_registry" };
export function parseBundle(value: unknown): BundleResult {
  const invalid = { ok: false, reason: "invalid_bundle" } as const;
  const invalidRegistry = { ok: false, reason: "invalid_registry" } as const;
  try {
    if (!shape(value, ["definition", "application", "registry"], ["version"]) || !optional(value, "version", field => within(field, 1, 1_000_000))) return invalid;
    const { definition, application, registry } = value;
    if (!shape(application, ["id", "name", "origin"]) || !applicationIdOf(application.id) || !isPlainText(application.name, LIMITS.applicationName)
      || !normalizedOrigin(application.origin) || !shape(definition, ["id", "title", "description", "start", "steps"])
      || !isValidId(definition.id) || !isPlainText(definition.title, MAX_TITLE) || !isPlainText(definition.description, MAX_TEXT)
      || !isValidId(definition.start) || !array(definition.steps, 24, step) || definition.steps.length === 0) return invalid;
    if (!shape(registry, ["routes", "elements", "postconditionNames", "pages"], ["checks", "routing"]) || !array(registry.routes, LIMITS.registryRoutes, routeKey)
      || registry.routes.length === 0 || new Set(registry.routes).size !== registry.routes.length || !array(registry.elements, LIMITS.registryElements, element)
      || !array(registry.postconditionNames, MAX_EMBED_POSTCONDITIONS, postconditionName) || !plain(registry.pages)
      || !optional(registry, "routing", field => field === "hash" || field === "history") || !optional(registry, "checks", field => array(field, MAX_CHECKS, check))) return invalidRegistry;
    const routing: Routing = registry.routing === "history" ? "history" : "hash";
    const pageOk = routing === "history" ? historyPageOf : managedPageOf;
    const entries = Object.entries(registry.pages);
    const routes = registry.routes;
    const checks = (registry.checks ?? []) as readonly CheckDef[];
    const names = new Set(registry.postconditionNames);
    const wanted = new Set([...routes.map(route => `route.${route}`), ...checks.map(item => item.name)]);
    const elementList = registry.elements as readonly EmbeddedElement[];
    const ids = new Set(elementList.map(item => item.id));
    const markers = elementList.map(item => item.marker ?? item.id);
    if (entries.length !== routes.length || new Set(entries.map(([, route]) => route)).size !== entries.length
      || entries.some(([page, route]) => !pageOk(page) || !routeKey(route) || !routes.includes(route))
      // Postconditions are exactly the routes plus the checks: unique, no unlisted name, no missing one.
      || names.size !== registry.postconditionNames.length || names.size !== wanted.size || [...wanted].some(name => !names.has(name))
      || ids.size !== elementList.length
      // Markers identify the DOM elements: one marker, one element.
      || new Set(markers).size !== markers.length
      || checks.some(item => (item.kind === "route.equals" ? !routes.includes(item.route)
        : !ids.has(item.targetId) || (item.kind === "element.value.equals" && !VALUE_ROLES.includes(elementList.find(candidate => candidate.id === item.targetId)?.role ?? ""))))) return invalidRegistry;
    return { ok: true, bundle: { application: { id: application.id, name: application.name, origin: application.origin },
      ...(value.version === undefined ? {} : { version: value.version as number }),
      definition: { id: definition.id, title: definition.title, description: definition.description, start: definition.start, steps: definition.steps.map(item => ({ ...item })) },
      registry: { routes: [...registry.routes], elements: elementList.map(item => ({ ...item, operations: [...item.operations] })),
        postconditionNames: [...registry.postconditionNames], pages: Object.fromEntries(entries.filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        ...(registry.checks === undefined ? {} : { checks: checks.map(item => ({ ...item })) }), ...(registry.routing === undefined ? {} : { routing }) } } };
  } catch { return invalid; }
}

export const readyMessage = Object.freeze({ type: "dap-embed-ready", version: 1 });
export const runMessage = (bundle: ManagedBundle) => ({ type: "dap-run", version: 1, bundle } as const);
export const statusMessage = (status: RunStatus) => ({ type: "dap-run-status", version: 1, ...status } as const);
export function isReady(value: unknown): boolean {
  try { return shape(value, ["type", "version"]) && value.type === readyMessage.type && value.version === 1; } catch { return false; }
}
export function parseRun(value: unknown): BundleResult | { readonly ok: false; readonly reason: "unsupported_version" } | null {
  try {
    if (!plain(value) || value.type !== "dap-run") return null;
    if (!shape(value, ["type", "version", "bundle"])) return { ok: false, reason: "invalid_bundle" };
    return value.version === 1 ? parseBundle(value.bundle) : { ok: false, reason: "unsupported_version" };
  } catch { return null; }
}
const diagnosticKeys = ["stepIndex", "stepCount", "failure"] as const;
const failure = (value: unknown): value is RunFailure => shape(value, ["code"], ["targetId", "expectedRoute", "currentRoute", "check"])
  && (failureCodes as readonly unknown[]).includes(value.code) && optional(value, "targetId", targetIdOf) && optional(value, "expectedRoute", routeKey)
  && optional(value, "currentRoute", routeKey) && optional(value, "check", name => typeof name === "string" && name.length <= LIMITS.postconditionChars && POSTCONDITION.test(name));
export function parseStatus(value: unknown): RunStatus | null {
  try {
    if (!plain(value) || value.type !== "dap-run-status" || value.version !== 1) return null;
    if (shape(value, ["type", "version", "status", "reason"]) && value.status === "refused" && reasons.includes(value.reason as Refusal)) {
      return { status: "refused", reason: value.reason as Refusal };
    }
    if (!shape(value, ["type", "version", "status"], diagnosticKeys) || !states.includes(value.status as typeof states[number])) return null;
    if (!optional(value, "stepIndex", field => within(field, 0, 23)) || !optional(value, "stepCount", field => within(field, 1, 24)) || !optional(value, "failure", failure)) return null;
    if (value.stepIndex !== undefined && value.stepCount !== undefined && (value.stepIndex as number) >= (value.stepCount as number)) return null;
    const failed = value.failure as RunFailure | undefined;
    return { status: value.status as typeof states[number],
      ...(value.stepIndex === undefined ? {} : { stepIndex: value.stepIndex as number }), ...(value.stepCount === undefined ? {} : { stepCount: value.stepCount as number }),
      ...(failed === undefined ? {} : { failure: Object.freeze({ ...failed }) }) };
  } catch { return null; }
}
