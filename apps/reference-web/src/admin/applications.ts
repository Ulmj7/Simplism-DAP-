import { createSemanticRegistry, ID_PATTERN, isPlainText, MAX_DESCRIPTION, MAX_LABEL, OPERATIONS, ROLES } from "@dap/walkthrough";
import type { SemanticElementDef, SemanticRegistry } from "@dap/walkthrough";
import { parseCheckList } from "./checks.js";
import type { CheckView } from "./checks.js";
import { LIMITS, POSTCONDITION, REGISTRY_ID, APPLICATION_ID, exact, registryPageOf, normalizedOrigin, pageOf, record, routeKey, unsafeKey } from "./wire.js";
import type { Bag } from "./wire.js";

/** Applications (Studio V1A, D1/D2): trusted, tenant-scoped records the host owns. Every reply is parsed against an exact shape. */
export type ApplicationEnvironment = "development" | "test";
export const ENVIRONMENTS: readonly ApplicationEnvironment[] = ["development", "test"];
export const MAX_APPLICATION_ORIGINS = LIMITS.origins;
export const MAX_APPLICATIONS = LIMITS.applications;
/** The reserved registry key of a Studio-managed registry (V1B D1): the registry source follows from it and nothing else. */
export const MANAGED_REGISTRY_ID = "studio-managed";
export type RegistrySource = "built-in" | "studio-managed";
export const sourceOf = (registryId: string): RegistrySource => (registryId === MANAGED_REGISTRY_ID ? "studio-managed" : "built-in");

export type ApplicationRouting = "hash" | "history";
export interface ApplicationInput {
  readonly name: string;
  readonly origin: string;
  readonly allowedOrigins: readonly string[];
  readonly environment: ApplicationEnvironment;
  readonly registryId: string;
  /** How pages are addressed (`hash`: `/#/orders`; `history`: pathnames). Cannot change once the application has registered routes. */
  readonly routing: ApplicationRouting;
  /** Whether the application's published guides may be delivered to its own pages through the runtime key. */
  readonly runtimeAccess: boolean;
}
export interface ApplicationCounts { readonly targets: number; readonly drafts: number; readonly published: number }
export interface ApplicationView extends ApplicationInput {
  readonly id: string; readonly enabled: boolean; readonly updatedAt: string; readonly source: RegistrySource;
  /** Studio completion S2/S7: the public runtime key (opaque; present once runtime access was switched on) and the counts of the overview. */
  readonly runtimeKey: string | null; readonly counts: ApplicationCounts;
}
export interface RegistryChoice { readonly id: string; readonly label: string; readonly source: RegistrySource }
export interface ApplicationList { readonly applications: readonly ApplicationView[]; readonly registries: readonly RegistryChoice[] }
export interface ApplicationRegistry {
  readonly routes: readonly string[];
  readonly elements: readonly SemanticElementDef[];
  readonly postconditionNames: readonly string[];
  /** Whether the application's targets can be previewed (see `previewMode` for where). */
  readonly previewable: boolean;
  readonly source: RegistrySource;
  /** `page` (`pathname + hash`) -> registry route. */
  readonly pages: Readonly<Record<string, string>>;
  /** `in-app`: the reference web app runs the guide; `application-window`: the application's own window does (a later step). */
  readonly previewMode: "in-app" | "application-window";
  readonly registry: SemanticRegistry;
  /** The verification checks of a Studio-managed registry (S4); empty for a built-in one or a host that predates checks. */
  readonly checks: readonly CheckView[];
}

const object = record;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const sourceValue = (value: unknown, registryId: string): value is RegistrySource => (value === "built-in" || value === "studio-managed") && value === sourceOf(registryId);

const environment = (value: unknown): value is ApplicationEnvironment => (ENVIRONMENTS as readonly unknown[]).includes(value);
function origins(value: unknown, origin: string): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= MAX_APPLICATION_ORIGINS && (value as unknown[]).every(normalizedOrigin)
    && new Set(value as string[]).size === value.length && (value as string[]).includes(origin);
}

