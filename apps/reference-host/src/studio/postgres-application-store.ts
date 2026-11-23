/**
 * PostgreSQL implementation of the Application store (Studio V1A). Narrow, parameterised SQL; every statement runs inside `withTenant` (the authoring store's tenant
 * transaction), so forced row-level security confines it to the caller's own tenant even if a query forgot its `tenant_id` predicate (each one states it anyway).
 */
import { withTenant } from "../authoring/tenant-tx.js";
import type { TenantClient, TenantPool } from "../authoring/tenant-tx.js";
import { MAX_APPLICATIONS_PER_TENANT, STUDIO_MANAGED_REGISTRY_ID, generateRuntimeKey, isApplicationId, isRuntimeKey, registrySourceOf, tenantOfRuntimeKey } from "./applications.js";
import type { ApplicationEnvironment, ApplicationRecord, ApplicationRouting } from "./applications.js";
import type { ApplicationEnabledOutcome, ApplicationSaveOutcome, ApplicationStore, RuntimeKeyOutcome } from "./application-store.js";

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const ACTOR = (actor: unknown): actor is string => typeof actor === "string" && actor.length >= 1 && actor.length <= 256;
/**
 * Every read carries the target and workflow counts as scalar sub-selects of the SAME statement (one round trip for the whole list, no N+1), each confined to the row's own tenant
 * and application. `published` counts published heads for now; versions arrive with the versioning order.
 */
const COLUMNS = `a.application_id, a.name, a.origin, a.allowed_origins, a.environment, a.registry_id, a.routing, a.runtime_access, a.runtime_key, a.enabled, a.created_at, a.updated_at,
  (SELECT count(*)::int FROM public.studio_registry_targets t WHERE t.tenant_id = a.tenant_id AND t.application_id = a.application_id) AS target_count,
  (SELECT count(*)::int FROM public.walkthrough_definitions d WHERE d.tenant_id = a.tenant_id AND d.application_id = a.application_id AND d.status = 'draft') AS draft_count,
  (SELECT count(*)::int FROM public.walkthrough_definitions d WHERE d.tenant_id = a.tenant_id AND d.application_id = a.application_id AND d.status = 'published') AS published_count`;
const constraintOf = (error: unknown): string | undefined => (typeof error === "object" && error !== null ? (error as { constraint?: string }).constraint : undefined);

function toRecord(row: Record<string, unknown>): ApplicationRecord {
  const environment = row.environment;
  if (environment !== "development" && environment !== "test") throw new Error("Unexpected stored environment");
  const allowed = row.allowed_origins;
  if (!Array.isArray(allowed) || !allowed.every((item) => typeof item === "string")) throw new Error("Unexpected stored origins");
  const routing = row.routing;
  if (routing !== "hash" && routing !== "history") throw new Error("Unexpected stored routing");
  const key = row.runtime_key === null || row.runtime_key === undefined ? null : String(row.runtime_key);
  if (key !== null && !isRuntimeKey(key)) throw new Error("Unexpected stored runtime key");
  return Object.freeze({
    id: String(row.application_id), name: String(row.name), origin: String(row.origin), allowedOrigins: Object.freeze([...(allowed as string[])]),
    environment: environment as ApplicationEnvironment, registryId: String(row.registry_id), routing: routing as ApplicationRouting, runtimeAccess: row.runtime_access === true, runtimeKey: key,
    counts: Object.freeze({ targets: Number(row.target_count ?? 0), drafts: Number(row.draft_count ?? 0), published: Number(row.published_count ?? 0) }),
    enabled: row.enabled === true, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  });
}

