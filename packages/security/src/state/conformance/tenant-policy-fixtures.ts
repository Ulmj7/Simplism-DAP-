import type { Pool, PoolClient } from "pg";
import type { ActionId, TenantId } from "@dap/contracts";
import { withTenant } from "../postgres/tenant-tx.js";

/** A security probe must never commit, even if a broken policy unexpectedly permits it. */
export async function rollbackTenantPolicyProbe<T>(pool: Pool, tenantId: TenantId, probe: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    return await probe(client);
  } finally {
    let discard = false;
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    client.release(discard);
    if (discard) throw new Error("Tenant policy probe rollback failed");
  }
}

/** Delete only explicitly tracked keys written by this run, never rows selected by a prefix. */
export async function cleanupTenantPolicyFixtures(
  owner: Pool,
  keys: readonly { readonly tenantId: TenantId; readonly actionId: ActionId }[],
  updatedBy: string,
): Promise<void> {
  const grouped = new Map<TenantId, Set<ActionId>>();
  for (const { tenantId, actionId } of keys) {
    let actions = grouped.get(tenantId);
    if (!actions) { actions = new Set(); grouped.set(tenantId, actions); }
    actions.add(actionId);
  }
  for (const [tenantId, actions] of grouped) {
    await withTenant(owner, tenantId, (client) => client.query(
      "DELETE FROM public.sec_tenant_action_policy WHERE tenant_id=$1 AND action_id=ANY($2::text[]) AND updated_by=$3",
      [tenantId, [...actions], updatedBy],
    ));
  }
}