/** The runtime key is an OPAQUE public identifier `rk-…` (at most 80 URL-safe characters): its inside is the host's business and is never parsed here. */
export const RUNTIME_KEY = /^rk-[A-Za-z0-9_-]{1,77}$/;
const MAX_COUNT = 1_000_000;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT;
function parseCounts(value: unknown): ApplicationCounts | null {
  if (!object(value) || !exact(value, ["targets", "drafts", "published"]) || !count(value.targets) || !count(value.drafts) || !count(value.published)) return null;
  return { targets: value.targets, drafts: value.drafts, published: value.published };
}

export function parseApplication(value: unknown, id?: string): ApplicationView | null {
  if (!object(value) || !exact(value, ["id", "name", "origin", "allowedOrigins", "environment", "registryId", "enabled", "updatedAt", "source", "routing", "runtimeAccess", "runtimeKey", "counts"])) return null;
  const { name, origin, allowedOrigins, registryId, updatedAt } = value;
  if (typeof value.id !== "string" || !APPLICATION_ID.test(value.id) || (id !== undefined && value.id !== id) || !text(name, LIMITS.applicationName) || !normalizedOrigin(origin)
    || !origins(allowedOrigins, origin) || !environment(value.environment) || typeof registryId !== "string" || !REGISTRY_ID.test(registryId) || !sourceValue(value.source, registryId)
    || typeof value.enabled !== "boolean" || !text(updatedAt, LIMITS.updatedAt) || !Number.isFinite(Date.parse(updatedAt))) return null;
  const { routing, runtimeAccess, runtimeKey } = value;
  if ((routing !== "hash" && routing !== "history") || typeof runtimeAccess !== "boolean" || !(runtimeKey === null || (typeof runtimeKey === "string" && RUNTIME_KEY.test(runtimeKey)))
    // Only a Studio-managed application is delivered: a built-in one is hash-routed and has neither access nor a key.
    || (value.source === "built-in" && (routing !== "hash" || runtimeAccess || runtimeKey !== null))) return null;
  const counts = parseCounts(value.counts);
  if (counts === null) return null;
  return { id: value.id, name, origin, allowedOrigins: [...allowedOrigins], environment: value.environment, registryId, enabled: value.enabled, updatedAt, source: value.source, routing, runtimeAccess, runtimeKey, counts };
}

export function parseApplicationList(value: unknown): ApplicationList | null {
  if (!object(value) || !exact(value, ["applications", "registries"]) || !Array.isArray(value.applications) || value.applications.length > MAX_APPLICATIONS
    || !Array.isArray(value.registries) || value.registries.length > LIMITS.registries) return null;
  const applications: ApplicationView[] = [];
  for (const item of value.applications as unknown[]) {
    const parsed = parseApplication(item);
    if (!parsed || applications.some(other => other.id === parsed.id)) return null;
    applications.push(parsed);
  }
  const registries: RegistryChoice[] = [];
  for (const item of value.registries as unknown[]) {
    if (!object(item) || !exact(item, ["id", "label", "source"]) || typeof item.id !== "string" || !REGISTRY_ID.test(item.id) || !text(item.label, LIMITS.registryLabel)
      || !sourceValue(item.source, item.id) || registries.some(other => other.id === item.id)) return null;
    registries.push({ id: item.id, label: item.label, source: item.source });
  }
  return { applications, registries };
}

/** `page` -> route: closed, bounded, every page well-formed and every route one of the registry's. */
function parsePages(value: unknown, routes: readonly unknown[], managed: boolean): Readonly<Record<string, string>> | null {
  if (!object(value)) return null;
  const entries = Object.entries(value as Bag);
  if (entries.length > LIMITS.pages) return null;
  const pages: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [page, route] of entries) {
    if (unsafeKey(page) || !(managed ? registryPageOf(page) : pageOf(page)) || !routeKey(route) || !routes.includes(route)) return null;
    pages[page] = route;
  }
  return Object.freeze({ ...pages });
}