export function createPostgresApplicationStore(pool: TenantPool): ApplicationStore {
  const store: ApplicationStore = {
    async list(tenantId) {
      return withTenant(pool, tenantId, async (client: TenantClient) => {
        const { rows } = await client.query(
          `SELECT ${COLUMNS} FROM public.studio_applications a WHERE a.tenant_id = $1::uuid ORDER BY a.updated_at DESC, a.application_id LIMIT ${MAX_APPLICATIONS_PER_TENANT}`, [tenantId]);
        return Object.freeze(rows.map(toRecord));
      });
    },

    async get(tenantId, id) {
      if (!isApplicationId(id)) return null;
      return withTenant(pool, tenantId, async (client) => {
        const { rows } = await client.query(`SELECT ${COLUMNS} FROM public.studio_applications a WHERE a.tenant_id = $1::uuid AND a.application_id = $2`, [tenantId, id]);
        const row = rows[0];
        return row === undefined ? null : toRecord(row);
      });
    },

    async save(scope, id, config, candidateKey = generateRuntimeKey(scope.tenantId)): Promise<ApplicationSaveOutcome> {
      if (!isApplicationId(id) || !ACTOR(scope.actor)) return "id_refused";
      const routing = config.routing ?? "hash";
      const runtimeAccess = config.runtimeAccess === true;
      const key = runtimeAccess && isRuntimeKey(candidateKey) ? candidateKey : null;
      try {
        return await withTenant(pool, scope.tenantId, async (client): Promise<ApplicationSaveOutcome> => {
          // One lock per tenant serialises enrollments, so the cap cannot be exceeded by two concurrent transactions.
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`studio-application:${scope.tenantId}`]);
          const existing = await client.query("SELECT registry_id FROM public.studio_applications WHERE tenant_id = $1::uuid AND application_id = $2 FOR UPDATE", [scope.tenantId, id]);
          if (existing.rows.length === 0) {
            const count = await client.query("SELECT count(*)::int AS n FROM public.studio_applications WHERE tenant_id = $1::uuid", [scope.tenantId]);
            if (Number(count.rows[0]?.n) >= MAX_APPLICATIONS_PER_TENANT) return "limit_reached";
            await client.query(
              `INSERT INTO public.studio_applications (tenant_id, application_id, name, origin, allowed_origins, environment, registry_id, routing, runtime_access, runtime_key, enabled, created_by, updated_by)
               VALUES ($1::uuid, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10, true, $11, $11)`,
              [scope.tenantId, id, config.name, config.origin, [...config.allowedOrigins], config.environment, config.registryId, routing, runtimeAccess, key, scope.actor]);
            return "created";
          }
          if (registrySourceOf(String(existing.rows[0]?.registry_id)) !== registrySourceOf(config.registryId)) return "registry_switch";
          // The key, once issued, is kept (stable until rotated); it is generated only the first time runtime access is on. The database refuses a routing change once routes exist.
          await client.query(
            `UPDATE public.studio_applications SET name = $3, origin = $4, allowed_origins = $5::text[], environment = $6, registry_id = $7, routing = $8, runtime_access = $9,
                    runtime_key = COALESCE(runtime_key, $10::text), updated_by = $11, updated_at = now()
              WHERE tenant_id = $1::uuid AND application_id = $2`,
            [scope.tenantId, id, config.name, config.origin, [...config.allowedOrigins], config.environment, config.registryId, routing, runtimeAccess, key, scope.actor]);
          return "updated";
        });
      } catch (error) {
        if (constraintOf(error) === "studio_applications_routing_locked") return "routing_locked";
        throw error;
      }
    },

    async findByRuntimeKey(tenantId, key) {
      if (!isRuntimeKey(key)) return null;
      return withTenant(pool, tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT ${COLUMNS} FROM public.studio_applications a
            WHERE a.tenant_id = $1::uuid AND a.runtime_key = $2 AND a.runtime_access AND a.enabled AND a.registry_id = '${STUDIO_MANAGED_REGISTRY_ID}'`, [tenantId, key]);
        const row = rows[0];
        return row === undefined ? null : toRecord(row);
      });
    },

    async rotateRuntimeKey(scope, id, newKey): Promise<RuntimeKeyOutcome> {
      if (!isApplicationId(id) || !ACTOR(scope.actor) || !isRuntimeKey(newKey) || tenantOfRuntimeKey(newKey) !== scope.tenantId) return "id_refused";
      return withTenant(pool, scope.tenantId, async (client) => {
        const { rows } = await client.query("SELECT registry_id FROM public.studio_applications WHERE tenant_id = $1::uuid AND application_id = $2 FOR UPDATE", [scope.tenantId, id]);
        const row = rows[0];
        if (row === undefined) return "not_found";
        if (String(row.registry_id) !== STUDIO_MANAGED_REGISTRY_ID) return "registry_not_managed";
        await client.query("UPDATE public.studio_applications SET runtime_key = $3, updated_by = $4, updated_at = now() WHERE tenant_id = $1::uuid AND application_id = $2", [scope.tenantId, id, newKey, scope.actor]);
        return "rotated";
      });
    },

    async setEnabled(scope, id, enabled): Promise<ApplicationEnabledOutcome> {
      if (!isApplicationId(id) || !ACTOR(scope.actor) || typeof enabled !== "boolean") return "id_refused";
      return withTenant(pool, scope.tenantId, async (client) => {
        const { rows } = await client.query("SELECT enabled FROM public.studio_applications WHERE tenant_id = $1::uuid AND application_id = $2 FOR UPDATE", [scope.tenantId, id]);
        const row = rows[0];
        if (row === undefined) return "not_found";
        if (row.enabled === enabled) return "unchanged";
        await client.query("UPDATE public.studio_applications SET enabled = $3, updated_by = $4, updated_at = now() WHERE tenant_id = $1::uuid AND application_id = $2", [scope.tenantId, id, enabled, scope.actor]);
        return "changed";
      });
    },
  };
  return Object.freeze(store);
}
