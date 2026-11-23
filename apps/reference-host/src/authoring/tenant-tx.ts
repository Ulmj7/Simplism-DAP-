/**
 * A tenant-scoped transaction for the authoring store (Feature 004, T404).
 *
 * Outcome of the `withTenant` question (Decision 10): the PUBLIC `@dap/security` API gives the host a pool (`createPostgresPool`) but no tenant-scoped transaction
 * (its tested `withTenant` is internal to the package and not exported). Rather than widen a Feature 001 package, this host-local helper reproduces the SAME
 * semantics, line for line:
 *
 *   BEGIN; SELECT set_config('app.tenant_id', $1, true) (transaction-local: it cannot leak to the next use of a pooled connection); fn; COMMIT, and the
 *   command that came back must really be COMMIT (a transaction the server already rolled back "commits" as ROLLBACK, which is an error here, never a success);
 *   on any error ROLLBACK; if even the ROLLBACK fails the connection is DISCARDED instead of returned to the pool; always release.
 *
 * It is typed from `createPostgresPool`'s own return type (through `pool.ts`), so the host declares no database-driver dependency. The tenant id is taken from the trusted context
 * of the caller and never from a request: this function checks it is a UUID (the policy compares `tenant_id` as a uuid) before it touches the connection.
 */
import type { TenantPool } from "./pool.js";

export type { TenantPool };
/** What a transaction body may do: run parameterised statements. Nothing else of the connection is reachable. */
export interface TenantClient {
  query(sql: string, params?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[]; readonly rowCount: number | null }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function withTenant<T>(pool: TenantPool, tenantId: string, fn: (client: TenantClient) => Promise<T>): Promise<T> {
  if (typeof tenantId !== "string" || !UUID.test(tenantId)) throw new TypeError("A tenant id from the trusted context is required");
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn({ query: (sql, params) => client.query(sql, params === undefined ? undefined : [...params]) as never });
    const commit = await client.query("COMMIT");
    if (commit.command !== "COMMIT") throw new Error("Tenant transaction was rolled back instead of committed.");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
