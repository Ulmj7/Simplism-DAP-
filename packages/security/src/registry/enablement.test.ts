import { describe, expect, it } from "vitest";
import type { ActionId, TenantActionPolicyStore, TenantId, TenantScope } from "@dap/contracts";
import { buildRegistry } from "./build-registry.js";
import { createEnablementPolicy } from "./enablement.js";
import { RegistrationError } from "./registration-error.js";
import { definition } from "./fixtures.test-support.js";

const tenantA = { tenantId: "00000000-0000-4000-8000-000000000001" as TenantId };
const tenantB = { tenantId: "00000000-0000-4000-8000-000000000002" as TenantId };

function fakeStore() {
  const disabled = new Set<string>();
  const calls: { scope: TenantScope; actionId: ActionId }[] = [];
  const store: TenantActionPolicyStore = {
    async isDisabled(scope, actionId) {
      calls.push({ scope, actionId });
      return disabled.has(`${scope.tenantId}:${actionId}`);
    },
  };
  return { disabled, calls, store };
}

describe("default-deny enablement with live tenant narrowing", () => {
  it("denies when the global allowlist is omitted or empty", async () => {
    const { store } = fakeStore();
    const registry = buildRegistry([definition()]);
    for (const options of [{ registry, tenantPolicy: store }, { registry, tenantPolicy: store, globalAllowlist: new Set<ActionId>() }]) {
      expect(await createEnablementPolicy(options).isEnabled(tenantA, "viewProject")).toBe(false);
    }
  });

  it("enables only an exact globally allowlisted entry not disabled for that tenant", async () => {
    const { store, disabled } = fakeStore();
    const registry = buildRegistry([definition(), definition({ id: "viewOther" as ActionId })]);
    const policy = createEnablementPolicy({ registry, globalAllowlist: new Set(["viewProject" as ActionId]), tenantPolicy: store });
    expect(await policy.isEnabled(tenantA, "viewProject")).toBe(true);
    expect(await policy.isEnabled(tenantA, "viewOther")).toBe(false);
    for (const name of ["unknownAction", "ViewProject", "viewProject ", "viewProject\u200b", "__proto__", "constructor"]) {
      expect(await policy.isEnabled(tenantA, name)).toBe(false);
    }
    disabled.add(`${tenantA.tenantId}:viewProject`);
    expect(await policy.isEnabled(tenantA, "viewProject")).toBe(false);
    expect(await policy.isEnabled(tenantB, "viewProject")).toBe(true);
    disabled.delete(`${tenantA.tenantId}:viewProject`);
    expect(await policy.isEnabled(tenantA, "viewProject")).toBe(true);
  });

  it("re-reads the tenant policy on every eligible call without caching", async () => {
    const { store, disabled, calls } = fakeStore();
    const policy = createEnablementPolicy({ registry: buildRegistry([definition()]), globalAllowlist: new Set(["viewProject" as ActionId]), tenantPolicy: store });
    expect(await policy.isEnabled(tenantA, "viewProject")).toBe(true);
    disabled.add(`${tenantA.tenantId}:viewProject`);
    expect(await policy.isEnabled(tenantA, "viewProject")).toBe(false);
    expect(calls).toEqual([
      { scope: tenantA, actionId: "viewProject" }, { scope: tenantA, actionId: "viewProject" },
    ]);
  });

  it("snapshots the static allowlist and freezes the policy", async () => {
    const { store } = fakeStore();
    const globalAllowlist = new Set(["viewProject" as ActionId]);
    const policy = createEnablementPolicy({ registry: buildRegistry([definition()]), globalAllowlist, tenantPolicy: store });
    globalAllowlist.clear();
    expect(await policy.isEnabled(tenantA, "viewProject")).toBe(true);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it("fails startup for every unknown or FORBIDDEN allowlist entry, collecting all issues", () => {
    const { store } = fakeStore();
    const registry = buildRegistry([definition(), definition({ id: "testForbiddenShell" as ActionId, risk: "FORBIDDEN" })]);
    let caught: unknown;
    try {
      createEnablementPolicy({ registry, globalAllowlist: new Set(["unknownAction", "testForbiddenShell", "ViewProject"] as ActionId[]), tenantPolicy: store });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(RegistrationError);
    expect((caught as RegistrationError).issues).toHaveLength(3);
    expect((caught as RegistrationError).issues).toContainEqual(expect.objectContaining({ actionId: "testForbiddenShell", rule: "R7" }));
  });

  it("does not grant FORBIDDEN entries even with an empty allowlist", async () => {
    const { store } = fakeStore();
    const registry = buildRegistry([definition({ risk: "FORBIDDEN" })]);
    expect(await createEnablementPolicy({ registry, tenantPolicy: store }).isEnabled(tenantA, "viewProject")).toBe(false);
  });

  it.each([undefined, null, "false", 0, {}])("fails closed for malformed tenant answer %j", async (answer) => {
    const tenantPolicy = { isDisabled: async () => answer } as unknown as TenantActionPolicyStore;
    const policy = createEnablementPolicy({ registry: buildRegistry([definition()]), globalAllowlist: new Set(["viewProject" as ActionId]), tenantPolicy });
    expect(await policy.isEnabled(tenantA, "viewProject")).toBe(false);
  });

  it("propagates a tenant store failure so the gateway can report dependency failure", async () => {
    const tenantPolicy: TenantActionPolicyStore = { isDisabled: async () => { throw new Error("store unavailable"); } };
    const policy = createEnablementPolicy({ registry: buildRegistry([definition()]), globalAllowlist: new Set(["viewProject" as ActionId]), tenantPolicy });
    await expect(policy.isEnabled(tenantA, "viewProject")).rejects.toThrow("store unavailable");
  });
});
