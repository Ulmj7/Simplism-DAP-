import { isPlainText } from "@dap/walkthrough";
import { LIMITS, bounded, count, exact, managedOperations, managedPageOf, record, routeKey, targetIdOf } from "./wire.js";
import type { Bag } from "./wire.js";

/**
 * A registered target of a Studio-managed registry (Studio V1B, D2/D3): immutable except for its status, never deleted. `references` is the number of the application's stored
 * workflows (drafts, published) that name it, so a maintainer sees what disabling it does.
 */
export type TargetHealth = "unverified" | "healthy" | "broken";
export const HEALTHS: readonly TargetHealth[] = ["unverified", "healthy", "broken"];
export interface TargetView {
  readonly id: string;
  /** The `data-ai-id` the page carries for this target (live evidence; the durable identity is `id`). */
  readonly marker: string;
  readonly route: string;
  readonly page: string;
  readonly role: string;
  readonly label: string;
  readonly description: string;
  readonly operations: readonly string[];
  readonly privacy: "public";
  readonly status: "active" | "disabled";
  readonly health: TargetHealth;
  /** When the health was last determined (a page check or a repair); `null` = never. */
  readonly healthCheckedAt: string | null;
  readonly revision: number;
  readonly references: { readonly drafts: number; readonly published: number };
  readonly updatedAt: string;
}
export interface TargetRoute { readonly route: string; readonly page: string }
export interface TargetList { readonly targets: readonly TargetView[]; readonly routes: readonly TargetRoute[]; readonly limits: { readonly maxTargets: number; readonly maxRoutes: number } }

const KEYS = ["id", "marker", "route", "page", "role", "label", "description", "operations", "privacy", "status", "health", "healthCheckedAt", "revision", "references", "updatedAt"];
const when = (value: unknown): value is string => bounded(value, LIMITS.updatedAt) && Number.isFinite(Date.parse(value));

export function parseTargetView(value: unknown, id?: string): TargetView | null {
  if (!record(value) || !exact(value, KEYS)) return null;
  const { references, updatedAt } = value;
  if (!targetIdOf(value.id) || (id !== undefined && value.id !== id) || !targetIdOf(value.marker) || !(HEALTHS as readonly unknown[]).includes(value.health)
    || !(value.healthCheckedAt === null || when(value.healthCheckedAt)) || !count(value.revision, LIMITS.revision) || value.revision < 1 || !routeKey(value.route) || !managedPageOf(value.page) || !bounded(value.role, LIMITS.role)
    || !isPlainText(value.label, LIMITS.label) || !isPlainText(value.description, LIMITS.description) || !managedOperations(value.role, value.operations)
    || value.privacy !== "public" || (value.status !== "active" && value.status !== "disabled")
    || !record(references) || !exact(references, ["drafts", "published"]) || !count(references.drafts, LIMITS.references) || !count(references.published, LIMITS.references)
    || !bounded(updatedAt, LIMITS.updatedAt) || !Number.isFinite(Date.parse(updatedAt))) return null;
  return {
    id: value.id, marker: value.marker, route: value.route, page: value.page, role: value.role, label: value.label, description: value.description, operations: [...value.operations], privacy: "public",
    status: value.status, health: value.health as TargetHealth, healthCheckedAt: value.healthCheckedAt, revision: value.revision, references: { drafts: references.drafts, published: references.published }, updatedAt,
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

/** The five fields a repair can change: the stored value before/after, or what a repair proposes. All of them or (in a change row) any subset. */
export interface RepairFields { readonly marker: string; readonly role: string; readonly operations: readonly string[]; readonly label: string; readonly description: string }
export function parseRepairFields(value: unknown, partial = false): RepairFields | Partial<RepairFields> | null {
  const keys = ["marker", "role", "operations", "label", "description"];
  if (!record(value) || (partial ? !Object.keys(value).every(key => keys.includes(key)) : !exact(value, keys))) return null;
  const out: { -readonly [K in keyof RepairFields]?: RepairFields[K] } = {};
  if (value.marker !== undefined) { if (!targetIdOf(value.marker)) return null; out.marker = value.marker; }
  if (value.role !== undefined) { if (!bounded(value.role, LIMITS.role)) return null; out.role = value.role; }
  if (value.operations !== undefined) { if (!Array.isArray(value.operations) || value.operations.length < 1 || value.operations.length > LIMITS.operations || !value.operations.every(item => typeof item === "string" && bounded(item, 16))) return null; out.operations = [...value.operations as string[]]; }
  if (value.label !== undefined) { if (!isPlainText(value.label, LIMITS.label)) return null; out.label = value.label; }
  if (value.description !== undefined) { if (!isPlainText(value.description, LIMITS.description)) return null; out.description = value.description; }
  return out;
}

/** A workflow that names a target: drafts by id and title, published by id, title and the live version. */
export interface UsageDraft { readonly id: string; readonly title: string }
export interface UsagePublished extends UsageDraft { readonly version: number }
export interface TargetUsage { readonly drafts: readonly UsageDraft[]; readonly published: readonly UsagePublished[] }
const workflowId = (value: unknown): value is string => typeof value === "string" && /^wt-[a-f0-9]{12}$/u.test(value);
export function parseUsage(value: unknown): TargetUsage | null {
  if (!record(value) || !exact(value, ["drafts", "published"]) || !Array.isArray(value.drafts) || !Array.isArray(value.published) || value.drafts.length > LIMITS.usage || value.published.length > LIMITS.usage) return null;
  const drafts: UsageDraft[] = []; const published: UsagePublished[] = [];
  for (const item of value.drafts as unknown[]) {
    if (!record(item) || !exact(item, ["id", "title"]) || !workflowId(item.id) || !isPlainText(item.title, LIMITS.label)) return null;
    drafts.push({ id: item.id, title: item.title });
  }
  for (const item of value.published as unknown[]) {
    if (!record(item) || !exact(item, ["id", "title", "version"]) || !workflowId(item.id) || !isPlainText(item.title, LIMITS.label) || !count(item.version, LIMITS.revision) || item.version < 1) return null;
    published.push({ id: item.id, title: item.title, version: item.version });
  }
  return { drafts, published };
}

export interface TargetChange { readonly revision: number; readonly changedAt: string; readonly changedBy: string; readonly before: Partial<RepairFields>; readonly after: Partial<RepairFields> }
export interface TargetDetail extends TargetView { readonly usage: TargetUsage; readonly changes: readonly TargetChange[] }
/** `GET …/targets/:targetId`: the view plus its usage and its change history (repairs, newest last as stored). */
export function parseTargetDetail(value: unknown, id?: string): TargetDetail | null {
  if (!record(value) || !exact(value, [...KEYS, "usage", "changes"])) return null;
  const { usage, changes, ...view } = value;
  const parsed = parseTargetView(view, id);
  const used = parseUsage(usage);
  if (!parsed || !used || !Array.isArray(changes) || changes.length > LIMITS.changes) return null;
  const list: TargetChange[] = [];
  for (const item of changes as unknown[]) {
    if (!record(item) || !exact(item, ["revision", "changedAt", "changedBy", "before", "after"]) || !count(item.revision, LIMITS.revision) || item.revision < 1 || !when(item.changedAt)
      || !bounded(item.changedBy, LIMITS.actor) || /[\u0000-\u001f\u007f]/u.test(item.changedBy)) return null;
    const before = parseRepairFields(item.before, true); const after = parseRepairFields(item.after, true);
    if (!before || !after) return null;
    list.push({ revision: item.revision, changedAt: item.changedAt, changedBy: item.changedBy, before, after });
  }
  return { ...parsed, usage: used, changes: list };
}
