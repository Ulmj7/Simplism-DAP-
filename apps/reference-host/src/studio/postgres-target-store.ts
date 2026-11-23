/**
 * PostgreSQL implementation of the Studio-managed registry store (Studio V1B). Narrow, parameterised SQL; every statement runs inside `withTenant`, so forced row-level security confines it to
 * the caller's own tenant. Writes serialise per application with an advisory transaction lock (so the check-then-insert of a route and the caps are race-free) AFTER locking the application
 * row FOR SHARE; the database repeats every shape rule, the caps and the immutability as CHECKs and triggers (migration 074).
 */
import { withTenant } from "../authoring/tenant-tx.js";
import type { TenantClient, TenantPool } from "../authoring/tenant-tx.js";
import type { TrustedRegistryData } from "../authoring/trusted-registry.js";
import { STUDIO_MANAGED_REGISTRY_ID, isApplicationId } from "./applications.js";
import { lockApplicationShared } from "./application-lock.js";
import { isTargetId } from "./registry-targets.js";
import type { RegistryRouteRecord, TargetOperation, TargetRecord, TargetView, RegistrableRole } from "./registry-targets.js";
import type { ManagedRegistry, RegisterOutcome, TargetListing, TargetStatusOutcome, TargetStore } from "./target-store.js";

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const ACTOR = (actor: unknown): actor is string => typeof actor === "string" && actor.length >= 1 && actor.length <= 256;
const TARGET_COLUMNS = "t.target_id, t.route, r.page, t.role, t.label, t.description, t.operations, t.privacy, t.status, t.updated_at";

function toRecord(row: Record<string, unknown>): TargetRecord {
  const status = row.status;
  if (status !== "active" && status !== "disabled") throw new Error("Unexpected stored status");
  const operations = row.operations;
  if (!Array.isArray(operations) || !operations.every((item) => typeof item === "string")) throw new Error("Unexpected stored operations");
  return Object.freeze({
    id: String(row.target_id), route: String(row.route), page: String(row.page), role: String(row.role) as RegistrableRole, label: String(row.label), description: String(row.description),
    operations: Object.freeze([...(operations as TargetOperation[])]), privacy: "public" as const, status, updatedAt: iso(row.updated_at),
  });
}

/** How many of the application's stored definitions name each target id, split by status. Counts definitions, not steps. */
async function referenceCounts(client: TenantClient, tenantId: string, applicationId: string): Promise<ReadonlyMap<string, { drafts: number; published: number }>> {
  const { rows } = await client.query(
    `SELECT s.target AS target_id,
            count(DISTINCT d.walkthrough_id) FILTER (WHERE d.status = 'draft')::int AS drafts,
            count(DISTINCT d.walkthrough_id) FILTER (WHERE d.status = 'published')::int AS published
       FROM public.walkthrough_definitions d
       CROSS JOIN LATERAL (SELECT step->>'target' AS target
                             FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.definition->'steps') = 'array' THEN d.definition->'steps' ELSE '[]'::jsonb END) AS step
                            WHERE jsonb_typeof(step) = 'object') s
      WHERE d.tenant_id = $1::uuid AND d.application_id = $2 AND s.target IS NOT NULL
      GROUP BY s.target`, [tenantId, applicationId]);
  return new Map(rows.map((row) => [String(row.target_id), { drafts: Number(row.drafts), published: Number(row.published) }] as const));
}

async function readRegistry(client: TenantClient, tenantId: string, applicationId: string): Promise<ManagedRegistry> {
  const routes = await client.query("SELECT route, page FROM public.studio_registry_routes WHERE tenant_id = $1::uuid AND application_id = $2 ORDER BY created_at, route", [tenantId, applicationId]);
  const targets = await client.query(
    `SELECT t.target_id, t.route, t.role, t.label, t.description, t.operations, t.privacy FROM public.studio_registry_targets t
      WHERE t.tenant_id = $1::uuid AND t.application_id = $2 AND t.status = 'active' ORDER BY t.created_at, t.target_id`, [tenantId, applicationId]);
  return Object.freeze({
    routes: Object.freeze(routes.rows.map((row): RegistryRouteRecord => Object.freeze({ route: String(row.route), page: String(row.page) }))),
    elements: Object.freeze(targets.rows.map((row) => Object.freeze({
      id: String(row.target_id), route: String(row.route), role: String(row.role), label: String(row.label), description: String(row.description),
      operations: Object.freeze([...(row.operations as string[])]), privacy: "public",
    }))) as unknown as TrustedRegistryData["elements"],
  });
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
      if (!isApplicationId(applicationId)) return { routes: [], elements: [] as never };
      return withTenant(pool, tenantId, (client) => readRegistry(client, tenantId, applicationId));
    },
    async registryIn(tx, tenantId, applicationId) {
      if (!isApplicationId(applicationId)) return { routes: [], elements: [] as never };
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
            `INSERT INTO public.studio_registry_targets (tenant_id, application_id, target_id, route, role, label, description, operations, privacy, status, created_by, updated_by)
             VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::text[], $9, 'active', $10, $10)`,
            [scope.tenantId, applicationId, value.targetId, value.route, value.role, value.label, value.description, [...value.operations], value.privacy, scope.actor]);
          return { kind: "created", route: { route: value.route, page: value.page, created } };
        });
      } catch (error) {
        const constraint = constraintOf(error);
        if (constraint === "studio_registry_targets_cap" || constraint === "studio_registry_routes_cap") return { kind: "registry_full" };
        if (constraint === "studio_registry_targets_pkey") return { kind: "target_exists" };
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
