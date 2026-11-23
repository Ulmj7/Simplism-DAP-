import { isPlainText } from "@dap/walkthrough";
import { LIMITS, bounded, count, exact, managedOperations, managedPageOf, record, routeKey, targetIdOf } from "./wire.js";
import type { Bag } from "./wire.js";

/**
 * A registered target of a Studio-managed registry (Studio V1B, D2/D3): immutable except for its status, never deleted. `references` is the number of the application's stored
 * workflows (drafts, published) that name it, so a maintainer sees what disabling it does.
 */
export interface TargetView {
  readonly id: string;
  readonly route: string;
  readonly page: string;
  readonly role: string;
  readonly label: string;
  readonly description: string;
  readonly operations: readonly string[];
  readonly privacy: "public";
  readonly status: "active" | "disabled";
  readonly references: { readonly drafts: number; readonly published: number };
  readonly updatedAt: string;
}
export interface TargetRoute { readonly route: string; readonly page: string }
export interface TargetList { readonly targets: readonly TargetView[]; readonly routes: readonly TargetRoute[]; readonly limits: { readonly maxTargets: number; readonly maxRoutes: number } }

const KEYS = ["id", "route", "page", "role", "label", "description", "operations", "privacy", "status", "references", "updatedAt"];

export function parseTargetView(value: unknown, id?: string): TargetView | null {
  if (!record(value) || !exact(value, KEYS)) return null;
  const { references, updatedAt } = value;
  if (!targetIdOf(value.id) || (id !== undefined && value.id !== id) || !routeKey(value.route) || !managedPageOf(value.page) || !bounded(value.role, LIMITS.role)
    || !isPlainText(value.label, LIMITS.label) || !isPlainText(value.description, LIMITS.description) || !managedOperations(value.role, value.operations)
    || value.privacy !== "public" || (value.status !== "active" && value.status !== "disabled")
    || !record(references) || !exact(references, ["drafts", "published"]) || !count(references.drafts, LIMITS.references) || !count(references.published, LIMITS.references)
    || !bounded(updatedAt, LIMITS.updatedAt) || !Number.isFinite(Date.parse(updatedAt))) return null;
  return {
    id: value.id, route: value.route, page: value.page, role: value.role, label: value.label, description: value.description, operations: [...value.operations], privacy: "public",
    status: value.status, references: { drafts: references.drafts, published: references.published }, updatedAt,
  };
}

export function parseTargetRoute(value: unknown): TargetRoute | null {
  return record(value) && exact(value, ["route", "page"]) && routeKey(value.route) && managedPageOf(value.page) ? { route: value.route, page: value.page } : null;
}

export function parseTargetList(value: unknown): TargetList | null {
  if (!record(value) || !exact(value, ["targets", "routes", "limits"]) || !Array.isArray(value.targets) || value.targets.length > LIMITS.targets
    || !Array.isArray(value.routes) || value.routes.length > LIMITS.routes || !record(value.limits) || !exact(value.limits, ["maxTargets", "maxRoutes"])) return null;
  const { maxTargets, maxRoutes } = value.limits as Bag;
  if (!count(maxTargets, LIMITS.targets) || maxTargets < 1 || !count(maxRoutes, LIMITS.routes) || maxRoutes < 1) return null;
  const targets: TargetView[] = [];
  for (const item of value.targets as unknown[]) {
    const parsed = parseTargetView(item);
    if (!parsed || targets.some(other => other.id === parsed.id)) return null;
    targets.push(parsed);
  }
  const routes: TargetRoute[] = [];
  for (const item of value.routes as unknown[]) {
    const parsed = parseTargetRoute(item);
    if (!parsed || routes.some(other => other.route === parsed.route || other.page === parsed.page)) return null;
    routes.push(parsed);
  }
  // Every target sits on a route of the list, on that route's page: a reply that contradicts itself is not shown.
  if (targets.length > maxTargets || routes.length > maxRoutes || !targets.every(target => routes.some(route => route.route === target.route && route.page === target.page))) return null;
  return { targets, routes, limits: { maxTargets, maxRoutes } };
}
