/**
 * The in-memory adapters are DEV/TEST ONLY because their capacity is one process-wide budget. This pins the documented
 * behaviour so nobody mistakes it for isolation: a full store refuses every NEW key for every tenant (fail closed),
 * never evicts a live entry, and keeps serving the keys it already holds.
 */
import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter, InMemoryReplayGuard } from "@dap/security";
import { FakeClock, TENANT_A, TENANT_B } from "@dap/testkit";

const a = { tenantId: TENANT_A };
const b = { tenantId: TENANT_B };
const one = { limit: 1, windowSeconds: 60 };

describe("a full in-memory store fails closed for every tenant", () => {
  it("replay guard: tenant A fills the cap, tenant B's new claim is refused, existing claims stay duplicates", async () => {
    const guard = new InMemoryReplayGuard(new FakeClock(), { maxEntries: 3 });
    for (const key of ["a1", "a2", "a3"]) expect(await guard.claim(a, key, 86_400)).toBe("claimed");
    await expect(guard.claim(b, "b1", 86_400)).rejects.toThrow("capacity");
    await expect(guard.claim(a, "a4", 86_400)).rejects.toThrow("capacity");
    for (const key of ["a1", "a2", "a3"]) expect(await guard.claim(a, key, 86_400)).toBe("duplicate");
  });
  it("rate limiter: counters and blocks share the cap; a refused key creates nothing and a live entry is never evicted", async () => {
    const limiter = new InMemoryRateLimiter(new FakeClock(), { maxEntries: 2 });
    expect((await limiter.hit(a, "x", one)).allowed).toBe(true);
    await limiter.block(a, "y", 60);
    await expect(limiter.hit(b, "z", one)).rejects.toThrow("capacity");
    await expect(limiter.block(b, "z", 60)).rejects.toThrow("capacity");
    expect((await limiter.hit(a, "x", one)).allowed).toBe(false);
    expect(await limiter.isBlocked(a, "y")).toBe(true);
    expect(await limiter.isBlocked(b, "z")).toBe(false);
  });
  it("frees capacity only when entries expire", async () => {
    const clock = new FakeClock();
    const guard = new InMemoryReplayGuard(clock, { maxEntries: 1 });
    expect(await guard.claim(a, "k", 10)).toBe("claimed");
    await expect(guard.claim(b, "k", 10)).rejects.toThrow("capacity");
    clock.advance(10);
    expect(await guard.claim(b, "k", 10)).toBe("claimed");
  });
});
