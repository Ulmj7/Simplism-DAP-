import { createSemanticRegistry, ID_PATTERN, isPlainText, MAX_DESCRIPTION, MAX_LABEL, OPERATIONS, ROLES } from "@dap/walkthrough";
import type { SemanticElementDef, SemanticRegistry } from "@dap/walkthrough";
import { LIMITS, POSTCONDITION, REGISTRY_ID, APPLICATION_ID, exact, normalizedOrigin, pageOf, record, routeKey, unsafeKey } from "./wire.js";
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

export interface ApplicationInput {
  readonly name: string;
  readonly origin: string;
  readonly allowedOrigins: readonly string[];
  readonly environment: ApplicationEnvironment;
  readonly registryId: string;
}
export interface ApplicationView extends ApplicationInput { readonly id: string; readonly enabled: boolean; readonly updatedAt: string; readonly source: RegistrySource }
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
}

const object = record;
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const sourceValue = (value: unknown, registryId: string): value is RegistrySource => (value === "built-in" || value === "studio-managed") && value === sourceOf(registryId);

const environment = (value: unknown): value is ApplicationEnvironment => (ENVIRONMENTS as readonly unknown[]).includes(value);
function origins(value: unknown, origin: string): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= MAX_APPLICATION_ORIGINS && (value as unknown[]).every(normalizedOrigin)
    && new Set(value as string[]).size === value.length && (value as string[]).includes(origin);
}

export function parseApplication(value: unknown, id?: string): ApplicationView | null {
  if (!object(value) || !exact(value, ["id", "name", "origin", "allowedOrigins", "environment", "registryId", "enabled", "updatedAt", "source"])) return null;
  const { name, origin, allowedOrigins, registryId, updatedAt } = value;
  if (typeof value.id !== "string" || !APPLICATION_ID.test(value.id) || (id !== undefined && value.id !== id) || !text(name, LIMITS.applicationName) || !normalizedOrigin(origin)
    || !origins(allowedOrigins, origin) || !environment(value.environment) || typeof registryId !== "string" || !REGISTRY_ID.test(registryId) || !sourceValue(value.source, registryId)
    || typeof value.enabled !== "boolean" || !text(updatedAt, LIMITS.updatedAt) || !Number.isFinite(Date.parse(updatedAt))) return null;
  return { id: value.id, name, origin, allowedOrigins: [...allowedOrigins], environment: value.environment, registryId, enabled: value.enabled, updatedAt, source: value.source };
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
function parsePages(value: unknown, routes: readonly unknown[]): Readonly<Record<string, string>> | null {
  if (!object(value)) return null;
  const entries = Object.entries(value as Bag);
  if (entries.length > LIMITS.pages) return null;
  const pages: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [page, route] of entries) {
    if (unsafeKey(page) || !pageOf(page) || !routeKey(route) || !routes.includes(route)) return null;
    pages[page] = route;
  }
  return Object.freeze({ ...pages });
}

/** Public targets only: a private element in this reply breaks the contract, so the whole reply is refused. */
export function parseApplicationRegistry(value: unknown): ApplicationRegistry | null {
  if (!object(value) || !exact(value, ["routes", "elements", "postconditionNames", "previewable", "source", "pages", "previewMode"]) || typeof value.previewable !== "boolean"
    || (value.source !== "built-in" && value.source !== "studio-managed") || (value.previewMode !== "in-app" && value.previewMode !== "application-window")
    || !Array.isArray(value.routes) || value.routes.length > LIMITS.registryRoutes || !Array.isArray(value.elements) || value.elements.length > LIMITS.registryElements
    || !Array.isArray(value.postconditionNames) || value.postconditionNames.length > LIMITS.postconditions) return null;
  const names = value.postconditionNames as unknown[];
  if (!names.every(name => typeof name === "string" && name.length <= LIMITS.postconditionChars && POSTCONDITION.test(name)) || new Set(names).size !== names.length) return null;
  const pages = parsePages(value.pages, value.routes as unknown[]);
  if (pages === null) return null;
  const elements: SemanticElementDef[] = [];
  for (const item of value.elements as unknown[]) {
    if (!object(item) || !exact(item, ["id", "route", "role", "label", "description", "operations", "privacy"]) || item.privacy !== "public"
      || typeof item.id !== "string" || item.id.length > 80 || !ID_PATTERN.test(item.id) || typeof item.route !== "string"
      || !(ROLES as readonly unknown[]).includes(item.role) || !isPlainText(item.label, MAX_LABEL) || !isPlainText(item.description, MAX_DESCRIPTION)
      || !Array.isArray(item.operations) || item.operations.length === 0 || item.operations.length > OPERATIONS.length
      || !(item.operations as unknown[]).every(operation => (OPERATIONS as readonly unknown[]).includes(operation))) return null;
    elements.push(item as unknown as SemanticElementDef);
  }
  try {
    // The semantic registry is the one validator for ids, routes and duplicates; a throw means the reply is not a usable registry.
    const registry = createSemanticRegistry({ routes: value.routes as string[], elements });
    return { routes: registry.routes, elements: registry.list(), postconditionNames: names as string[], previewable: value.previewable, source: value.source, pages, previewMode: value.previewMode, registry };
  } catch { return null; }
}
