/**
 * Locks an application row FOR SHARE inside the caller's tenant transaction (Studio V1B, D14). The V1A executors read "is the application enabled" in one transaction and wrote in another, so
 * a disable that committed between the two could not stop the write. Taking a share lock on the application row in the SAME transaction as the write closes that window: a concurrent
 * disable (an UPDATE, which needs an exclusive row lock) waits until the writing transaction commits, and a write that starts after the disable committed reads `enabled = false`.
 * Lock order everywhere: (walkthrough rows / advisory locks) before the application row, and nothing that holds an application lock waits for a walkthrough lock, so there is no cycle.
 */
import type { TenantClient } from "../authoring/tenant-tx.js";

export interface LockedApplication { readonly enabled: boolean; readonly registryId: string }

export async function lockApplicationShared(client: TenantClient, tenantId: string, applicationId: string): Promise<LockedApplication | null> {
  const { rows } = await client.query("SELECT enabled, registry_id FROM public.studio_applications WHERE tenant_id = $1::uuid AND application_id = $2 FOR SHARE", [tenantId, applicationId]);
  const row = rows[0];
  return row === undefined ? null : { enabled: row.enabled === true, registryId: String(row.registry_id) };
}
