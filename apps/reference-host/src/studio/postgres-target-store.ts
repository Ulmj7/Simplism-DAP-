/**
 * PostgreSQL implementation of the Studio-managed registry store (Studio V1B). Narrow, parameterised SQL; every statement runs inside `withTenant`, so forced row-level security confines it to
 * the caller's own tenant. Writes serialise per application with an advisory transaction lock (so the check-then-insert of a route and the caps are race-free) AFTER locking the application
 * row FOR SHARE; the database repeats every shape rule, the caps and the immutability as CHECKs and triggers (migration 074).
 */
import { withTenant } from "../authoring/tenant-tx.js";
import type { TenantClient, TenantPool } from "../authoring/tenant-tx.js";
import type { TrustedRegistryData } from "../authoring/trusted-registry.js";
import { STUDIO_MANAGED_REGISTRY_ID, isApplicationId } from "./applications.js";
import { lockApplicationForRegistryChange, lockApplicationShared } from "./application-lock.js";
import { isPageFor, isTargetId } from "./registry-targets.js";
import { VALUE_CHECK_ROLES, isCheckName } from "./registry-checks.js";
import type { CheckKind, CheckAttribute, CheckRecord, CheckStatus, CheckView } from "./registry-checks.js";
import type { RegistryRouteRecord, TargetOperation, TargetRecord, TargetView, RegistrableRole } from "./registry-targets.js";
import type { CheckRegisterOutcome, CheckStatusOutcome, DefinitionUsing, HealthOutcome, ManagedRegistry, RegisterOutcome, RepairFields, RepairOutcome, TargetChange, TargetListing, TargetStatusOutcome, TargetStore } from "./target-store.js";
import { impactOf } from "./repair-impact.js";

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const ACTOR = (actor: unknown): actor is string => typeof actor === "string" && actor.length >= 1 && actor.length <= 256;
const TARGET_COLUMNS = "t.target_id, t.marker, t.route, r.page, t.role, t.label, t.description, t.operations, t.privacy, t.status, t.health, t.health_checked_at, t.revision, t.updated_at";

function toRecord(row: Record<string, unknown>): TargetRecord {
  const status = row.status;
  if (status !== "active" && status !== "disabled") throw new Error("Unexpected stored status");
  const operations = row.operations;
  if (!Array.isArray(operations) || !operations.every((item) => typeof item === "string")) throw new Error("Unexpected stored operations");
  const health = row.health;
  if (health !== "unverified" && health !== "healthy" && health !== "broken") throw new Error("Unexpected stored health");
  return Object.freeze({
    id: String(row.target_id), marker: String(row.marker), route: String(row.route), page: String(row.page), role: String(row.role) as RegistrableRole, label: String(row.label), description: String(row.description),
    operations: Object.freeze([...(operations as TargetOperation[])]), privacy: "public" as const, status, health, healthCheckedAt: row.health_checked_at === null || row.health_checked_at === undefined ? null : iso(row.health_checked_at),
    revision: Number(row.revision), updatedAt: iso(row.updated_at),
  });
}

/** The current draft and the live snapshot are independent. Older snapshots are history only. */
const workflows = `
  SELECT d.walkthrough_id, d.status, d.definition, d.updated_at, NULL::int AS version
    FROM public.walkthrough_definitions d WHERE d.tenant_id = $1::uuid AND d.application_id = $2 AND d.status = 'draft'
  UNION ALL
  SELECT v.walkthrough_id, 'published', v.definition, v.published_at, v.version
    FROM public.walkthrough_definitions d JOIN public.walkthrough_versions v
      ON v.tenant_id = d.tenant_id AND v.walkthrough_id = d.walkthrough_id AND v.version = d.live_version
    WHERE v.tenant_id = $1::uuid AND v.application_id = $2`;
const workflowSteps = "jsonb_array_elements(CASE WHEN jsonb_typeof(d.definition->'steps') = 'array' THEN d.definition->'steps' ELSE '[]'::jsonb END)";

