import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReplayGuard, TenantId, TenantScope } from "@dap/contracts";

export interface ReplayTestContext {
  readonly store: ReplayGuard;
  /** Advance the adapter's authoritative clock (including the DB clock in PostgreSQL tests). */
  readonly advanceSeconds: (seconds: number) => Promise<void>;
  readonly dispose?: () => Promise<void>;
}
/** One conformance property. Exported as data so a deliberately broken adapter can prove the property can fail. */
export interface ReplayConformanceCase {
  readonly name: string;
  readonly run: (ctx: ReplayTestContext) => Promise<void>;
}
const scope = (): TenantScope => ({ tenantId: randomUUID() as TenantId });
const BYTES_1024 = "k".repeat(1024);

export const replayConformanceCases: readonly ReplayConformanceCase[] = [
  {
    name: "exactly one of 32 concurrent claims wins, across 100 independent trials",
    async run(ctx) {
      const tenant = scope();
      for (let trial = 0; trial < 100; trial++) {
        const results = await Promise.all(Array.from({ length: 32 }, () => ctx.store.claim(tenant, `call:${trial}`, 60)));
        expect(results.filter((value) => value === "claimed")).toHaveLength(1);
        expect(results.filter((value) => value === "duplicate")).toHaveLength(31);
      }
    },
  },
  {
    name: "keeps equal keys independent per tenant and opaque namespace",
    async run(ctx) {
      const a = scope(); const b = scope();
      expect(await ctx.store.claim(a, "session-a:call-1", 60)).toBe("claimed");
      expect(await ctx.store.claim(b, "session-a:call-1", 60)).toBe("claimed");
      expect(await ctx.store.claim(a, "session-b:call-1", 60)).toBe("claimed");
      expect(await ctx.store.claim(a, "session-a:call-1", 60)).toBe("duplicate");
      // Embedded tenant text cannot select the scope; only the separate trusted argument can.
      const key = JSON.stringify({ tenantId: b.tenantId, key: "call" });
      expect(await ctx.store.claim(a, key, 60)).toBe("claimed");
      expect(await ctx.store.claim(b, key, 60)).toBe("claimed");
      expect(await ctx.store.claim(a, key, 60)).toBe("duplicate");
      // A key that merely ends like another tenant's key is still its own claim.
      expect(await ctx.store.claim(a, `${b.tenantId}:call`, 60)).toBe("claimed");
      expect(await ctx.store.claim(b, "call", 60)).toBe("claimed");
    },
  },
  {
    name: "uses a fixed retention boundary; duplicate claims never extend it",
    async run(ctx) {
      const tenant = scope();
      expect(await ctx.store.claim(tenant, "retained", 10)).toBe("claimed");
      await ctx.advanceSeconds(9);
      expect(await ctx.store.claim(tenant, "retained", 100)).toBe("duplicate");
      await ctx.advanceSeconds(1);
      expect(await ctx.store.claim(tenant, "retained", 10)).toBe("claimed");
    },
  },
  {
    name: "honours the retention each claim asked for, not a fixed default",
    async run(ctx) {
      const tenant = scope();
      expect(await ctx.store.claim(tenant, "short", 2)).toBe("claimed");
      expect(await ctx.store.claim(tenant, "long", 120)).toBe("claimed");
      await ctx.advanceSeconds(2);
      expect(await ctx.store.claim(tenant, "short", 2)).toBe("claimed");
      expect(await ctx.store.claim(tenant, "long", 120)).toBe("duplicate");
      await ctx.advanceSeconds(117);
      expect(await ctx.store.claim(tenant, "long", 120)).toBe("duplicate");
      await ctx.advanceSeconds(1);
      expect(await ctx.store.claim(tenant, "long", 120)).toBe("claimed");
    },
  },
  {
    name: "canonicalizes UUID case as the database does",
    async run(ctx) {
      const a = scope(); const upper = { tenantId: a.tenantId.toUpperCase() as TenantId };
      expect(await ctx.store.claim(a, "case", 60)).toBe("claimed");
      expect(await ctx.store.claim(upper, "case", 60)).toBe("duplicate");
      expect(await ctx.store.claim(upper, "case-2", 60)).toBe("claimed");
      expect(await ctx.store.claim(a, "case-2", 60)).toBe("duplicate");
    },
  },
  {
    name: "rejects invalid tenant/key/retention without creating a claim",
    async run(ctx) {
      const tenant = scope();
      for (const seconds of [0, -1, NaN, Infinity, 1.5, undefined, "60"]) {
        await expect(ctx.store.claim(tenant, "invalid", seconds as number)).rejects.toThrow();
      }
      for (const key of ["", "nul\u0000key", "x".repeat(1025), undefined, 1]) {
        await expect(ctx.store.claim(tenant, key as string, 60)).rejects.toThrow();
      }
      for (const invalid of [undefined, null, {}, { tenantId: "other" }]) {
        await expect(ctx.store.claim(invalid as TenantScope, "invalid", 60)).rejects.toThrow();
      }
      expect(await ctx.store.claim(tenant, "invalid", 60)).toBe("claimed");
    },
  },
  {
    name: "rejects a malformed tenant id in every spelling the database would normalize",
    async run(ctx) {
      const id = scope().tenantId;
      const spellings = [`{${id}}`, id.replaceAll("-", ""), ` ${id}`, `${id} `, `${id}\n`, `urn:uuid:${id}`, id.slice(0, 35), `${id}0`];
      for (const tenantId of spellings) await expect(ctx.store.claim({ tenantId: tenantId as TenantId }, "spelling", 60)).rejects.toThrow();
      expect(await ctx.store.claim({ tenantId: id }, "spelling", 60)).toBe("claimed");
    },
  },
  {
    name: "bounds keys at exactly 1024 UTF-8 bytes, counting bytes and not characters",
    async run(ctx) {
      const tenant = scope();
      expect(await ctx.store.claim(tenant, BYTES_1024, 60)).toBe("claimed");
      expect(await ctx.store.claim(tenant, BYTES_1024, 60)).toBe("duplicate");
      // 341 three-byte characters are 1023 bytes: accepted. 342 are 1026 bytes while only 342 characters long: refused.
      expect(await ctx.store.claim(tenant, "界".repeat(341), 60)).toBe("claimed");
      await expect(ctx.store.claim(tenant, "界".repeat(342), 60)).rejects.toThrow();
      await expect(ctx.store.claim(tenant, `${"k".repeat(1023)}é`, 60)).rejects.toThrow();
      await expect(ctx.store.claim(tenant, `${BYTES_1024}k`, 60)).rejects.toThrow();
    },
  },
  {
    name: "refuses keys that are not well-formed Unicode instead of storing a lossy form",
    async run(ctx) {
      const tenant = scope();
      for (const key of ["\ud800", "x\udc00", "a\ud800b", "\ud83d"]) await expect(ctx.store.claim(tenant, key, 60)).rejects.toThrow();
      // A correctly paired surrogate is ordinary text, and two different emoji stay two different claims.
      expect(await ctx.store.claim(tenant, "😀", 60)).toBe("claimed");
      expect(await ctx.store.claim(tenant, "😁", 60)).toBe("claimed");
      expect(await ctx.store.claim(tenant, "😀", 60)).toBe("duplicate");
    },
  },
];

export function runReplayConformance(makeStore: () => Promise<ReplayTestContext>): void {
  describe("ReplayGuard conformance", () => {
    let ctx: ReplayTestContext;
    beforeEach(async () => { ctx = await makeStore(); });
    afterEach(async () => { await ctx?.dispose?.(); });
    for (const conformanceCase of replayConformanceCases) it(conformanceCase.name, () => conformanceCase.run(ctx));
  });
}