/** Public targets only: a private element in this reply breaks the contract, so the whole reply is refused. */
export function parseApplicationRegistry(value: unknown): ApplicationRegistry | null {
  const hasChecks = object(value) && Object.hasOwn(value, "checks");
  const parsedChecks = hasChecks ? parseCheckList({ checks: (value as Bag).checks }) : [];
  if (!object(value) || !exact(value, ["routes", "elements", "postconditionNames", "previewable", "source", "pages", "previewMode", ...(hasChecks ? ["checks"] : [])]) || parsedChecks === null || typeof value.previewable !== "boolean"
    || (value.source !== "built-in" && value.source !== "studio-managed") || (value.previewMode !== "in-app" && value.previewMode !== "application-window")
    || !Array.isArray(value.routes) || !value.routes.every(routeKey) || value.routes.length > LIMITS.registryRoutes || !Array.isArray(value.elements) || value.elements.length > LIMITS.registryElements
    || !Array.isArray(value.postconditionNames) || value.postconditionNames.length > LIMITS.postconditions) return null;
  const names = value.postconditionNames as unknown[];
  if (!names.every(name => typeof name === "string" && name.length <= LIMITS.postconditionChars && POSTCONDITION.test(name)) || new Set(names).size !== names.length) return null;
  const pages = parsePages(value.pages, value.routes as unknown[], value.source === "studio-managed");
  if (pages === null) return null;
  const elements: SemanticElementDef[] = [];
  for (const item of value.elements as unknown[]) {
    if (!object(item) || !exact(item, ["id", "route", "role", "label", "description", "operations", "privacy"]) || item.privacy !== "public"
      || typeof item.id !== "string" || item.id.length > 80 || !ID_PATTERN.test(item.id) || !routeKey(item.route)
      || !(ROLES as readonly unknown[]).includes(item.role) || !isPlainText(item.label, MAX_LABEL) || !isPlainText(item.description, MAX_DESCRIPTION)
      || !Array.isArray(item.operations) || item.operations.length === 0 || item.operations.length > OPERATIONS.length
      || !(item.operations as unknown[]).every(operation => (OPERATIONS as readonly unknown[]).includes(operation))) return null;
    elements.push(item as unknown as SemanticElementDef);
  }
  try {
    // The semantic registry is the one validator for ids, routes and duplicates; a throw means the reply is not a usable registry.
    const registry = createSemanticRegistry({ routes: value.routes as string[], elements });
    return { routes: registry.routes, elements: registry.list(), postconditionNames: names as string[], previewable: value.previewable, source: value.source, pages, previewMode: value.previewMode, registry, checks: parsedChecks };
  } catch { return null; }
}

/** `GET …/overview` (S2): the application, how many targets are in which state and health, and how many workflows are drafts or published. */
export interface ApplicationOverview {
  readonly application: ApplicationView;
  readonly targets: { readonly total: number; readonly active: number; readonly disabled: number; readonly healthy: number; readonly unverified: number; readonly broken: number };
  readonly workflows: { readonly draft: number; readonly published: number };
}
export function parseOverview(value: unknown, id?: string): ApplicationOverview | null {
  if (!object(value) || !exact(value, ["application", "targets", "workflows"])) return null;
  const application = parseApplication(value.application, id);
  const { targets, workflows } = value;
  if (!application || !object(targets) || !exact(targets, ["total", "active", "disabled", "healthy", "unverified", "broken"]) || !object(workflows) || !exact(workflows, ["draft", "published"])) return null;
  const numbers = [targets.total, targets.active, targets.disabled, targets.healthy, targets.unverified, targets.broken, workflows.draft, workflows.published];
  if (!numbers.every(count)) return null;
  const { total, active, disabled, healthy, unverified, broken } = targets as Record<string, number>;
  // The two splits of the targets each add up to the total, and the overview agrees with the application's own counts.
  if (active! + disabled! !== total || healthy! + unverified! + broken! !== total || total !== application.counts.targets
    || workflows.draft !== application.counts.drafts || workflows.published !== application.counts.published) return null;
  return { application, targets: { total: total!, active: active!, disabled: disabled!, healthy: healthy!, unverified: unverified!, broken: broken! }, workflows: { draft: workflows.draft as number, published: workflows.published as number } };
}
