import { z } from "zod";
import type { ActionId, TenantId, TenantScope } from "@dap/contracts";

const uuid = z.uuid();
export function policyInput(scope: TenantScope, actionId: ActionId): { tenantId: TenantId; actionId: ActionId } {
  const tenantId: unknown = scope.tenantId;
  if (!uuid.safeParse(tenantId).success) throw new TypeError("Tenant policy requires a UUID tenant");
  if (typeof actionId !== "string" || actionId.length === 0 || actionId.includes("\u0000")) throw new TypeError("Tenant policy requires a text action id");
  // PostgreSQL's uuid type is case-insensitive; memory must use the same tenant identity.
  return Object.freeze({ tenantId: (tenantId as string).toLowerCase() as TenantId, actionId });
}

export function policyFlag(disabled: boolean): void {
  if (typeof disabled !== "boolean") throw new TypeError("Tenant policy requires a literal boolean flag");
}

/** The operator recorded with every policy write. Shared so the memory and Postgres stores reject exactly the same values. */
export function policyOperator(updatedBy: unknown): string {
  if (typeof updatedBy !== "string" || updatedBy.length === 0 || updatedBy.includes("\u0000")) throw new TypeError("Tenant policy requires an operator id");
  return updatedBy;
}

/**
 * The write side of a tenant policy store. It is outside the 1-argument read port (`isDisabled` can only
 * disable, never enable), but every implementation must take the SAME arguments, so code developed against
 * the in-memory store cannot call `setDisabled` in a way Postgres rejects.
 */
export interface TenantPolicyWriter {
  setDisabled(scope: TenantScope, actionId: ActionId, disabled: boolean, updatedBy: string): Promise<void>;
}
