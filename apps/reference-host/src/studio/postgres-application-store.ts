/**
 * PostgreSQL implementation of the Application store (Studio V1A). Narrow, parameterised SQL; every statement runs inside `withTenant` (the authoring store's tenant
 * transaction), so forced row-level security confines it to the caller's own tenant even if a query forgot its `tenant_id` predicate (each one states it anyway).
 */
import { withTenant } from "../authoring/tenant-tx.js";
import type { TenantClient, TenantPool } from "../authoring/tenant-tx.js";
import { MAX_APPLICATIONS_PER_TENANT, isApplicationId } from "./applications.js";
import type { ApplicationEnvironment, ApplicationRecord } from "./applications.js";
import type { ApplicationEnabledOutcome, ApplicationSaveOutcome, ApplicationStore } from "./application-store.js";

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const ACTOR = (actor: unknown): actor is string => typeof actor === "string" && actor.length >= 1 && actor.length <= 256;
const COLUMNS = "application_id, name, origin, allowed_origins, environment, registry_id, enabled, created_at, updated_at";

function toRecord(row: Record<string, unknown>): ApplicationRecord {
  const environment = row.environment;
  if (environment !== "development" && environment !== "test") throw new Error("Unexpected stored environment");
  const allowed = row.allowed_origins;
  if (!Array.isArray(allowed) || !allowed.every((item) => typeof item === "string")) throw new Error("Unexpected stored origins");
  return Object.freeze({
    id: String(row.application_id), name: String(row.name), origin: String(row.origin), allowedOrigins: Object.freeze([...(allowed as string[])]),
    environment: environment as ApplicationEnvironment, registryId: String(row.registry_id), enabled: row.enabled === true,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  });
}

export function createPostgresApplicationStore(pool: TenantPool): ApplicationStore {
  const store: ApplicationStore = {
    async list(tenantId) {
      return withTenant(pool, tenantId, async (client: TenantClient) => {
        const { rows } = await client.query(
          `SELECT ${COLUMNS} FROM public.studio_applications WHERE tenant_id = $1::uuid ORDER BY updated_at DESC, application_id LIMIT ${MAX_APPLICATIONS_PER_TENANT}`, [tenantId]);
        return Object.freeze(rows.map(toRecord));
      });
    },

    async get(tenantId, id) {
      if (!isApplicationId(id)) return null;
      return withTenant(pool, tenantId, async (client) => {
        const { rows } = await client.query(`SELECT ${COLUMNS} FROM public.studio_applications WHERE tenant_id = $1::uuid AND application_id = $2`, [tenantId, id]);
        const row = rows[0];
        return row === undefined ? null : toRecord(row);
      });
    },

    async save(scope, id, config): Promise<ApplicationSaveOutcome> {
      if (!isApplicationId(id) || !ACTOR(scope.actor)) return "id_refused";
      return withTenant(pool, scope.tenantId, async (client) => {
        // One lock per tenant serialises enrollments, so the cap cannot be exceeded by two concurrent transactions.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`studio-application:${scope.tenantId}`]);
        const existing = await client.query("SELECT 1 FROM public.studio_applications WHERE tenant_id = $1::uuid AND application_id = $2 FOR UPDATE", [scope.tenantId, id]);
        if (existing.rows.length === 0) {
          const count = await client.query("SELECT count(*)::int AS n FROM public.studio_applications WHERE tenant_id = $1::uuid", [scope.tenantId]);
          if (Number(count.rows[0]?.n) >= MAX_APPLICATIONS_PER_TENANT) return "limit_reached";
          await client.query(
            `INSERT INTO public.studio_applications (tenant_id, application_id, name, origin, allowed_origins, environment, registry_id, enabled, created_by, updated_by)
             VALUES ($1::uuid, $2, $3, $4, $5::text[], $6, $7, true, $8, $8)`,
            [scope.tenantId, id, config.name, config.origin, [...config.allowedOrigins], config.environment, config.registryId, scope.actor]);
          return "created";
        }
        await client.query(
          `UPDATE public.studio_applications SET name = $3, origin = $4, allowed_origins = $5::text[], environment = $6, registry_id = $7, updated_by = $8, updated_at = now()
            WHERE tenant_id = $1::uuid AND application_id = $2`,
          [scope.tenantId, id, config.name, config.origin, [...config.allowedOrigins], config.environment, config.registryId, scope.actor]);
        return "updated";
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