/** How many of the application's stored definitions name each target id, split by status. Counts definitions, not steps. */
async function referenceCounts(client: TenantClient, tenantId: string, applicationId: string): Promise<ReadonlyMap<string, { drafts: number; published: number }>> {
  const { rows } = await client.query(
    `SELECT s.target AS target_id,
            count(DISTINCT d.walkthrough_id) FILTER (WHERE d.status = 'draft')::int AS drafts,
            count(DISTINCT d.walkthrough_id) FILTER (WHERE d.status = 'published')::int AS published
       FROM (${workflows}) d
       CROSS JOIN LATERAL (SELECT step->>'target' AS target
                             FROM ${workflowSteps} AS step
                            WHERE jsonb_typeof(step) = 'object') s
      WHERE s.target IS NOT NULL
      GROUP BY s.target`, [tenantId, applicationId]);
  return new Map(rows.map((row) => [String(row.target_id), { drafts: Number(row.drafts), published: Number(row.published) }] as const));
}

function toCheck(row: Record<string, unknown>): CheckRecord {
  const status = row.status;
  if (status !== "active" && status !== "disabled") throw new Error("Unexpected stored status");
  const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
  return Object.freeze({ name: String(row.name), kind: String(row.kind) as CheckKind, targetId: text(row.target_id), route: text(row.route), attribute: text(row.attribute) as CheckAttribute | null, expected: text(row.expected), status });
}

/** How many stored definitions name each check as the `verify` of a step, split by status. */
async function checkReferenceCounts(client: TenantClient, tenantId: string, applicationId: string): Promise<ReadonlyMap<string, { drafts: number; published: number }>> {
  const { rows } = await client.query(
    `SELECT s.verify AS name,
            count(DISTINCT d.walkthrough_id) FILTER (WHERE d.status = 'draft')::int AS drafts,
            count(DISTINCT d.walkthrough_id) FILTER (WHERE d.status = 'published')::int AS published
       FROM (${workflows}) d
       CROSS JOIN LATERAL (SELECT step->>'verify' AS verify
                             FROM ${workflowSteps} AS step
                            WHERE jsonb_typeof(step) = 'object') s
      WHERE s.verify LIKE 'check.v%'
      GROUP BY s.verify`, [tenantId, applicationId]);
  return new Map(rows.map((row) => [String(row.name), { drafts: Number(row.drafts), published: Number(row.published) }] as const));
}

async function readRegistry(client: TenantClient, tenantId: string, applicationId: string): Promise<ManagedRegistry> {
  const routes = await client.query("SELECT route, page FROM public.studio_registry_routes WHERE tenant_id = $1::uuid AND application_id = $2 ORDER BY created_at, route", [tenantId, applicationId]);
  const targets = await client.query(
    `SELECT t.target_id, t.marker, t.route, t.role, t.label, t.description, t.operations, t.privacy FROM public.studio_registry_targets t
      WHERE t.tenant_id = $1::uuid AND t.application_id = $2 AND t.status = 'active' ORDER BY t.created_at, t.target_id`, [tenantId, applicationId]);
  const checks = await client.query(
    `SELECT c.name, c.kind, c.target_id, c.route, c.attribute, c.expected, c.status FROM public.studio_registry_checks c
       LEFT JOIN public.studio_registry_targets t ON t.tenant_id = c.tenant_id AND t.application_id = c.application_id AND t.target_id = c.target_id
      WHERE c.tenant_id = $1::uuid AND c.application_id = $2 AND c.status = 'active' AND (c.target_id IS NULL OR t.status = 'active') ORDER BY c.created_at, c.name`, [tenantId, applicationId]);
  return Object.freeze({
    checks: Object.freeze(checks.rows.map(toCheck)),
    routes: Object.freeze(routes.rows.map((row): RegistryRouteRecord => Object.freeze({ route: String(row.route), page: String(row.page) }))),
    elements: Object.freeze(targets.rows.map((row) => Object.freeze({
      id: String(row.target_id), route: String(row.route), role: String(row.role), label: String(row.label), description: String(row.description),
      operations: Object.freeze([...(row.operations as string[])]), privacy: "public",
    }))) as unknown as TrustedRegistryData["elements"],
    markers: Object.freeze(Object.fromEntries(targets.rows.map((row) => [String(row.target_id), String(row.marker)]))),
  });
}

