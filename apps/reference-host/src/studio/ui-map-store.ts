import { withTenant } from "../authoring/tenant-tx.js";
import type { TenantPool } from "../authoring/tenant-tx.js";
import type { Installation, WidgetInstallation } from "../platform/store.js";
import type { DiscoveredUiMap, UiMapCheckpoint } from "./discover-ui-map.js";

type Scope = Pick<WidgetInstallation, "tenantId" | "applicationId">;
type Saved = { revision: number; map: DiscoveredUiMap; previousMap: DiscoveredUiMap | null; updatedAt: Date };

export function mergeUiMaps(saved: DiscoveredUiMap, scanned: DiscoveredUiMap): DiscoveredUiMap {
  const pages = new Set(scanned.states.map(state => state.page));
  const preserved = saved.states.filter(state => !pages.has(state.page));
  const preservedIds = new Set(preserved.map(state => state.id));
  const states = [...preserved, ...scanned.states];
  const ids = new Set(states.map(state => state.id));
  const oldPages = new Map(saved.states.map(state => [state.id, state.page]));
  const refreshedEntry = scanned.states.find(state => state.id === scanned.start);
  const earlier = saved.transitions.filter(edge => preservedIds.has(edge.from)).map(edge => {
    if (!edge.to || ids.has(edge.to)) return edge;
    // A previously observed direct link still has an evidenced destination when
    // the focused scan opened that exact URL in the same audience.
    if (edge.status === "observed" && edge.action.kind === "link" && refreshedEntry &&
        edge.action.href === refreshedEntry.page && oldPages.get(edge.to) === refreshedEntry.page) {
      return { ...edge, to: refreshedEntry.id };
    }
    const { from, action } = edge;
    return { from, action, status: "unreadable" as const };
  });
  return {
    start: ids.has(saved.start) ? saved.start : scanned.start,
    states, transitions: [...earlier, ...scanned.transitions], limited: saved.limited || scanned.limited,
  };
}

export function createUiMapStore(pool: TenantPool) {
  const get = (installation: Scope, origin: string, audience = "public", includePrevious = false) =>
    withTenant(pool, installation.tenantId, async tx => {
      const result = await tx.query(`
        SELECT revision, map, ${includePrevious ? "previous_map" : "NULL"} AS "previousMap", updated_at AS "updatedAt"
        FROM public.studio_ui_maps
        WHERE tenant_id = $1 AND application_id = $2 AND origin = $3 AND audience = $4`,
      [installation.tenantId, installation.applicationId, origin, audience]);
      return result.rows[0] as Saved | undefined;
    });
  return {
    get,
    checkpoint(installation: Scope, origin: string, audience: string) {
      const { tenantId, applicationId } = installation;
      return withTenant(pool, tenantId, async tx => {
        const result = await tx.query(`
          SELECT checkpoint FROM public.studio_ui_map_work
          WHERE tenant_id = $1 AND application_id = $2 AND origin = $3 AND audience = $4`,
        [tenantId, applicationId, origin, audience]);
        return result.rows[0]?.checkpoint as UiMapCheckpoint | undefined;
      });
    },
    audiences(installation: Scope, origin: string) {
      return withTenant(pool, installation.tenantId, async tx => {
        const result = await tx.query(`
          SELECT audience FROM public.studio_ui_maps WHERE tenant_id = $1 AND application_id = $2 AND origin = $3
          UNION SELECT audience FROM public.studio_ui_map_work WHERE tenant_id = $1 AND application_id = $2 AND origin = $3
          ORDER BY audience`, [installation.tenantId, installation.applicationId, origin]);
        return result.rows.map(row => String(row.audience));
      });
    },
    save(installation: Installation, origin: string, audience: string, expected: number, result: { map: DiscoveredUiMap; checkpoint?: UiMapCheckpoint; focus: boolean }) {
      const { tenantId, applicationId, sessionEpoch } = installation;
      return withTenant(pool, tenantId, async tx => {
        const key = [tenantId, applicationId, origin, audience];
        const active = await tx.query(`
          SELECT 1 FROM public.platform_installations
          WHERE tenant_id = $1 AND application_id = $2 AND $3 = ANY (allowed_origins)
            AND enabled AND session_epoch = $4
          FOR UPDATE`, [tenantId, applicationId, origin, sessionEpoch]);
        if (!active.rowCount) return false;
        const prior = await tx.query(`SELECT revision, map FROM public.studio_ui_maps
          WHERE tenant_id = $1 AND application_id = $2 AND origin = $3 AND audience = $4`, key);
        const existing = prior.rows[0] as { revision: number; map: DiscoveredUiMap } | undefined;
        if ((existing?.revision ?? 0) !== expected) return false;
        if (result.checkpoint) {
          await tx.query(`
            INSERT INTO public.studio_ui_map_work (tenant_id, application_id, origin, audience, checkpoint)
            VALUES ($1, $2, $3, $4, $5::jsonb)
            ON CONFLICT (tenant_id, application_id, origin, audience) DO UPDATE SET checkpoint = EXCLUDED.checkpoint`,
          [...key, JSON.stringify(result.checkpoint)]);
          return true;
        }
        const map = result.focus && existing ? mergeUiMaps(existing.map, result.map) : result.map;
        await tx.query(`
          INSERT INTO public.studio_ui_maps (tenant_id, application_id, origin, audience, map)
          VALUES ($1, $2, $3, $4, $5::jsonb)
          ON CONFLICT (tenant_id, application_id, origin, audience) DO UPDATE
          SET previous_map = studio_ui_maps.map, map = EXCLUDED.map, revision = studio_ui_maps.revision + 1, updated_at = now()`,
        [...key, JSON.stringify(map)]);
        await tx.query("DELETE FROM public.studio_ui_map_work WHERE tenant_id = $1 AND application_id = $2 AND origin = $3 AND audience = $4", key);
        return true;
      });
    },
  };
}
