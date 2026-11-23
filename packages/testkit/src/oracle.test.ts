import { describe, expect, it } from "vitest";
import { mayReachExecutor, executionViolations, type ExecutionFacts } from "./oracle.js";
import { TENANT_A, TENANT_B } from "./world.js";

export const permittedFacts: ExecutionFacts = {
  tenantId: TENANT_A, resourceTenantId: TENANT_A, risk: "SAFE",
  authenticated: true, sessionValid: true, schemaValid: true, registered: true,
  globallyEnabled: true, tenantEnabled: true, userPermitted: true, contextAllowed: true,
  withinLimits: true, replayClaimed: true, allowEventCommitted: true, dependenciesHealthy: true,
  targetsResource: true, resourceAvailable: true, requiresConfirmation: false, confirmationAccepted: false,
};
describe("T125 independent execution oracle", () => {
  it("permits the fully authorized fixture and rejects forbidden risk or foreign resources", () => {
    expect(mayReachExecutor(permittedFacts)).toBe(true);
    expect(mayReachExecutor({ ...permittedFacts, risk: "FORBIDDEN" })).toBe(false);
    expect(mayReachExecutor({ ...permittedFacts, resourceTenantId: TENANT_B })).toBe(false);
    expect(mayReachExecutor({ ...permittedFacts, resourceAvailable: false })).toBe(false);
  });
  it.each(["authenticated", "sessionValid", "schemaValid", "registered", "globallyEnabled", "tenantEnabled", "userPermitted", "contextAllowed", "withinLimits", "replayClaimed", "allowEventCommitted", "dependenciesHealthy"] as const)("requires literal true for %s", (key) => {
    for (const value of [false, undefined, null, "yes", 1, {}]) expect(mayReachExecutor({ ...permittedFacts, [key]: value })).toBe(false);
  });
  it("resource-free actions need no resource; conditional flags must be booleans", () => {
    expect(mayReachExecutor({ ...permittedFacts, targetsResource: false, resourceAvailable: false, resourceTenantId: null })).toBe(true);
    expect(mayReachExecutor({ ...permittedFacts, targetsResource: undefined })).toBe(false);
    expect(mayReachExecutor({ ...permittedFacts, requiresConfirmation: undefined })).toBe(false);
  });
  it.each(["MEDIUM", "HIGH", "CRITICAL"] as const)("honors confirmation for %s", (risk) => {
    expect(mayReachExecutor({ ...permittedFacts, risk, requiresConfirmation: true })).toBe(false);
    expect(mayReachExecutor({ ...permittedFacts, risk, requiresConfirmation: true, confirmationAccepted: true })).toBe(true);
  });
  it("HIGH/CRITICAL cannot opt out and bad facts fail closed", () => {
    for (const risk of ["HIGH", "CRITICAL", "invented"]) expect(mayReachExecutor({ ...permittedFacts, risk })).toBe(false);
    expect(mayReachExecutor(undefined as never)).toBe(false);
    expect(mayReachExecutor({ ...permittedFacts, get userPermitted() { throw new Error("fault"); } })).toBe(false);
    expect(executionViolations({ ...permittedFacts, schemaValid: false }, 1)).toEqual(["execution without all world prerequisites"]);
    expect(executionViolations(permittedFacts, 1)).toEqual([]);
    for (const count of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(executionViolations(permittedFacts, count)).toEqual(["invalid executor count"]);
    expect(executionViolations({ ...permittedFacts, registered: false }, 0)).toEqual([]);
    for (const tenantId of ["", null, 1]) expect(mayReachExecutor({ ...permittedFacts, tenantId, targetsResource: false } as never)).toBe(false);
  });
});