/** Thrown inside the repair transaction to undo it when a workflow would stop validating. */
class RepairRollback extends Error { constructor(readonly problems: readonly string[]) { super("repair rolled back"); } }

const fieldsOf = (value: unknown): RepairFields => {
  const bag = (value ?? {}) as Record<string, unknown>;
  return Object.freeze({ marker: String(bag.marker), role: String(bag.role), operations: Object.freeze(Array.isArray(bag.operations) ? bag.operations.map(String) : []), label: String(bag.label), description: String(bag.description) });
};

/** The tenant's stored workflows of one application that name the target in a step: drafts and live publication snapshots. */
async function readDefinitionsUsing(client: TenantClient, tenantId: string, applicationId: string, targetId: string): Promise<readonly DefinitionUsing[]> {
  const { rows } = await client.query(
    `SELECT d.walkthrough_id, d.status, d.definition, d.version FROM (${workflows}) d
      WHERE EXISTS (SELECT 1 FROM ${workflowSteps} AS step
          WHERE jsonb_typeof(step) = 'object' AND (step->>'target' = $3 OR EXISTS (
            SELECT 1 FROM public.studio_registry_checks c
              WHERE c.tenant_id = $1::uuid AND c.application_id = $2 AND c.target_id = $3
                AND c.name = step->>'verify')))
      ORDER BY d.updated_at DESC, d.walkthrough_id`, [tenantId, applicationId, targetId]);
  return Object.freeze(rows.map((row): DefinitionUsing => {
    const definition = row.definition as Record<string, unknown> | null;
    const title = typeof definition?.title === "string" ? definition.title : String(row.walkthrough_id);
    return Object.freeze({ id: String(row.walkthrough_id), title, status: row.status === "published" ? "published" as const : "draft" as const, version: row.version === null ? null : Number(row.version), definition: row.definition });
  }));
}

const constraintOf = (error: unknown): string | undefined => (typeof error === "object" && error !== null ? (error as { constraint?: string }).constraint : undefined);

