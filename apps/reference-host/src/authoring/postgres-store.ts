/**
 * PostgreSQL implementation of the walkthrough store (Feature 004, T404). Narrow, parameterised SQL; every statement runs inside `withTenant`, so forced row-level
 * security confines it to the caller's own tenant even if a query forgot its `tenant_id` predicate (each one states it anyway).
 */
import { withTenant } from "./tenant-tx.js";
import type { TenantPool } from "./tenant-tx.js";
import { isAuthoredId } from "./ids.js";
import { isApplicationId } from "../studio/applications.js";
import { MAX_DEFINITION_BYTES, MAX_LISTED, MAX_PUBLISHED_PER_TENANT } from "./store.js";
import type { SaveOutcome, StatusOutcome, StoredSummary, StoredWalkthrough, WalkthroughStore } from "./store.js";
import type { WalkthroughStatus } from "./schema.js";

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const statusOf = (value: unknown): WalkthroughStatus => { if (value === "draft" || value === "published") return value; throw new Error("Unexpected stored status"); };
const appOf = (value: unknown): string | null => (typeof value === "string" ? value : null);
const ACTOR = (actor: unknown): actor is string => typeof actor === "string" && actor.length >= 1 && actor.length <= 256;

export function createPostgresWalkthroughStore(pool: TenantPool): WalkthroughStore {
  const store: WalkthroughStore = {
    async recordEvent(tenantId, { walkthroughId, runId, event }) {
      return withTenant(pool, tenantId, async client => {
        if (isAuthoredId(walkthroughId)) {
          // Hold a share lock through INSERT so an Unpublish cannot race the eligibility check.
          const { rows } = await client.query(
            "SELECT 1 FROM public.walkthrough_definitions WHERE tenant_id = $1::uuid AND walkthrough_id = $2 AND status = 'published' FOR SHARE",
            [tenantId, walkthroughId]);
          if (rows.length === 0) return false;
        }
        if (event !== "started") {
          // A missing or mismatched start does not consume the run's single terminal slot.
          const { rows } = await client.query(
            "SELECT 1 FROM public.walkthrough_events WHERE tenant_id = $1::uuid AND walkthrough_id = $2 AND run_id = $3::uuid AND event_type = 'started'",
            [tenantId, walkthroughId, runId]);
          if (rows.length === 0) return true;
        }
        await client.query(
          `INSERT INTO public.walkthrough_events (tenant_id, walkthrough_id, run_id, event_type)
           VALUES ($1::uuid, $2, $3::uuid, $4) ON CONFLICT DO NOTHING`, [tenantId, walkthroughId, runId, event]);
        return true;
      });
    },

    async summary(tenantId) {
      return withTenant(pool, tenantId, async client => {
        const { rows } = await client.query(
          `SELECT s.walkthrough_id, d.definition->>'title' AS title, count(*) AS started,
                  count(*) FILTER (WHERE c.event_type = 'completed') AS completed,
                  count(*) FILTER (WHERE c.event_type = 'cancelled') AS cancelled
             FROM public.walkthrough_events s
             LEFT JOIN public.walkthrough_events c ON c.tenant_id = s.tenant_id AND c.run_id = s.run_id
               AND c.walkthrough_id = s.walkthrough_id AND c.event_type <> 'started'
             LEFT JOIN public.walkthrough_definitions d ON d.tenant_id = s.tenant_id AND d.walkthrough_id = s.walkthrough_id
            WHERE s.tenant_id = $1::uuid AND s.event_type = 'started'
            GROUP BY s.walkthrough_id, d.definition->>'title'`, [tenantId]);
        return rows.map(row => ({ id: String(row.walkthrough_id), title: typeof row.title === "string" ? row.title : null,
          started: Number(row.started), completed: Number(row.completed), cancelled: Number(row.cancelled) }));
      });
    },

    async list(tenantId: string): Promise<readonly StoredSummary[]> {
      return withTenant(pool, tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT walkthrough_id, status, application_id, definition->>'title' AS title, definition->>'description' AS description,
                  (SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(definition->'steps') = 'array' THEN definition->'steps' ELSE '[]'::jsonb END) AS step WHERE step->>'kind' = 'guide') AS step_count, updated_at
             FROM public.walkthrough_definitions WHERE tenant_id = $1::uuid ORDER BY updated_at DESC, walkthrough_id LIMIT ${MAX_LISTED}`, [tenantId]);
        return Object.freeze(rows.map((row) => Object.freeze({
          id: String(row.walkthrough_id), status: statusOf(row.status), title: String(row.title ?? ""), description: String(row.description ?? ""),
          stepCount: Number(row.step_count), updatedAt: iso(row.updated_at), applicationId: appOf(row.application_id),
        })));
      });
    },

    async get(tenantId: string, id: string): Promise<StoredWalkthrough | null> {
      if (!isAuthoredId(id)) return null; // a built-in, preview or malformed id has no row, and the database would refuse the pattern anyway
      return withTenant(pool, tenantId, async (client) => {
        const { rows } = await client.query("SELECT walkthrough_id, status, application_id, definition, updated_at FROM public.walkthrough_definitions WHERE tenant_id = $1::uuid AND walkthrough_id = $2", [tenantId, id]);
        const row = rows[0];
        return row === undefined ? null : Object.freeze({ id: String(row.walkthrough_id), status: statusOf(row.status), applicationId: appOf(row.application_id), definition: row.definition, updatedAt: iso(row.updated_at) });
      });
    },

    async saveDraft(scope, id, definition, applicationId): Promise<SaveOutcome> {
      if (!isAuthoredId(id) || !isApplicationId(applicationId) || !ACTOR(scope.actor) || definition.id !== id) return "id_refused";
      const json = JSON.stringify(definition);
      if (Buffer.byteLength(json) > MAX_DEFINITION_BYTES) return "too_large";
      return withTenant(pool, scope.tenantId, async (client) => {
        // Insert, or update ONLY a draft whose application is unset (a legacy row: assigned now) or the same one: the WHERE on the conflict branch is what makes a published
        // guide impossible to overwrite and an application impossible to change. No row back = it exists and is either published or bound to another application.
        const { rows } = await client.query(
          `INSERT INTO public.walkthrough_definitions (tenant_id, walkthrough_id, status, definition, created_by, updated_by, application_id)
           VALUES ($1::uuid, $2, 'draft', $3::jsonb, $4, $4, $5)
           ON CONFLICT (tenant_id, walkthrough_id) DO UPDATE SET definition = EXCLUDED.definition, updated_by = EXCLUDED.updated_by, updated_at = now(),
             application_id = COALESCE(public.walkthrough_definitions.application_id, EXCLUDED.application_id)
             WHERE public.walkthrough_definitions.status = 'draft'
               AND (public.walkthrough_definitions.application_id IS NULL OR public.walkthrough_definitions.application_id = EXCLUDED.application_id)
           RETURNING (xmax = 0) AS inserted`, [scope.tenantId, id, json, scope.actor, applicationId]);
        const row = rows[0];
        if (row !== undefined) return row.inserted === true ? "created" : "updated";
        const current = await client.query("SELECT status, application_id FROM public.walkthrough_definitions WHERE tenant_id = $1::uuid AND walkthrough_id = $2", [scope.tenantId, id]);
        const existing = current.rows[0];
        return existing !== undefined && existing.status === "draft" && existing.application_id !== applicationId ? "application_mismatch" : "not_a_draft";
      });
    },

    async setStatus(scope, id, status, isValid): Promise<StatusOutcome> {
      if (!isAuthoredId(id) || !ACTOR(scope.actor) || (status !== "draft" && status !== "published")) return "id_refused";
      return withTenant(pool, scope.tenantId, async (client) => {
        // One lock per tenant serialises publishes, so the cap cannot be exceeded by two concurrent transactions.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`walkthrough-publish:${scope.tenantId}`]);
        const { rows } = await client.query("SELECT status, definition, application_id FROM public.walkthrough_definitions WHERE tenant_id = $1::uuid AND walkthrough_id = $2 FOR UPDATE", [scope.tenantId, id]);
        const row = rows[0];
        if (row === undefined) return "not_found";
        if (row.status === status) return "unchanged";
        if (status === "published") {
          let valid = false;
          try { valid = isValid(row.definition, appOf(row.application_id)) === true; } catch { valid = false; }
          if (!valid) return "invalid_definition";
          const count = await client.query("SELECT count(*)::int AS n FROM public.walkthrough_definitions WHERE tenant_id = $1::uuid AND status = 'published'", [scope.tenantId]);
          if (Number(count.rows[0]?.n) >= MAX_PUBLISHED_PER_TENANT) return "limit_reached";
        }
        await client.query("UPDATE public.walkthrough_definitions SET status = $3, updated_by = $4, updated_at = now() WHERE tenant_id = $1::uuid AND walkthrough_id = $2", [scope.tenantId, id, status, scope.actor]);
        return "changed";
      });
    },

    async listPublished(tenantId: string): Promise<readonly StoredWalkthrough[]> {
      return withTenant(pool, tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT walkthrough_id, status, application_id, definition, updated_at FROM public.walkthrough_definitions
            WHERE tenant_id = $1::uuid AND status = 'published' ORDER BY created_at, walkthrough_id LIMIT ${MAX_PUBLISHED_PER_TENANT}`, [tenantId]);
        return Object.freeze(rows.map((row) => Object.freeze({ id: String(row.walkthrough_id), status: statusOf(row.status), applicationId: appOf(row.application_id), definition: row.definition, updatedAt: iso(row.updated_at) })));
      });
    },
  };
  return Object.freeze(store);
}
