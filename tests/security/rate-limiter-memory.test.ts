import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "@dap/security";
import { FakeClock, TENANT_A } from "@dap/testkit";
import { runRateLimiterConformance } from "../../packages/security/src/state/conformance/rate-limiter.conformance.js";

const scope = { tenantId: TENANT_A };
const rule = { limit: 1, windowSeconds: 60 };
runRateLimiterConformance(async () => {
  const clock = new FakeClock();
  return { store: new InMemoryRateLimiter(clock), advanceSeconds: async (seconds) => { clock.advance(seconds); } };
});
describe("bounded memory rate limiter", () => {
  it("shares the cap across counters and blocks, without evicting live security state", async () => {
    const clock = new FakeClock(); const store = new InMemoryRateLimiter(clock, { maxEntries: 2 });
    expect((await store.hit(scope, "a", rule)).allowed).toBe(true);
    await store.block(scope, "b", 10);
    await expect(store.hit(scope, "c", rule)).rejects.toThrow("capacity");
    await expect(store.block(scope, "c", 10)).rejects.toThrow("capacity");
    expect((await store.hit(scope, "a", rule)).allowed).toBe(false);
    expect(await store.isBlocked(scope, "b")).toBe(true);
    clock.advance(10);
    expect((await store.hit(scope, "c", rule)).allowed).toBe(true);
    expect((await store.hit(scope, "a", rule)).allowed).toBe(false);
  });
  it("purges expired counters and block rows without accumulating distinct keys", async () => {
    const clock = new FakeClock(); const store = new InMemoryRateLimiter(clock, { maxEntries: 2 });
    for (let index = 0; index < 20; index++) {
      expect((await store.hit(scope, `counter:${index}`, { limit: 1, windowSeconds: 1 })).allowed).toBe(true);
      await store.block(scope, `block:${index}`, 1);
      expect(await store.isBlocked(scope, `block:${index}`)).toBe(true);
      clock.advance(1);
    }
  });
  it("keeps counters and blocks distinct even with identical bucket keys", async () => {
    const store = new InMemoryRateLimiter(new FakeClock());
    await store.block(scope, "same", 60);
    expect((await store.hit(scope, "same", rule)).allowed).toBe(true);
    expect((await store.hit(scope, "same", rule)).allowed).toBe(false);
    expect(await store.isBlocked(scope, "same")).toBe(true);
  });
  it("snapshots rule getters once and never resets from caller mutation", async () => {
    let limitReads = 0; let windowReads = 0;
    const store = new InMemoryRateLimiter(new FakeClock());
    const hostile = { get limit() { limitReads++; return 1; }, get windowSeconds() { windowReads++; return 60; } };
    expect((await store.hit(scope, "once", hostile)).allowed).toBe(true);
    expect(limitReads).toBe(1); expect(windowReads).toBe(1);
    expect((await store.hit(scope, "once", rule)).allowed).toBe(false);
  });
  it("fails closed on invalid/backwards clocks for reads and mutations", async () => {
    const clock = new FakeClock(); let now = clock.now();
    const store = new InMemoryRateLimiter({ now: () => now });
    await store.block(scope, "clock", 60);
    now = "bad" as typeof now;
    await expect(store.isBlocked(scope, "clock")).rejects.toThrow();
    await expect(store.hit(scope, "clock", rule)).rejects.toThrow();
    await expect(store.block(scope, "clock", 60)).rejects.toThrow();
    now = "2025-01-01T00:00:00Z" as typeof now;
    await expect(store.isBlocked(scope, "clock")).rejects.toThrow();
  });
});
