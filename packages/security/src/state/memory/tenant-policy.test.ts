import { describe, expect, it } from "vitest";
import type { ActionId, TenantId } from "@dap/contracts";
import { InMemoryTenantActionPolicyStore } from "./tenant-policy.js";

const A = "aaaaaaaa-1111-4111-8111-111111111111" as TenantId;
const B = "bbbbbbbb-2222-4222-8222-222222222222" as TenantId;
describe("memory tenant policy isolation", () => {
  it("reads a scope getter once when inserting and normalizes UUID case like Postgres", async () => {
    const store = new InMemoryTenantActionPolicyStore();
    let reads = 0;
    await store.setDisabled({ get tenantId() { return ++reads === 1 ? A : B; } }, "action" as ActionId, true, "operator");
    expect(reads).toBe(1);
    expect(await store.isDisabled({ tenantId: A.toUpperCase() as TenantId }, "action" as ActionId)).toBe(true);
    expect(await store.isDisabled({ tenantId: B }, "action" as ActionId)).toBe(false);
  });
  it("keeps exact action keys and tenant maps independent", async () => {
    const store = new InMemoryTenantActionPolicyStore();
    for (const name of ["constructor", "__proto__", "action", "Action", "action "]) {
      await store.setDisabled({ tenantId: A }, name as ActionId, true, "operator");
      expect(await store.isDisabled({ tenantId: A }, name as ActionId)).toBe(true);
      expect(await store.isDisabled({ tenantId: B }, name as ActionId)).toBe(false);
    }
    expect(await store.isDisabled({ tenantId: A }, "action\u200b" as ActionId)).toBe(false);
  });
  it("rejects malformed scopes, text keys and non-boolean configuration", async () => {
    const store = new InMemoryTenantActionPolicyStore();
    await expect(store.isDisabled({ tenantId: "bad" as TenantId }, "action" as ActionId)).rejects.toBeInstanceOf(TypeError);
    await expect(store.setDisabled({ tenantId: A }, "action" as ActionId, undefined as never, "operator")).rejects.toBeInstanceOf(TypeError);
    await expect(store.setDisabled({ tenantId: A }, "action\u0000id" as ActionId, true, "operator")).rejects.toBeInstanceOf(TypeError);
    for (const actionId of ["", { length: 1, includes: () => false }]) {
      await expect(store.isDisabled({ tenantId: A }, actionId as ActionId)).rejects.toBeInstanceOf(TypeError);
      await expect(store.setDisabled({ tenantId: A }, actionId as ActionId, true, "operator")).rejects.toBeInstanceOf(TypeError);
    }
  });
});

describe("memory and Postgres stores take the same write arguments", () => {
  it.each([undefined, null, "", 7, {}, { length: 1, includes: () => false }, "operator\u0000id"])("the memory store rejects the operator id %j exactly as Postgres does", async (operator) => {
    const store = new InMemoryTenantActionPolicyStore();
    await expect(store.setDisabled({ tenantId: A }, "action" as ActionId, true, operator as never)).rejects.toBeInstanceOf(TypeError);
    expect(await store.isDisabled({ tenantId: A }, "action" as ActionId)).toBe(false);
  });

  it("accepts an ordinary operator id, including one with quotes, and records nothing it should not", async () => {
    const store = new InMemoryTenantActionPolicyStore();
    await store.setDisabled({ tenantId: A }, "action" as ActionId, true, "operator'payload");
    expect(await store.isDisabled({ tenantId: A }, "action" as ActionId)).toBe(true);
  });
});