export function createPostgresTargetStore(pool: TenantPool): TargetStore {
  const store: TargetStore = {
    async list(tenantId, applicationId): Promise<TargetListing> {
      if (!isApplicationId(applicationId)) return { targets: [], routes: [] };
      return withTenant(pool, tenantId, async (client) => {
        const targets = await client.query(
          `SELECT ${TARGET_COLUMNS} FROM public.studio_registry_targets t JOIN public.studio_registry_routes r ON r.tenant_id = t.tenant_id AND r.application_id = t.application_id AND r.route = t.route
            WHERE t.tenant_id = $1::uuid AND t.application_id = $2 ORDER BY t.created_at, t.target_id`, [tenantId, applicationId]);
        const routes = await client.query("SELECT route, page FROM public.studio_registry_routes WHERE tenant_id = $1::uuid AND application_id = $2 ORDER BY created_at, route", [tenantId, applicationId]);
        const counts = await referenceCounts(client, tenantId, applicationId);
        return Object.freeze({
          targets: Object.freeze(targets.rows.map((row): TargetView => Object.freeze({ ...toRecord(row), references: Object.freeze(counts.get(String(row.target_id)) ?? { drafts: 0, published: 0 }) }))),
          routes: Object.freeze(routes.rows.map((row): RegistryRouteRecord => Object.freeze({ route: String(row.route), page: String(row.page) }))),
        });
      });
    },

    async get(tenantId, applicationId, targetId) {
      if (!isApplicationId(applicationId) || !isTargetId(targetId)) return null;
      return withTenant(pool, tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT ${TARGET_COLUMNS} FROM public.studio_registry_targets t JOIN public.studio_registry_routes r ON r.tenant_id = t.tenant_id AND r.application_id = t.application_id AND r.route = t.route
            WHERE t.tenant_id = $1::uuid AND t.application_id = $2 AND t.target_id = $3`, [tenantId, applicationId, targetId]);
        const row = rows[0];
        if (row === undefined) return null;
        const counts = await referenceCounts(client, tenantId, applicationId);
        return Object.freeze({ ...toRecord(row), references: Object.freeze(counts.get(targetId) ?? { drafts: 0, published: 0 }) });
      });
    },

    async registry(tenantId, applicationId) {
      if (!isApplicationId(applicationId)) return { routes: [], elements: [] as never, markers: {}, checks: [] };
      return withTenant(pool, tenantId, (client) => readRegistry(client, tenantId, applicationId));
    },
    async registryIn(tx, tenantId, applicationId) {
      if (!isApplicationId(applicationId)) return { routes: [], elements: [] as never, markers: {}, checks: [] };
      return readRegistry(tx, tenantId, applicationId);
    },

    async register(scope, applicationId, value): Promise<RegisterOutcome> {
      if (!isApplicationId(applicationId) || !ACTOR(scope.actor) || !isTargetId(value.targetId)) return { kind: "id_refused" };
      try {
        return await withTenant(pool, scope.tenantId, async (client): Promise<RegisterOutcome> => {
          const application = await lockApplicationShared(client, scope.tenantId, applicationId);
          if (application === null) return { kind: "application_not_found" };
          if (!application.enabled) return { kind: "application_disabled" };
          if (application.registryId !== STUDIO_MANAGED_REGISTRY_ID) return { kind: "registry_not_managed" };
          if (!isPageFor(application.routing, value.page)) return { kind: "page_refused" }; // the page must follow THIS application's routing (the database repeats the rule)
          // Registrations of one application are serialised, so the route check-then-insert below cannot interleave with another registration.
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`studio-registry:${scope.tenantId}:${applicationId}`]);
          const existing = await client.query("SELECT 1 FROM public.studio_registry_targets WHERE tenant_id = $1::uuid AND application_id = $2 AND target_id = $3", [scope.tenantId, applicationId, value.targetId]);
          if (existing.rows.length > 0) return { kind: "target_exists" };
          const byPage = await client.query("SELECT route FROM public.studio_registry_routes WHERE tenant_id = $1::uuid AND application_id = $2 AND page = $3", [scope.tenantId, applicationId, value.page]);
          let created = false;
          if (byPage.rows[0] !== undefined) {
            if (byPage.rows[0].route !== value.route) return { kind: "route_mismatch" }; // the page already has its route: it is never renamed
          } else {
            const byRoute = await client.query("SELECT 1 FROM public.studio_registry_routes WHERE tenant_id = $1::uuid AND application_id = $2 AND route = $3", [scope.tenantId, applicationId, value.route]);
            if (byRoute.rows.length > 0) return { kind: "route_mismatch" }; // the route name already belongs to another page
            await client.query("INSERT INTO public.studio_registry_routes (tenant_id, application_id, route, page, created_by) VALUES ($1::uuid, $2, $3, $4, $5)", [scope.tenantId, applicationId, value.route, value.page, scope.actor]);
            created = true;
          }
          await client.query(
            `INSERT INTO public.studio_registry_targets (tenant_id, application_id, target_id, marker, route, role, label, description, operations, privacy, status, created_by, updated_by)
             VALUES ($1::uuid, $2, $3, $3, $4, $5, $6, $7, $8::text[], $9, 'active', $10, $10)`,
            [scope.tenantId, applicationId, value.targetId, value.route, value.role, value.label, value.description, [...value.operations], value.privacy, scope.actor]);
          return { kind: "created", route: { route: value.route, page: value.page, created } };
        });
      } catch (error) {
        const constraint = constraintOf(error);
        if (constraint === "studio_registry_targets_cap" || constraint === "studio_registry_routes_cap") return { kind: "registry_full" };
        if (constraint === "studio_registry_targets_pkey" || constraint === "studio_registry_targets_marker_in_use" || constraint === "studio_registry_targets_marker_key") return { kind: "target_exists" };
        throw error;
      }
    },

    async checks(tenantId, applicationId): Promise<readonly CheckView[]> {
      if (!isApplicationId(applicationId)) return [];
      return withTenant(pool, tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT name, kind, target_id, route, attribute, expected, status FROM public.studio_registry_checks WHERE tenant_id = $1::uuid AND application_id = $2 ORDER BY created_at, name`, [tenantId, applicationId]);
        const counts = await checkReferenceCounts(client, tenantId, applicationId);
        return Object.freeze(rows.map((row): CheckView => Object.freeze({ ...toCheck(row), references: Object.freeze(counts.get(String(row.name)) ?? { drafts: 0, published: 0 }) })));
      });
    },

    async registerCheck(scope, applicationId, value): Promise<CheckRegisterOutcome> {
      if (!isApplicationId(applicationId) || !ACTOR(scope.actor) || !isCheckName(value.name)) return { kind: "id_refused" };
      try {
        return await withTenant(pool, scope.tenantId, async (client): Promise<CheckRegisterOutcome> => {
          const application = await lockApplicationShared(client, scope.tenantId, applicationId);
          if (application === null) return { kind: "application_not_found" };
          if (!application.enabled) return { kind: "application_disabled" };
          if (application.registryId !== STUDIO_MANAGED_REGISTRY_ID) return { kind: "registry_not_managed" };
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`studio-registry:${scope.tenantId}:${applicationId}`]);
          const existing = await client.query("SELECT 1 FROM public.studio_registry_checks WHERE tenant_id = $1::uuid AND application_id = $2 AND name = $3", [scope.tenantId, applicationId, value.name]);
          if (existing.rows.length > 0) return { kind: "existing" }; // create-or-get: an existing check is left exactly as it is
          if (value.targetId !== null) {
            const target = await client.query("SELECT role, status FROM public.studio_registry_targets WHERE tenant_id = $1::uuid AND application_id = $2 AND target_id = $3 FOR SHARE", [scope.tenantId, applicationId, value.targetId]);
            const row = target.rows[0];
            if (row === undefined) return { kind: "target_not_found" };
            if (row.status !== "active") return { kind: "target_disabled" };
            if (value.kind === "element.value.equals" && !(VALUE_CHECK_ROLES as readonly string[]).includes(String(row.role))) return { kind: "role_refused" };
          }
          if (value.route !== null) {
            const route = await client.query("SELECT 1 FROM public.studio_registry_routes WHERE tenant_id = $1::uuid AND application_id = $2 AND route = $3", [scope.tenantId, applicationId, value.route]);
            if (route.rows.length === 0) return { kind: "route_not_found" };
          }
          await client.query(
            `INSERT INTO public.studio_registry_checks (tenant_id, application_id, name, kind, target_id, route, attribute, expected, status, created_by, updated_by)
             VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $9)`,
            [scope.tenantId, applicationId, value.name, value.kind, value.targetId, value.route, value.attribute, value.expected, scope.actor]);
          return { kind: "created" };
        });
      } catch (error) {
        const constraint = constraintOf(error);
        if (constraint === "studio_registry_checks_cap") return { kind: "registry_full" };
        if (constraint === "studio_registry_checks_pkey" || constraint === "studio_registry_checks_content_key") return { kind: "existing" };
        if (constraint === "studio_registry_checks_value_role") return { kind: "role_refused" };
        if (constraint === "studio_registry_checks_target_active") return { kind: "target_disabled" };
        throw error;
      }
    },

    async setCheckStatus(scope, applicationId, name, status: CheckStatus): Promise<CheckStatusOutcome> {
      if (!isApplicationId(applicationId) || !ACTOR(scope.actor) || !isCheckName(name) || (status !== "active" && status !== "disabled")) return "id_refused";
      return withTenant(pool, scope.tenantId, async (client): Promise<CheckStatusOutcome> => {
        const application = await lockApplicationShared(client, scope.tenantId, applicationId);
        if (application === null) return "application_not_found";
        if (application.registryId !== STUDIO_MANAGED_REGISTRY_ID) return "registry_not_managed";
        if (status === "active" && !application.enabled) return "application_disabled";
        const { rows } = await client.query("SELECT status FROM public.studio_registry_checks WHERE tenant_id = $1::uuid AND application_id = $2 AND name = $3 FOR UPDATE", [scope.tenantId, applicationId, name]);
        const row = rows[0];
        if (row === undefined) return "check_not_found";
        if (row.status === status) return "unchanged";
        await client.query("UPDATE public.studio_registry_checks SET status = $4, updated_by = $5, updated_at = now() WHERE tenant_id = $1::uuid AND application_id = $2 AND name = $3", [scope.tenantId, applicationId, name, status, scope.actor]);
        return "changed";
      });
    },

    async definitionsUsing(tenantId, applicationId, targetId): Promise<readonly DefinitionUsing[]> {
      if (!isApplicationId(applicationId) || !isTargetId(targetId)) return [];
      return withTenant(pool, tenantId, (client) => readDefinitionsUsing(client, tenantId, applicationId, targetId));
    },

    async changes(tenantId, applicationId, targetId, limit): Promise<readonly TargetChange[]> {
      if (!isApplicationId(applicationId) || !isTargetId(targetId)) return [];
      return withTenant(pool, tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT revision, changed_at, changed_by, before, after FROM public.studio_registry_target_changes
            WHERE tenant_id = $1::uuid AND application_id = $2 AND target_id = $3 ORDER BY revision DESC LIMIT $4`, [tenantId, applicationId, targetId, Math.max(1, Math.min(50, limit))]);
        return Object.freeze(rows.map((row): TargetChange => Object.freeze({ revision: Number(row.revision), changedAt: iso(row.changed_at), changedBy: String(row.changed_by), before: fieldsOf(row.before), after: fieldsOf(row.after) })));
      });
    },

    async setHealth(scope, applicationId, targetId, health): Promise<HealthOutcome> {
      if (!isApplicationId(applicationId) || !ACTOR(scope.actor) || !isTargetId(targetId) || (health !== "unverified" && health !== "healthy" && health !== "broken")) return "id_refused";
      return withTenant(pool, scope.tenantId, async (client): Promise<HealthOutcome> => {
        const application = await lockApplicationShared(client, scope.tenantId, applicationId);
        if (application === null) return "application_not_found";
        if (application.registryId !== STUDIO_MANAGED_REGISTRY_ID) return "registry_not_managed";
        const { rows } = await client.query("SELECT health FROM public.studio_registry_targets WHERE tenant_id = $1::uuid AND application_id = $2 AND target_id = $3 FOR UPDATE", [scope.tenantId, applicationId, targetId]);
        const row = rows[0];
        if (row === undefined) return "target_not_found";
        // `health_checked_at` records the latest observation even when the state itself did not change.
        await client.query("UPDATE public.studio_registry_targets SET health = $4, health_checked_at = now(), updated_by = $5, updated_at = now() WHERE tenant_id = $1::uuid AND application_id = $2 AND target_id = $3",
          [scope.tenantId, applicationId, targetId, health, scope.actor]);
        return row.health === health ? "unchanged" : "changed";
      });
    },

    async repair(scope, applicationId, targetId, value, verify): Promise<RepairOutcome> {
      if (!isApplicationId(applicationId) || !ACTOR(scope.actor) || !isTargetId(targetId) || !isTargetId(value.marker)) return { kind: "id_refused" };
      try {
        return await withTenant(pool, scope.tenantId, async (client): Promise<RepairOutcome> => {
          const application = await lockApplicationForRegistryChange(client, scope.tenantId, applicationId);
          if (application === null) return { kind: "application_not_found" };
          if (!application.enabled) return { kind: "application_disabled" };
          if (application.registryId !== STUDIO_MANAGED_REGISTRY_ID) return { kind: "registry_not_managed" };
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`studio-registry:${scope.tenantId}:${applicationId}`]);
          const current = await client.query(
            `SELECT ${TARGET_COLUMNS} FROM public.studio_registry_targets t JOIN public.studio_registry_routes r ON r.tenant_id = t.tenant_id AND r.application_id = t.application_id AND r.route = t.route
              WHERE t.tenant_id = $1::uuid AND t.application_id = $2 AND t.target_id = $3 FOR UPDATE OF t`, [scope.tenantId, applicationId, targetId]);
          const row = current.rows[0];
          if (row === undefined) return { kind: "target_not_found" };
          const before = toRecord(row);
          const beforeFields: RepairFields = { marker: before.marker, role: before.role, operations: [...before.operations], label: before.label, description: before.description };
          const afterFields: RepairFields = { marker: value.marker, role: value.role, operations: [...value.operations], label: value.label, description: value.description };
          if (JSON.stringify(beforeFields) === JSON.stringify(afterFields)) return { kind: "unchanged" };
          const clash = await client.query(
            "SELECT 1 FROM public.studio_registry_targets WHERE tenant_id = $1::uuid AND application_id = $2 AND target_id <> $3 AND (target_id = $4 OR marker = $4)", [scope.tenantId, applicationId, targetId, value.marker]);
          if (clash.rows.length > 0) return { kind: "marker_in_use" };
          // The repair gate (see migration 077): the transaction names this target, the revision steps by one and the change row below is written before COMMIT.
          await client.query("SELECT set_config('studio.repair_target', $1, true)", [`${scope.tenantId}/${applicationId}/${targetId}`]);
          await client.query(
            `UPDATE public.studio_registry_targets SET marker = $4, role = $5, operations = $6::text[], label = $7, description = $8, revision = revision + 1, health = 'healthy', health_checked_at = now(),
                    updated_by = $9, updated_at = now() WHERE tenant_id = $1::uuid AND application_id = $2 AND target_id = $3`,
            [scope.tenantId, applicationId, targetId, afterFields.marker, afterFields.role, afterFields.operations, afterFields.label, afterFields.description, scope.actor]);
          await client.query(
            `INSERT INTO public.studio_registry_target_changes (tenant_id, application_id, target_id, revision, changed_by, before, after, reason)
             VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'repair')`,
            [scope.tenantId, applicationId, targetId, before.revision + 1, scope.actor, JSON.stringify(beforeFields), JSON.stringify(afterFields)]);
          const definitions = await readDefinitionsUsing(client, scope.tenantId, applicationId, targetId);
          const registry = await readRegistry(client, scope.tenantId, applicationId);
          const updated = await client.query(
            `SELECT ${TARGET_COLUMNS} FROM public.studio_registry_targets t JOIN public.studio_registry_routes r ON r.tenant_id = t.tenant_id AND r.application_id = t.application_id AND r.route = t.route
              WHERE t.tenant_id = $1::uuid AND t.application_id = $2 AND t.target_id = $3`, [scope.tenantId, applicationId, targetId]);
          const record = toRecord(updated.rows[0]!);
          const problems = verify(definitions, registry, record);
          if (problems.length > 0) throw new RepairRollback(problems);
          const counts = await referenceCounts(client, scope.tenantId, applicationId);
          const target: TargetView = Object.freeze({ ...record, references: Object.freeze(counts.get(targetId) ?? { drafts: 0, published: 0 }) });
          return { kind: "repaired", target, before: beforeFields, after: afterFields, impact: impactOf(definitions) };
        });
      } catch (error) {
        if (error instanceof RepairRollback) return { kind: "incompatible", problems: error.problems };
        const constraint = constraintOf(error);
        if (constraint === "studio_registry_targets_marker_in_use" || constraint === "studio_registry_targets_marker_key") return { kind: "marker_in_use" };
        throw error;
      }
    },

    async setStatus(scope, applicationId, targetId, status): Promise<TargetStatusOutcome> {
      if (!isApplicationId(applicationId) || !ACTOR(scope.actor) || !isTargetId(targetId) || (status !== "active" && status !== "disabled")) return "id_refused";
      return withTenant(pool, scope.tenantId, async (client) => {
        const application = await lockApplicationShared(client, scope.tenantId, applicationId);
        if (application === null) return "application_not_found";
        if (application.registryId !== STUDIO_MANAGED_REGISTRY_ID) return "registry_not_managed";
        // Disabling is always allowed (a safety lever); enabling needs an enabled application.
        if (status === "active" && !application.enabled) return "application_disabled";
        const { rows } = await client.query("SELECT status FROM public.studio_registry_targets WHERE tenant_id = $1::uuid AND application_id = $2 AND target_id = $3 FOR UPDATE", [scope.tenantId, applicationId, targetId]);
        const row = rows[0];
        if (row === undefined) return "target_not_found";
        if (row.status === status) return "unchanged";
        await client.query("UPDATE public.studio_registry_targets SET status = $4, updated_by = $5, updated_at = now() WHERE tenant_id = $1::uuid AND application_id = $2 AND target_id = $3", [scope.tenantId, applicationId, targetId, status, scope.actor]);
        return "changed";
      });
    },
  };
  return Object.freeze(store);
}
