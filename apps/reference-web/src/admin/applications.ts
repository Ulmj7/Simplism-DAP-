import { createSemanticRegistry, ID_PATTERN, isPlainText, MAX_DESCRIPTION, MAX_LABEL, OPERATIONS, ROLES } from "@dap/walkthrough";
import type { SemanticElementDef, SemanticRegistry } from "@dap/walkthrough";
import { APPLICATION_ID, normalizedOrigin } from "./studio-client.js";

/** Applications (Studio V1A, D1/D2): trusted, tenant-scoped records the host owns. Every reply is parsed against an exact shape. */
export type ApplicationEnvironment = "development" | "test";
export const ENVIRONMENTS: readonly ApplicationEnvironment[] = ["development", "test"];
export const MAX_APPLICATION_ORIGINS = 5;
export const MAX_APPLICATIONS = 50;

export interface ApplicationInput {
  readonly name: string;
  readonly origin: string;
  readonly allowedOrigins: readonly string[];
  readonly environment: ApplicationEnvironment;
  readonly registryId: string;
}
export interface ApplicationView extends ApplicationInput { readonly id: string; readonly enabled: boolean; readonly updatedAt: string }
export interface RegistryChoice { readonly id: string; readonly label: string }
export interface ApplicationList { readonly applications: readonly ApplicationView[]; readonly registries: readonly RegistryChoice[] }
export interface ApplicationRegistry {
  readonly routes: readonly string[];
  readonly elements: readonly SemanticElementDef[];
  readonly postconditionNames: readonly string[];
  /** True only when the registry belongs to the reference application, whose runtime can run a preview. */
  readonly previewable: boolean;
  readonly registry: SemanticRegistry;
}

type Bag = Record<string, unknown>;
const object = (value: unknown): value is Bag => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Bag, keys: readonly string[]) => { const present = Object.keys(value); return present.length === keys.length && keys.every(key => present.includes(key)); };
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const REGISTRY_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const POSTCONDITION = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/u;

const environment = (value: unknown): value is ApplicationEnvironment => (ENVIRONMENTS as readonly unknown[]).includes(value);
function origins(value: unknown, origin: string): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= MAX_APPLICATION_ORIGINS && (value as unknown[]).every(normalizedOrigin)
    && new Set(value as string[]).size === value.length && (value as string[]).includes(origin);
}

export function parseApplication(value: unknown, id?: string): ApplicationView | null {
  if (!object(value) || !exact(value, ["id", "name", "origin", "allowedOrigins", "environment", "registryId", "enabled", "updatedAt"])) return null;
  const { name, origin, allowedOrigins, registryId, updatedAt } = value;
  if (typeof value.id !== "string" || !APPLICATION_ID.test(value.id) || (id !== undefined && value.id !== id) || !text(name, 80) || !normalizedOrigin(origin)
    || !origins(allowedOrigins, origin) || !environment(value.environment) || typeof registryId !== "string" || !REGISTRY_ID.test(registryId)
    || typeof value.enabled !== "boolean" || !text(updatedAt, 32) || !Number.isFinite(Date.parse(updatedAt))) return null;
  return { id: value.id, name, origin, allowedOrigins: [...allowedOrigins], environment: value.environment, registryId, enabled: value.enabled, updatedAt };
}

export function parseApplicationList(value: unknown): ApplicationList | null {
  if (!object(value) || !exact(value, ["applications", "registries"]) || !Array.isArray(value.applications) || value.applications.length > MAX_APPLICATIONS
    || !Array.isArray(value.registries) || value.registries.length > 20) return null;
  const applications: ApplicationView[] = [];
  for (const item of value.applications as unknown[]) {
    const parsed = parseApplication(item);
    if (!parsed || applications.some(other => other.id === parsed.id)) return null;
    applications.push(parsed);
  }
  const registries: RegistryChoice[] = [];
  for (const item of value.registries as unknown[]) {
    if (!object(item) || !exact(item, ["id", "label"]) || typeof item.id !== "string" || !REGISTRY_ID.test(item.id) || !text(item.label, 80)
      || registries.some(other => other.id === item.id)) return null;
    registries.push({ id: item.id, label: item.label });
  }
  return { applications, registries };
}

/** Public targets only: a private element in this reply breaks the contract, so the whole reply is refused. */
export function parseApplicationRegistry(value: unknown): ApplicationRegistry | null {
  if (!object(value) || !exact(value, ["routes", "elements", "postconditionNames", "previewable"]) || typeof value.previewable !== "boolean"
    || !Array.isArray(value.routes) || value.routes.length > 20 || !Array.isArray(value.elements) || value.elements.length > 200
    || !Array.isArray(value.postconditionNames) || value.postconditionNames.length > 50) return null;
  const names = value.postconditionNames as unknown[];
  if (!names.every(name => typeof name === "string" && name.length <= 80 && POSTCONDITION.test(name)) || new Set(names).size !== names.length) return null;
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
    return { routes: registry.routes, elements: registry.list(), postconditionNames: names as string[], previewable: value.previewable, registry };
  } catch { return null; }
}
