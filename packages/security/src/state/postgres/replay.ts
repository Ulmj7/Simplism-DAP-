import type { Pool } from "pg";
import type { ReplayGuard, TenantScope } from "@dap/contracts";
import { withTenant } from "./tenant-tx.js";
import { captureStateInput, checkedDate, resolveStateClock, stateInteger, type PostgresStateTestOptions } from "./state-runtime.js";

export class PostgresReplayGuard implements ReplayGuard {
  private readonly now: ReturnType<typeof resolveStateClock>;
  constructor(private readonly pool: Pool, options: PostgresStateTestOptions = {}) { this.now = resolveStateClock(options); }

  async claim(scope: TenantScope, key: string, retainSeconds: number): Promise<"claimed" | "duplicate"> {
    const input = captureStateInput(scope, key);
    const seconds = stateInteger(retainSeconds, 31_536_000);
    return withTenant(this.pool, input.tenantId, async (client) => {
      const now = checkedDate(await this.now(client));
      // DELETE and INSERT share the transaction. Concurrent deletes recheck the locked row;
      // the PK plus DO NOTHING admits at most one replacement after expiry.
      await client.query("DELETE FROM public.sec_replay_claims WHERE tenant_id=$1 AND namespace='proposal' AND claim_key=$2 AND expires_at <= $3", [input.tenantId, input.key, now]);
      const result = await client.query(
        `INSERT INTO public.sec_replay_claims (tenant_id,namespace,claim_key,claimed_at,expires_at)
         VALUES ($1,'proposal',$2,$3,$3::timestamptz + $4 * interval '1 second')
         ON CONFLICT (tenant_id,namespace,claim_key) DO NOTHING`,
        [input.tenantId, input.key, now, seconds],
      );
      const { command, rowCount, rows } = result;
      if (command !== "INSERT" || (rowCount !== 0 && rowCount !== 1) || !Array.isArray(rows) || rows.length !== 0) throw new TypeError("Invalid replay claim result");
      return rowCount === 1 ? "claimed" : "duplicate";
    });
  }
}
