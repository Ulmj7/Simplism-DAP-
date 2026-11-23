import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { ActionId, TenantActionPolicyStore, TenantScope, TenantId } from "@dap/contracts";

/**
 * Shared conformance suite for every `TenantActionPolicyStore` implementation.
 *
 * The suite only reads through `store.isDisabled` and writes through the
 * implementation's own `setDisabled`, so an adapter that caches values between
 * calls fails here (research D16: read on EVERY proposal, no caching).
 *
 * `makeStore` must return a fresh store per test run and a writer bound to the
 * same implementation under test.
 */

const freshScope = (): TenantScope => Object.freeze({ tenantId: randomUUID() as TenantId });

/** Fresh action id per test so no run observes another run's rows. */
const freshActionId = (): ActionId => `conformance${randomUUID().replaceAll("-", "")}` as ActionId;

export interface TenantPolicyTestContext {
  readonly store: TenantActionPolicyStore;
  readonly setDisabled: (scope: TenantScope, actionId: ActionId, disabled: boolean) => Promise<void>;
}

/** Reused verbatim by the suite and its mutation tests. */
export async function assertTenantPolicyIsolation(ctx: TenantPolicyTestContext): Promise<void> {
  const scopeA = freshScope(); const scopeB = freshScope(); const id = freshActionId();
  await ctx.setDisabled(scopeA, id, true);
  expect(await ctx.store.isDisabled(scopeA, id)).toBe(true);
  expect(await ctx.store.isDisabled(scopeB, id)).toBe(false);
}

export async function assertTenantPolicyFreshness(ctx: TenantPolicyTestContext): Promise<void> {
  const scope = freshScope(); const id = freshActionId();
  const seen = [await ctx.store.isDisabled(scope, id)];
  await ctx.setDisabled(scope, id, true);
  seen.push(await ctx.store.isDisabled(scope, id));
  await ctx.setDisabled(scope, id, false);
  seen.push(await ctx.store.isDisabled(scope, id));
  expect(seen).toEqual([false, true, false]);
}

export function runTenantPolicyConformance(makeStore: () => Promise<TenantPolicyTestContext>): void {
  describe("TenantActionPolicyStore conformance", () => {
    let ctx: TenantPolicyTestContext;
    const scopeA = freshScope(); const scopeB = freshScope();

    beforeAll(async () => {
      ctx = await makeStore();
    });

    it("reports not disabled by default", async () => {
      const id = freshActionId();
      expect(await ctx.store.isDisabled(scopeA, id)).toBe(false);
      expect(await ctx.store.isDisabled(scopeB, id)).toBe(false);
    });

    it("disabled = true affects only the named tenant", async () => {
      await assertTenantPolicyIsolation(ctx);
    });

    it("keeps the same action id independent across two tenants", async () => {
      const id = freshActionId();
      await ctx.setDisabled(scopeA, id, true);
      expect(await ctx.store.isDisabled(scopeA, id)).toBe(true);
      expect(await ctx.store.isDisabled(scopeB, id)).toBe(false);
      await ctx.setDisabled(scopeB, id, true);
      expect(await ctx.store.isDisabled(scopeB, id)).toBe(true);
      expect(await ctx.store.isDisabled(scopeA, id)).toBe(true);
      // Re-enabling one tenant leaves the other untouched.
      await ctx.setDisabled(scopeA, id, false);
      expect(await ctx.store.isDisabled(scopeA, id)).toBe(false);
      expect(await ctx.store.isDisabled(scopeB, id)).toBe(true);
    });

    it("reads the value on every call (no caching): flips between consecutive reads are observed", async () => {
      await assertTenantPolicyFreshness(ctx);
    });
  });
}
