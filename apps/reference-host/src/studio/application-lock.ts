/**
 * Locks an application row FOR SHARE inside the caller's tenant transaction (Studio V1B, D14). The V1A executors read "is the application enabled" in one transaction and wrote in another, so
 * a disable that committed between the two could not stop the write. Taking a share lock on the application row in the SAME transaction as the write closes that window: a concurrent
 * disable (an UPDATE, which needs an exclusive row lock) waits until the writing transaction commits, and a write that starts after the disable committed reads `enabled = false`.
 * Lock order everywhere: (walkthrough rows / advisory locks) before the application row, and nothing that holds an application lock waits for a walkthrough lock, so there is no cycle.
 */
import type { TenantClient } from "../authoring/tenant-tx.js";

export interface LockedApplication { readonly enabled: boolean; readonly registryId: string; readonly routing: "hash" | "history" }

export const lockApplicationShared = (client: TenantClient, tenantId: string, applicationId: string) =>
  lockApplication(client, tenantId, applicationId, "FOR SHARE");

/** Serialize publish and repair with registry writes and other working-copy mutations while validating the current registry. */
export const lockApplicationForRegistryChange = (client: TenantClient, tenantId: string, applicationId: string) =>
  lockApplication(client, tenantId, applicationId, "FOR NO KEY UPDATE");

async function lockApplication(client: TenantClient, tenantId: string, applicationId: string, lock: "FOR SHARE" | "FOR NO KEY UPDATE"): Promise<LockedApplication | null> {
  const { rows } = await client.query(`SELECT enabled, registry_id, routing FROM public.studio_applications WHERE tenant_id = $1::uuid AND application_id = $2 ${lock}`, [tenantId, applicationId]);
  const row = rows[0];
  return row === undefined ? null : { enabled: row.enabled === true, registryId: String(row.registry_id), routing: row.routing === "history" ? "history" : "hash" };
}
