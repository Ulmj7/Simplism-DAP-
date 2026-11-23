import { describe, it, expect } from "vitest";
import { isMintedContext } from "@dap/contracts/mint";
import {
  ALICE,
  BOB,
  CAROL,
  TENANT_A,
  TENANT_A_RESOURCES,
  TENANT_B,
  TENANT_B_RESOURCES,
  USER_ROLES,
  ctx,
} from "./world.js";

describe("world (T034)", () => {
  it("ctx is recognized by isMintedContext", () => {
    expect(isMintedContext(ctx(TENANT_A, ALICE))).toBe(true);
    expect(isMintedContext(ctx(TENANT_B, CAROL))).toBe(true);
  });

  it("contexts are frozen", () => {
    expect(Object.isFrozen(ctx(TENANT_A, ALICE))).toBe(true);
    expect(Object.isFrozen(ctx(TENANT_B, BOB))).toBe(true);
  });

  it("tenants A and B differ", () => {
    expect(TENANT_A).not.toBe(TENANT_B);
    expect(ctx(TENANT_A, ALICE).tenantId).not.toBe(ctx(TENANT_B, ALICE).tenantId);
  });

  it("the same userId in both tenants yields distinct minted contexts", () => {
    const a = ctx(TENANT_A, BOB);
    const b = ctx(TENANT_B, BOB);
    expect(a.userId).toBe(b.userId);
    expect(a).not.toBe(b);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a.authenticatedAt).not.toBe(b.authenticatedAt);
  });

  it("validUntil is after authenticatedAt for every (tenant, user)", () => {
    for (const tenant of [TENANT_A, TENANT_B]) {
      for (const user of [ALICE, BOB, CAROL]) {
        const c = ctx(tenant, user);
        expect(c.validUntil > c.authenticatedAt).toBe(true);
      }
    }
  });

  it("has two resources per tenant and three users with roles", () => {
    expect(TENANT_A_RESOURCES.map((r) => r.tenantId)).toEqual([TENANT_A, TENANT_A]);
    expect(TENANT_B_RESOURCES.map((r) => r.tenantId)).toEqual([TENANT_B, TENANT_B]);
    expect(USER_ROLES.map((u) => [u.userId, u.role])).toEqual([
      [ALICE, "admin"],
      [BOB, "member"],
      [CAROL, "read-only"],
    ]);
  });

  it("ctx() rejects unknown tenant/user pairs", () => {
    const stranger = "99999999-9999-4999-8999-999999999999" as never;
    expect(() => ctx(stranger, ALICE)).toThrow();
    expect(() => ctx(TENANT_A, "mallory" as never)).toThrow();
  });
});
