import type { Pool } from "pg";
import type { ActionId, TenantActionPolicyStore, TenantScope } from "@dap/contracts";
import { withTenant } from "./tenant-tx.js";
import { policyFlag, policyInput, policyOperator } from "../tenant-policy-input.js";
import type { TenantPolicyWriter } from "../tenant-policy-input.js";

function disabledFrom(result: unknown): boolean {
  if (!result || typeof result !== "object") throw new TypeError("Invalid tenant policy query result");
  const { rows, rowCount, command } = result as { rows?: unknown; rowCount?: unknown; command?: unknown };
  if (command !== "SELECT" || !Array.isArray(rows)) throw new TypeError("Invalid tenant policy query result");
  const length: unknown = rows.length;
  if ((length !== 0 && length !== 1) || rowCount !== length) throw new TypeError("Invalid tenant policy query result");
  if (length === 0) return false;
  const row: unknown = rows[0];
  if (!row || typeof row !== "object" || !Object.hasOwn(row, "disabled")) throw new TypeError("Invalid tenant policy query result");
  const disabled: unknown = Reflect.get(row, "disabled");
  if (typeof disabled !== "boolean") throw new TypeError("Invalid tenant policy query result");
  return disabled;
}

/**
 * `TenantActionPolicyStore` backed by `sec_tenant_action_policy` (T048).
 *
 * Every read and write goes through `withTenant`, so the forced RLS policy
 * (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
 * scopes rows to the tenant even if this adapter is bypassed.
 */
export class PostgresTenantActionPolicyStore implements TenantActionPolicyStore, TenantPolicyWriter {
  constructor(private readonly pool: Pool) {}

  async isDisabled(scope: TenantScope, actionId: ActionId): Promise<boolean> {
    const captured = policyInput(scope, actionId);
    return withTenant(this.pool, captured.tenantId, async (client) => {
      const result: unknown = await client.query(
        "SELECT disabled FROM public.sec_tenant_action_policy WHERE tenant_id = $1 AND action_id = $2",
        [captured.tenantId, captured.actionId],
      );
      return disabledFrom(result);
    });
  }

  async setDisabled(scope: TenantScope, actionId: ActionId, disabled: boolean, updatedBy: string): Promise<void> {
    const captured = policyInput(scope, actionId);
    policyFlag(disabled);
    const operator = policyOperator(updatedBy);
    await withTenant(this.pool, captured.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO public.sec_tenant_action_policy (tenant_id, action_id, disabled, updated_at, updated_by)
         VALUES ($1, $2, $3, now(), $4)
         ON CONFLICT (tenant_id, action_id)
         DO UPDATE SET disabled = EXCLUDED.disabled, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [captured.tenantId, captured.actionId, disabled, operator],
      );
      if (result.command !== "INSERT" || result.rowCount !== 1) throw new TypeError("Invalid tenant policy write result");
    });
  }
}
