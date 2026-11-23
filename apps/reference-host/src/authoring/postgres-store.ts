/**
 * PostgreSQL implementation of the walkthrough store (Feature 004, T404). Narrow, parameterised SQL; every statement runs inside `withTenant`, so forced row-level
 * security confines it to the caller's own tenant even if a query forgot its `tenant_id` predicate (each one states it anyway).
 */
import { withTenant } from "./tenant-tx.js";
import type { TenantClient, TenantPool } from "./tenant-tx.js";
import { isAuthoredId } from "./ids.js";
import { isApplicationId } from "../studio/applications.js";
import { lockApplicationForRegistryChange, lockApplicationShared } from "../studio/application-lock.js";
import type { LockedApplication } from "../studio/application-lock.js";
import { MAX_DEFINITION_BYTES, MAX_LISTED, MAX_PUBLISHED_PER_TENANT } from "./store.js";
import type { OnWrite, RevisionConflict, SaveOutcome, StatusOutcome, StoredSummary, StoredWalkthrough, VersionSummary, WalkthroughStore } from "./store.js";
import type { WalkthroughStatus } from "./schema.js";

const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const statusOf = (value: unknown): WalkthroughStatus => { if (value === "draft" || value === "published") return value; throw new Error("Unexpected stored status"); };
const appOf = (value: unknown): string | null => (typeof value === "string" ? value : null);
const ACTOR = (actor: unknown): actor is string => typeof actor === "string" && actor.length >= 1 && actor.length <= 256;

const revisionOf = (row: Record<string, unknown>) => ({
  revision: Number(row.revision), liveVersion: row.live_version === null ? null : Number(row.live_version), latestVersion: Number(row.latest_version),
});
const latest = `COALESCE((SELECT max(v.version) FROM public.walkthrough_versions v
  WHERE v.tenant_id = d.tenant_id AND v.walkthrough_id = d.walkthrough_id), 0) AS latest_version`;
const steps = (definition: string) => `(SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${definition}->'steps') = 'array'
  THEN ${definition}->'steps' ELSE '[]'::jsonb END) step WHERE step->>'kind' = 'guide')`;

const stored = (row: Record<string, unknown>): StoredWalkthrough => ({
  id: String(row.walkthrough_id), status: statusOf(row.status), applicationId: appOf(row.application_id),
  definition: row.definition, updatedAt: iso(row.updated_at), ...revisionOf(row),
});
const versionOf = (row: Record<string, unknown>): VersionSummary => ({
  version: Number(row.version), publishedAt: iso(row.published_at), publishedBy: String(row.published_by),
  stepCount: Number(row.total_steps), live: row.live === true,
});
const readHead = async (client: TenantClient, tenant: string, id: string, lock = false) => {
  const { rows } = await client.query(
    `SELECT d.*, ${latest} FROM public.walkthrough_definitions d WHERE d.tenant_id = $1::uuid AND d.walkthrough_id = $2 ${lock ? "FOR UPDATE OF d" : ""}`, [tenant, id]);
  return rows[0];
};
const versionQuery = `SELECT v.*, (d.live_version = v.version) AS live,
  CASE WHEN jsonb_typeof(v.definition->'steps') = 'array' THEN jsonb_array_length(v.definition->'steps') ELSE 0 END AS total_steps FROM public.walkthrough_versions v
  JOIN public.walkthrough_definitions d USING (tenant_id, walkthrough_id) WHERE v.tenant_id = $1::uuid AND v.walkthrough_id = $2`;
type Commit<T> = { outcome: T; row?: StoredWalkthrough };
const deliver = <T>(result: Commit<T>, committed: OnWrite | undefined): T => {
  if (result.row !== undefined) committed?.(result.row);
  return result.outcome;
};
const settle = async <T>(client: TenantClient, tenant: string, id: string, outcome: T): Promise<Commit<T>> => ({
  outcome, row: stored((await readHead(client, tenant, id))!),
});

