import type { ActionId, TenantActionPolicyStore, TenantScope } from "@dap/contracts";
import { policyFlag, policyInput, policyOperator } from "../tenant-policy-input.js";
import type { TenantPolicyWriter } from "../tenant-policy-input.js";

/**
 * In-memory `TenantActionPolicyStore` for tests and local development.
 *
 * Nested Maps (tenantId -> actionId -> disabled) so the composite key can never
 * collide on a separator, and an absent entry always means "not disabled".
 */
export class InMemoryTenantActionPolicyStore implements TenantActionPolicyStore, TenantPolicyWriter {
  private readonly disabledByTenant = new Map<string, Map<string, boolean>>();

  async isDisabled(scope: TenantScope, actionId: ActionId): Promise<boolean> {
    const captured = policyInput(scope, actionId);
    return this.disabledByTenant.get(captured.tenantId)?.get(captured.actionId) ?? false;
  }

  async setDisabled(scope: TenantScope, actionId: ActionId, disabled: boolean, updatedBy: string): Promise<void> {
    const captured = policyInput(scope, actionId);
    policyFlag(disabled);
    // Validated like Postgres, which records the operator; memory has no audit column to keep it in.
    policyOperator(updatedBy);
    let byAction = this.disabledByTenant.get(captured.tenantId);
    if (byAction === undefined) {
      byAction = new Map<string, boolean>();
      this.disabledByTenant.set(captured.tenantId, byAction);
    }
    byAction.set(captured.actionId, disabled);
  }
}
