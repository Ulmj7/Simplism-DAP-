import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RateLimiter, RateLimitRule, TenantId, TenantScope } from "@dap/contracts";

export interface RateLimiterTestContext {
  readonly store: RateLimiter;
  /** Advance the adapter's authoritative clock. The factory starts it on a minute (and hour) boundary. Fractions are binary-exact. */
  readonly advanceSeconds: (seconds: number) => Promise<void>;
  readonly dispose?: () => Promise<void>;
}
/** One conformance property. Exported as data so a deliberately broken adapter can prove the property can fail. */
export interface RateLimiterConformanceCase {
  readonly name: string;
  readonly run: (ctx: RateLimiterTestContext) => Promise<void>;
  /** Time budget in ms for slow-by-design cases; omitted means the project default. It never changes what the case asserts. */
  readonly timeoutMs?: number;
}
const scope = (): TenantScope => ({ tenantId: randomUUID() as TenantId });
const rule = { limit: 20, windowSeconds: 60 };
const one = { limit: 1, windowSeconds: 60 };
const BYTES_1024 = "k".repeat(1024);

export const rateLimiterConformanceCases: readonly RateLimiterConformanceCase[] = [
  {
    name: "never loses concurrent hits: exactly the limit wins in each of 100 trials",
    // About 6,500 transactional hits under advisory locks: roughly 10 s on a slow local machine, near the 5 s default on CI runners.
    timeoutMs: 30_000,
    async run(ctx) {
      const tenant = scope();
      for (let trial = 0; trial < 100; trial++) {
        const key = `user:${trial}`;
        const results = await Promise.all(Array.from({ length: 64 }, () => ctx.store.hit(tenant, key, rule)));
        expect(results.filter((value) => value.allowed)).toHaveLength(20);
        expect(results.filter((value) => !value.allowed)).toHaveLength(44);
        expect(await ctx.store.hit(tenant, key, rule)).toMatchObject({ allowed: false });
        for (const result of results) {
          expect(Number.isInteger(result.retryAfterSeconds)).toBe(true);
          expect(result.retryAfterSeconds).toBe(result.allowed ? 0 : 60);
        }
      }
    },
  },
  {
    name: "admits exactly `limit` sequential hits, then denies every further hit in the window",
    async run(ctx) {
      const tenant = scope(); const three = { limit: 3, windowSeconds: 60 };
      for (let hit = 1; hit <= 3; hit++) expect(await ctx.store.hit(tenant, "seq", three), `hit ${hit}`).toEqual({ allowed: true, retryAfterSeconds: 0 });
      for (let hit = 4; hit <= 8; hit++) expect(await ctx.store.hit(tenant, "seq", three), `hit ${hit}`).toEqual({ allowed: false, retryAfterSeconds: 60 });
    },
  },
  // Factory starts the authoritative clock at a minute boundary for these fixed-window checks.
  {
    name: "rolls over exactly at the epoch-aligned fixed-window boundary",
    async run(ctx) {
      const tenant = scope(); const rule = { limit: 1, windowSeconds: 60 };
      expect(await ctx.store.hit(tenant, "window", rule)).toEqual({ allowed: true, retryAfterSeconds: 0 });
      await ctx.advanceSeconds(59.5);
      expect(await ctx.store.hit(tenant, "window", rule)).toEqual({ allowed: false, retryAfterSeconds: 1 });
      await ctx.advanceSeconds(0.5);
      expect(await ctx.store.hit(tenant, "window", rule)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    },
  },
  {
    name: "anchors every window to the epoch, never to the first hit",
    async run(ctx) {
      const tenant = scope();
      await ctx.advanceSeconds(30);
      expect(await ctx.store.hit(tenant, "anchor", one)).toEqual({ allowed: true, retryAfterSeconds: 0 });
      await ctx.advanceSeconds(29);
      expect(await ctx.store.hit(tenant, "anchor", one)).toEqual({ allowed: false, retryAfterSeconds: 1 });
      await ctx.advanceSeconds(1);
      expect(await ctx.store.hit(tenant, "anchor", one)).toEqual({ allowed: true, retryAfterSeconds: 0 });
      // The same holds for a window longer than a minute: 90 s into a 120 s window leaves 30 s, not 120.
      await ctx.advanceSeconds(30);
      const long = { limit: 1, windowSeconds: 120 };
      expect(await ctx.store.hit(tenant, "anchor-long", long)).toEqual({ allowed: true, retryAfterSeconds: 0 });
      expect(await ctx.store.hit(tenant, "anchor-long", long)).toEqual({ allowed: false, retryAfterSeconds: 30 });
    },
  },
  {
    name: "denied hits neither extend nor shift the window",
    async run(ctx) {
      const tenant = scope();
      expect(await ctx.store.hit(tenant, "sliding", one)).toEqual({ allowed: true, retryAfterSeconds: 0 });
      await ctx.advanceSeconds(30);
      expect(await ctx.store.hit(tenant, "sliding", one)).toEqual({ allowed: false, retryAfterSeconds: 30 });
      await ctx.advanceSeconds(29);
      expect(await ctx.store.hit(tenant, "sliding", one)).toEqual({ allowed: false, retryAfterSeconds: 1 });
      await ctx.advanceSeconds(1);
      expect(await ctx.store.hit(tenant, "sliding", one)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    },
  },
  {
    name: "reports retry-after as the whole seconds left, rounded UP",
    async run(ctx) {
      const tenant = scope();
      expect(await ctx.store.hit(tenant, "retry", one)).toEqual({ allowed: true, retryAfterSeconds: 0 });
      await ctx.advanceSeconds(29.75);
      expect(await ctx.store.hit(tenant, "retry", one)).toEqual({ allowed: false, retryAfterSeconds: 31 });
      await ctx.advanceSeconds(0.25);
      expect(await ctx.store.hit(tenant, "retry", one)).toEqual({ allowed: false, retryAfterSeconds: 30 });
      await ctx.advanceSeconds(29.5);
      expect(await ctx.store.hit(tenant, "retry", one)).toEqual({ allowed: false, retryAfterSeconds: 1 });
      await ctx.advanceSeconds(0.5);
      expect(await ctx.store.hit(tenant, "retry", one)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    },
  },
  {
    name: "isolates tenant counts, buckets, and caller-supplied tenant text",
    async run(ctx) {
      const a = scope(); const b = scope();
      const key = `user:${b.tenantId}:cap:echo`;
      expect((await ctx.store.hit(a, key, one)).allowed).toBe(true);
      expect((await ctx.store.hit(a, key, one)).allowed).toBe(false);
      expect((await ctx.store.hit(b, key, one)).allowed).toBe(true);
      expect((await ctx.store.hit(a, `${key}:other`, one)).allowed).toBe(true);
      // The tenant JSON inside a key is only text: it neither joins nor splits counters.
      const embedded = JSON.stringify({ tenantId: b.tenantId, key: "k" });
      expect((await ctx.store.hit(a, embedded, one)).allowed).toBe(true);
      expect((await ctx.store.hit(b, embedded, one)).allowed).toBe(true);
      expect((await ctx.store.hit(a, embedded, one)).allowed).toBe(false);
    },
  },
  {
    name: "blocks only the scoped key, expires at the boundary, and cannot be shortened",
    async run(ctx) {
      const a = scope(); const b = scope();
      expect(await ctx.store.isBlocked(a, "deny")).toBe(false);
      await ctx.store.block(a, "deny", 10);
      expect(await ctx.store.isBlocked(a, "deny")).toBe(true);
      expect(await ctx.store.isBlocked(b, "deny")).toBe(false);
      expect(await ctx.store.isBlocked(a, "other")).toBe(false);
      await ctx.advanceSeconds(5);
      await ctx.store.block(a, "deny", 1);
      await ctx.advanceSeconds(4);
      expect(await ctx.store.isBlocked(a, "deny")).toBe(true);
      await ctx.advanceSeconds(1);
      expect(await ctx.store.isBlocked(a, "deny")).toBe(false);
    },
  },
  {
    name: "concurrent blocks preserve the longest expiry and can extend a live block",
    async run(ctx) {
      const tenant = scope();
      await Promise.all([30, 5, 20, 1].map((seconds) => ctx.store.block(tenant, "deny", seconds)));
      await ctx.advanceSeconds(29);
      expect(await ctx.store.isBlocked(tenant, "deny")).toBe(true);
      await ctx.store.block(tenant, "deny", 10);
      await ctx.advanceSeconds(1);
      expect(await ctx.store.isBlocked(tenant, "deny")).toBe(true);
      await ctx.advanceSeconds(9);
      expect(await ctx.store.isBlocked(tenant, "deny")).toBe(false);
    },
  },
  {
    name: "keeps a counter and a block with the same bucket key independent of each other",
    async run(ctx) {
      const tenant = scope();
      await ctx.store.block(tenant, "same", 60);
      expect(await ctx.store.hit(tenant, "same", one)).toEqual({ allowed: true, retryAfterSeconds: 0 });
      expect((await ctx.store.hit(tenant, "same", one)).allowed).toBe(false);
      expect(await ctx.store.isBlocked(tenant, "same")).toBe(true);
      // An exhausted counter alone is not a block.
      expect((await ctx.store.hit(tenant, "counted", one)).allowed).toBe(true);
      expect((await ctx.store.hit(tenant, "counted", one)).allowed).toBe(false);
      expect(await ctx.store.isBlocked(tenant, "counted")).toBe(false);
    },
  },
  {
    name: "canonicalizes UUID case for both counters and blocks",
    async run(ctx) {
      const tenant = scope(); const upper = { tenantId: tenant.tenantId.toUpperCase() as TenantId };
      expect((await ctx.store.hit(tenant, "case", one)).allowed).toBe(true);
      expect((await ctx.store.hit(upper, "case", one)).allowed).toBe(false);
      await ctx.store.block(tenant, "case", 10);
      expect(await ctx.store.isBlocked(upper, "case")).toBe(true);
      await ctx.store.block(upper, "case-2", 10);
      expect(await ctx.store.isBlocked(tenant, "case-2")).toBe(true);
    },
  },
  {
    name: "rejects changing rules inside a live window instead of resetting the counter",
    async run(ctx) {
      const tenant = scope();
      await ctx.store.hit(tenant, "rule", rule);
      // A shorter rule now uses a DIFFERENT primary-key window; an upsert guard alone cannot reject it.
      await ctx.advanceSeconds(30);
      for (const changed of [{ limit: 100, windowSeconds: 60 }, { limit: 20, windowSeconds: 1 }]) {
        await expect(ctx.store.hit(tenant, "rule", changed)).rejects.toThrow();
      }
      // The refused attempts consumed nothing: 18 more hits fit in the original rule, the 20th overall is the last.
      for (let hit = 2; hit <= 20; hit++) expect((await ctx.store.hit(tenant, "rule", rule)).allowed, `hit ${hit}`).toBe(true);
      expect((await ctx.store.hit(tenant, "rule", rule)).allowed).toBe(false);
    },
  },
  {
    name: "rejects invalid scope/key/rule/block duration without consuming a valid hit",
    async run(ctx) {
      const tenant = scope();
      for (const value of [0, -1, NaN, Infinity, 1.5, undefined, "1"]) {
        await expect(ctx.store.hit(tenant, "invalid", { limit: value, windowSeconds: 60 } as RateLimitRule)).rejects.toThrow();
        await expect(ctx.store.hit(tenant, "invalid", { limit: 1, windowSeconds: value } as RateLimitRule)).rejects.toThrow();
        await expect(ctx.store.block(tenant, "invalid", value as number)).rejects.toThrow();
      }
      for (const invalid of [undefined, null, {}, { tenantId: "other" }]) {
        await expect(ctx.store.hit(invalid as TenantScope, "invalid", rule)).rejects.toThrow();
        await expect(ctx.store.block(invalid as TenantScope, "invalid", 10)).rejects.toThrow();
        await expect(ctx.store.isBlocked(invalid as TenantScope, "invalid")).rejects.toThrow();
      }
      for (const key of ["", "nul\u0000key", "x".repeat(1025), undefined, 1]) {
        await expect(ctx.store.hit(tenant, key as string, rule)).rejects.toThrow();
        await expect(ctx.store.block(tenant, key as string, 10)).rejects.toThrow();
        await expect(ctx.store.isBlocked(tenant, key as string)).rejects.toThrow();
      }
      expect(await ctx.store.hit(tenant, "invalid", { limit: 1, windowSeconds: 60 })).toEqual({ allowed: true, retryAfterSeconds: 0 });
      expect(await ctx.store.isBlocked(tenant, "invalid")).toBe(false);
    },
  },
  {
    name: "rejects a malformed tenant id in every spelling the database would normalize",
    async run(ctx) {
      const id = scope().tenantId;
      const spellings = [`{${id}}`, id.replaceAll("-", ""), ` ${id}`, `${id} `, `${id}\n`, `urn:uuid:${id}`, id.slice(0, 35), `${id}0`];
      for (const tenantId of spellings) {
        const bad = { tenantId: tenantId as TenantId };
        await expect(ctx.store.hit(bad, "spelling", one)).rejects.toThrow();
        await expect(ctx.store.block(bad, "spelling", 10)).rejects.toThrow();
        await expect(ctx.store.isBlocked(bad, "spelling")).rejects.toThrow();
      }
      expect(await ctx.store.hit({ tenantId: id }, "spelling", one)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    },
  },
  {
    name: "bounds keys at exactly 1024 UTF-8 bytes and refuses ill-formed Unicode, for hits, blocks and reads",
    async run(ctx) {
      const tenant = scope();
      expect((await ctx.store.hit(tenant, BYTES_1024, one)).allowed).toBe(true);
      expect((await ctx.store.hit(tenant, BYTES_1024, one)).allowed).toBe(false);
      expect((await ctx.store.hit(tenant, "界".repeat(341), one)).allowed).toBe(true);
      await ctx.store.block(tenant, BYTES_1024, 10);
      expect(await ctx.store.isBlocked(tenant, BYTES_1024)).toBe(true);
      for (const key of ["界".repeat(342), `${"k".repeat(1023)}é`, `${BYTES_1024}k`, "\ud800", "a\udc00b"]) {
        await expect(ctx.store.hit(tenant, key, one), key.slice(0, 4)).rejects.toThrow();
        await expect(ctx.store.block(tenant, key, 10), key.slice(0, 4)).rejects.toThrow();
        await expect(ctx.store.isBlocked(tenant, key), key.slice(0, 4)).rejects.toThrow();
      }
      // Two different emoji are two different buckets, never one lossy U+FFFD bucket.
      expect((await ctx.store.hit(tenant, "😀", one)).allowed).toBe(true);
      expect((await ctx.store.hit(tenant, "😁", one)).allowed).toBe(true);
    },
  },
];

export function runRateLimiterConformance(makeStore: () => Promise<RateLimiterTestContext>): void {
  describe("RateLimiter conformance", () => {
    let ctx: RateLimiterTestContext;
    beforeEach(async () => { ctx = await makeStore(); });
    afterEach(async () => { await ctx?.dispose?.(); });
    for (const conformanceCase of rateLimiterConformanceCases) it(conformanceCase.name, () => conformanceCase.run(ctx), conformanceCase.timeoutMs);
  });
}