export function createPostgresWalkthroughStore(pool: TenantPool): WalkthroughStore {
  const store: WalkthroughStore = {
    async recordEvent(tenantId, { walkthroughId, runId, event }) {
      return withTenant(pool, tenantId, async client => {
        if (isAuthoredId(walkthroughId)) {
          // Hold a share lock through INSERT so an Unpublish cannot race the eligibility check.
          const { rows } = await client.query(
            "SELECT 1 FROM public.walkthrough_definitions WHERE tenant_id = $1::uuid AND walkthrough_id = $2 AND live_version IS NOT NULL FOR SHARE",
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
          `SELECT s.walkthrough_id, COALESCE(v.definition,d.definition)->>'title' AS title, count(*) AS started,
                  count(*) FILTER (WHERE c.event_type = 'completed') AS completed,
                  count(*) FILTER (WHERE c.event_type = 'cancelled') AS cancelled
             FROM public.walkthrough_events s
             LEFT JOIN public.walkthrough_events c ON c.tenant_id = s.tenant_id AND c.run_id = s.run_id
               AND c.walkthrough_id = s.walkthrough_id AND c.event_type <> 'started'
             LEFT JOIN public.walkthrough_definitions d ON d.tenant_id = s.tenant_id AND d.walkthrough_id = s.walkthrough_id
            LEFT JOIN public.walkthrough_versions v ON v.tenant_id = d.tenant_id AND v.walkthrough_id = d.walkthrough_id AND v.version = d.live_version
            WHERE s.tenant_id = $1::uuid AND s.event_type = 'started'
            GROUP BY s.walkthrough_id, COALESCE(v.definition,d.definition)->>'title'`, [tenantId]);
        return rows.map(row => ({ id: String(row.walkthrough_id), title: typeof row.title === "string" ? row.title : null,
          started: Number(row.started), completed: Number(row.completed), cancelled: Number(row.cancelled) }));
      });
    },

    async list(tenantId: string): Promise<readonly StoredSummary[]> {
      return withTenant(pool, tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT d.walkthrough_id, d.status, d.application_id, d.definition->>'title' AS title, d.definition->>'description' AS description,
                  ${steps("d.definition")} AS step_count, d.updated_at, d.revision, d.live_version, ${latest}
             FROM public.walkthrough_definitions d WHERE tenant_id = $1::uuid ORDER BY updated_at DESC, walkthrough_id LIMIT ${MAX_LISTED}`, [tenantId]);
        return Object.freeze(rows.map((row) => Object.freeze({
          id: String(row.walkthrough_id), status: statusOf(row.status), title: String(row.title ?? ""), description: String(row.description ?? ""),
          stepCount: Number(row.step_count), updatedAt: iso(row.updated_at), applicationId: appOf(row.application_id), ...revisionOf(row),
        })));
      });
    },

    async get(tenantId, id) {
      if (!isAuthoredId(id)) return null;
      return withTenant(pool, tenantId, async (client) => {
        const row = await readHead(client, tenantId, id);
        return row === undefined ? null : stored(row);
      });
    },

    async saveDraft(scope, id, definition, applicationId, guard, expectedRevision = 0, committed) {
      if (!isAuthoredId(id) || !isApplicationId(applicationId) || !ACTOR(scope.actor) || definition.id !== id) return "id_refused";
      const json = JSON.stringify(definition);
      if (Buffer.byteLength(json) > MAX_DEFINITION_BYTES) return "too_large";
      const tenant = scope.tenantId;
      const result = await withTenant(pool, tenant, async (client): Promise<Commit<SaveOutcome | RevisionConflict>> => {
        // Both save and publish acquire an existing head before the shared application lock.
        const row = await readHead(client, tenant, id, true);
        if (row !== undefined) {
          if (row.status !== "draft") return { outcome: "not_a_draft" };
          if (row.application_id !== null && row.application_id !== applicationId) return { outcome: "application_mismatch" };
          if (Number(row.revision) !== expectedRevision) return { outcome: { currentRevision: Number(row.revision) } };
        } else if (expectedRevision !== 0) return { outcome: "id_refused" };
        const locked = await lockApplicationShared(client, tenant, applicationId);
        if (locked === null) return { outcome: "application_not_found" };
        if (!locked.enabled) return { outcome: "application_disabled" };
        if (guard !== undefined && (await guard(client, locked)) !== "ok") return { outcome: "invalid_definition" };
        if (row === undefined) {
          const inserted = await client.query(
            `INSERT INTO public.walkthrough_definitions (tenant_id, walkthrough_id, status, definition, created_by, updated_by, application_id)
             VALUES ($1::uuid, $2, 'draft', $3::jsonb, $4, $4, $5)
             ON CONFLICT DO NOTHING RETURNING revision`, [tenant, id, json, scope.actor, applicationId]);
          if (inserted.rows.length === 0) {
            const current = await readHead(client, tenant, id);
            return { outcome: { currentRevision: Number(current!.revision) } };
          }
          return settle(client, tenant, id, "created");
        }
        await client.query(
          `UPDATE public.walkthrough_definitions SET definition = $3::jsonb, updated_by = $4, updated_at = now(),
            application_id = COALESCE(application_id, $5), revision = revision + 1 WHERE tenant_id = $1::uuid AND walkthrough_id = $2`,
          [tenant, id, json, scope.actor, applicationId]);
        return settle(client, tenant, id, "updated");
      });
      return deliver(result, committed);
    },

    async setStatus(scope, id, status, isValid, expectedRevision, committed) {
      if (!isAuthoredId(id) || !ACTOR(scope.actor) || (status !== "draft" && status !== "published")) return "id_refused";
      const tenant = scope.tenantId;
      const result = await withTenant(pool, tenant, async (client): Promise<Commit<StatusOutcome | RevisionConflict>> => {
        // The tenant lock serializes changes to the live set for the publication cap.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`walkthrough-publish:${tenant}`]);
        const row = await readHead(client, tenant, id, true);
        if (row === undefined) return { outcome: "not_found" };
        if (expectedRevision !== undefined && Number(row.revision) !== expectedRevision) return { outcome: { currentRevision: Number(row.revision) } };
        if (row.status === status && (status === "published" ? row.live_version !== null : row.live_version === null)) return { outcome: "unchanged", row: stored(row) };
        let version: number | null = null;
        if (status === "published") {
          const boundTo = appOf(row.application_id);
          let locked: LockedApplication | null = null;
          if (boundTo !== null) {
            locked = await lockApplicationForRegistryChange(client, tenant, boundTo);
            if (locked === null) return { outcome: "application_not_found" };
            if (!locked.enabled) return { outcome: "application_disabled" };
          }
          let valid = false;
          try { valid = (await isValid(row.definition, boundTo, client, locked)) === true; } catch { valid = false; }
          if (!valid) return { outcome: "invalid_definition" };
          if (row.live_version === null) {
            const count = await client.query("SELECT count(*)::int AS n FROM public.walkthrough_definitions WHERE tenant_id = $1::uuid AND live_version IS NOT NULL", [tenant]);
            if (Number(count.rows[0]?.n) >= MAX_PUBLISHED_PER_TENANT) return { outcome: "limit_reached" };
          }
          // Re-read max after acquiring the head lock. The lock query's original snapshot may predate a waiting publisher.
          const latestRow = await readHead(client, tenant, id);
          version = Number(latestRow!.latest_version) + 1;
          await client.query(
            `INSERT INTO public.walkthrough_versions (tenant_id, walkthrough_id, version, application_id, definition, step_count, published_by)
             SELECT d.tenant_id, d.walkthrough_id, $3, d.application_id, d.definition, ${steps("d.definition")}, $4
             FROM public.walkthrough_definitions d WHERE d.tenant_id = $1::uuid AND d.walkthrough_id = $2`, [tenant, id, version, scope.actor]);
        }
        await client.query(
          `UPDATE public.walkthrough_definitions SET status = $3, updated_by = $4, updated_at = now(),
            live_version = $5, revision = revision + 1 WHERE tenant_id = $1::uuid AND walkthrough_id = $2`, [tenant, id, status, scope.actor, version]);
        return settle(client, tenant, id, "changed");
      });
      return deliver(result, committed);
    },

    async editFromVersion(scope, id, version, committed) {
      if (!isAuthoredId(id) || !ACTOR(scope.actor)) return "id_refused";
      const tenant = scope.tenantId;
      const result = await withTenant(pool, tenant, async (client): Promise<Commit<"changed" | "not_found" | "not_published">> => {
        const head = await readHead(client, tenant, id, true);
        if (head === undefined) return { outcome: "not_found" };
        if (version === null && (head.status !== "published" || head.live_version === null)) return { outcome: "not_published" };
        // Repair holds the exclusive application lock while validating every working draft.
        const applicationId = appOf(head.application_id);
        if (applicationId !== null) await lockApplicationShared(client, tenant, applicationId);
        const { rows } = await client.query(
          `UPDATE public.walkthrough_definitions d SET status = 'draft', definition = v.definition,
            revision = d.revision + 1, updated_by = $4, updated_at = now()
            FROM public.walkthrough_versions v WHERE v.tenant_id = d.tenant_id AND v.walkthrough_id = d.walkthrough_id
              AND v.version = $3 AND d.tenant_id = $1::uuid AND d.walkthrough_id = $2 RETURNING d.revision`,
          [tenant, id, version ?? head.live_version, scope.actor]);
        return rows.length === 0 ? { outcome: "not_found" } : settle(client, tenant, id, "changed");
      });
      return deliver(result, committed);
    },

    async listVersions(tenantId, id) {
      if (!isAuthoredId(id)) return null;
      return withTenant(pool, tenantId, async (client) => {
        if (await readHead(client, tenantId, id) === undefined) return null;
        const { rows } = await client.query(`${versionQuery} ORDER BY v.version DESC`, [tenantId, id]);
        return rows.map(versionOf);
      });
    },

    async getVersion(tenantId, id, version) {
      if (!isAuthoredId(id)) return null;
      return withTenant(pool, tenantId, async (client) => {
        const { rows } = await client.query(`${versionQuery} AND v.version = $3`, [tenantId, id, version]);
        const row = rows[0];
        return row === undefined ? null : { ...versionOf(row), definition: row.definition };
      });
    },

    async listPublished(tenantId) {
      return withTenant(pool, tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT d.walkthrough_id, 'published' AS status, v.application_id, v.definition, v.published_at AS updated_at,
                  d.revision, d.live_version, ${latest}
             FROM public.walkthrough_definitions d JOIN public.walkthrough_versions v
               ON v.tenant_id = d.tenant_id AND v.walkthrough_id = d.walkthrough_id AND v.version = d.live_version
            WHERE d.tenant_id = $1::uuid ORDER BY d.created_at, d.walkthrough_id LIMIT ${MAX_PUBLISHED_PER_TENANT}`, [tenantId]);
        return rows.map(stored);
      });
    },

  };
  return Object.freeze(store);
}
