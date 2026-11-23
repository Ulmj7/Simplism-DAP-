import { isPlainText, MAX_LABEL as MAX_TITLE, MAX_DESCRIPTION as MAX_TEXT } from "@dap/walkthrough";
import type { SemanticElementDef, WalkthroughDef } from "@dap/walkthrough";
import { applicationIdOf, LIMITS, managedOperations, managedPageOf, normalizedOrigin, routeKey, targetIdOf } from "../admin/wire.js";

export interface EmbeddedApplication { readonly id: string; readonly name: string; readonly origin: string }
export interface EmbeddedRegistry {
  readonly routes: readonly string[];
  readonly elements: readonly SemanticElementDef[];
  readonly postconditionNames: readonly string[];
  readonly pages: Readonly<Record<string, string>>;
}
export interface ManagedBundle {
  readonly definition: WalkthroughDef;
  readonly application: EmbeddedApplication;
  readonly registry: EmbeddedRegistry;
}

const states = ["RESOLVING", "PRESENTING", "WAITING", "VERIFYING", "COMPLETED", "FAILED", "CANCELLED"] as const;
const reasons = ["invalid_bundle", "already_running", "unsupported_version", "invalid_registry"] as const;
export type Refusal = typeof reasons[number];
export type RunStatus = { readonly status: typeof states[number] } | { readonly status: "refused"; readonly reason: Refusal };
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
const postconditionName = (name: unknown): name is string => typeof name === "string" && name.startsWith("route.") && routeKey(name.slice(6));

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

const element = (item: unknown): item is SemanticElementDef => shape(item, ["id", "route", "role", "label", "description", "operations", "privacy"])
  && targetIdOf(item.id) && routeKey(item.route) && isPlainText(item.label, MAX_TITLE) && isPlainText(item.description, MAX_TEXT)
  && item.privacy === "public" && array(item.operations, LIMITS.operations, (value): value is string => typeof value === "string")
  && managedOperations(item.role, item.operations);

export type BundleResult = { readonly ok: true; readonly bundle: ManagedBundle } | { readonly ok: false; readonly reason: "invalid_bundle" | "invalid_registry" };
export function parseBundle(value: unknown): BundleResult {
  const invalid = { ok: false, reason: "invalid_bundle" } as const;
  const invalidRegistry = { ok: false, reason: "invalid_registry" } as const;
  try {
    if (!shape(value, ["definition", "application", "registry"])) return invalid;
    const { definition, application, registry } = value;
    if (!shape(application, ["id", "name", "origin"]) || !applicationIdOf(application.id) || !isPlainText(application.name, LIMITS.applicationName)
      || !normalizedOrigin(application.origin) || !shape(definition, ["id", "title", "description", "start", "steps"])
      || !isValidId(definition.id) || !isPlainText(definition.title, MAX_TITLE) || !isPlainText(definition.description, MAX_TEXT)
      || !isValidId(definition.start) || !array(definition.steps, 24, step) || definition.steps.length === 0) return invalid;
    if (!shape(registry, ["routes", "elements", "postconditionNames", "pages"]) || !array(registry.routes, LIMITS.registryRoutes, routeKey)
      || registry.routes.length === 0 || new Set(registry.routes).size !== registry.routes.length || !array(registry.elements, LIMITS.registryElements, element)
      || !array(registry.postconditionNames, LIMITS.postconditions, postconditionName) || !plain(registry.pages)) return invalidRegistry;
    const entries = Object.entries(registry.pages);
    const routes = registry.routes;
    const names = new Set(registry.postconditionNames);
    if (entries.length !== registry.routes.length || new Set(entries.map(([, route]) => route)).size !== entries.length
      || entries.some(([page, route]) => !managedPageOf(page) || !routeKey(route) || !routes.includes(route))
      || registry.postconditionNames.length !== registry.routes.length || registry.routes.some(route => !names.has(`route.${route}`))) return invalidRegistry;
    return { ok: true, bundle: { application: { id: application.id, name: application.name, origin: application.origin },
      definition: { id: definition.id, title: definition.title, description: definition.description, start: definition.start, steps: definition.steps.map(item => ({ ...item })) },
      registry: { routes: [...registry.routes], elements: registry.elements.map(item => ({ ...item, operations: [...item.operations] })),
        postconditionNames: [...registry.postconditionNames], pages: Object.fromEntries(entries.filter((entry): entry is [string, string] => typeof entry[1] === "string")) } } };
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
export function parseStatus(value: unknown): RunStatus | null {
  try {
    if (!plain(value) || value.type !== "dap-run-status" || value.version !== 1) return null;
    if (shape(value, ["type", "version", "status", "reason"]) && value.status === "refused" && reasons.includes(value.reason as Refusal)) {
      return { status: "refused", reason: value.reason as Refusal };
    }
    return shape(value, ["type", "version", "status"]) && states.includes(value.status as typeof states[number])
      ? { status: value.status as typeof states[number] } : null;
  } catch { return null; }
}
