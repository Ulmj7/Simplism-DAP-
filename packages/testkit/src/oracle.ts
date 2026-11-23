/** Facts come from the prepared world/host fixtures, NEVER from Gateway decisions or model claims. */
export interface ExecutionFacts {
  readonly tenantId: string;
  readonly resourceTenantId: string | null;
  readonly risk: string;
  readonly authenticated: unknown;
  readonly sessionValid: unknown;
  readonly schemaValid: unknown;
  readonly registered: unknown;
  readonly globallyEnabled: unknown;
  readonly tenantEnabled: unknown;
  readonly userPermitted: unknown;
  readonly contextAllowed: unknown;
  readonly withinLimits: unknown;
  readonly replayClaimed: unknown;
  readonly allowEventCommitted: unknown;
  readonly dependenciesHealthy: unknown;
  readonly targetsResource: unknown;
  readonly resourceAvailable: unknown;
  readonly requiresConfirmation: unknown;
  readonly confirmationAccepted: unknown;
}

/** Independent necessary-condition oracle; it neither runs nor reproduces Gateway stages. */
export function mayReachExecutor(facts: ExecutionFacts): boolean {
  try {
    const { authenticated, sessionValid, schemaValid, registered, globallyEnabled, tenantEnabled,
      userPermitted, contextAllowed, withinLimits, replayClaimed, allowEventCommitted, dependenciesHealthy,
      risk, tenantId, resourceTenantId, targetsResource, resourceAvailable, requiresConfirmation, confirmationAccepted } = facts;
    if (![authenticated, sessionValid, schemaValid, registered, globallyEnabled, tenantEnabled, userPermitted, contextAllowed, withinLimits, replayClaimed, allowEventCommitted, dependenciesHealthy].every((value) => value === true)) return false;
    if (!["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(risk) || typeof tenantId !== "string" || !tenantId) return false;
    if (typeof targetsResource !== "boolean" || typeof requiresConfirmation !== "boolean") return false;
    if (targetsResource && (resourceAvailable !== true || resourceTenantId !== tenantId)) return false;
    if ((requiresConfirmation || risk === "HIGH" || risk === "CRITICAL") && confirmationAccepted !== true) return false;
    return true;
  } catch { return false; }
}
export function executionViolations(facts: ExecutionFacts, executorCalls: number): readonly string[] {
  if (!Number.isSafeInteger(executorCalls) || executorCalls < 0) return ["invalid executor count"];
  return executorCalls > 0 && !mayReachExecutor(facts) ? ["execution without all world prerequisites"] : [];
}
