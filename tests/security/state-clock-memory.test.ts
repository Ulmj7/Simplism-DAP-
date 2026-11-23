/**
 * The in-memory replay guard and rate limiter trust ONE thing they cannot check themselves: the clock. A clock string
 * that Date.parse accepts but that is not a strict ISO-8601 instant with an offset ("2026-02-30", "24:00", no zone,
 * "1") would silently move every expiry, so it must fail closed, and a failed read must never half-apply a change.
 */
import { describe, expect, it } from "vitest";
import type { Clock, TenantScope } from "@dap/contracts";
import { InMemoryRateLimiter, InMemoryReplayGuard } from "@dap/security";
import { FakeClock, TENANT_A, TENANT_B } from "@dap/testkit";
import { BoundedState, stateKey } from "../../packages/security/src/state/memory/bounded-state.js";

const scope: TenantScope = { tenantId: TENANT_A };
const one = { limit: 1, windowSeconds: 60 };
const clockOf = (read: () => unknown): Clock => ({ now: read as Clock["now"] });
const LOOSE_BUT_PARSEABLE = [
  "2026-01-01T00:00:00", "2026-01-01", "2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:00:00+0100", "1",
  "Jan 1, 2026 00:00:00 GMT", "Thu, 01 Jan 2026 00:00:00 GMT", "2026-01-01 00:00:00Z", "+002026-01-01T00:00:00Z",
];
const UNUSABLE = [...LOOSE_BUT_PARSEABLE, "", "bad", " 2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z\n", "2026-01-01T00:00:60Z", "2026-01-01T00:00:00+99:99", undefined, null, 0, 1767225600000, new Date(0), {}, ["2026-01-01T00:00:00Z"]];

describe.each([
  ["replay guard", (clock: Clock) => (key: string) => new InMemoryReplayGuard(clock).claim(scope, key, 60)],
  ["rate limiter hit", (clock: Clock) => (key: string) => new InMemoryRateLimiter(clock).hit(scope, key, one)],
  ["rate limiter block", (clock: Clock) => (key: string) => new InMemoryRateLimiter(clock).block(scope, key, 60)],
  ["rate limiter read", (clock: Clock) => (key: string) => new InMemoryRateLimiter(clock).isBlocked(scope, key)],
])("%s and the clock", (_name, operation) => {
  it.each(UNUSABLE.map((value) => [JSON.stringify(value) ?? String(value), value] as const))("fails closed on the clock value %s", async (_label, value) => {
    await expect(operation(clockOf(() => value))("k")).rejects.toThrow("clock");
  });
  it("fails closed when reading the clock throws", async () => {
    await expect(operation(clockOf(() => { throw new Error("clock unreachable"); }))("k")).rejects.toThrow();
  });
  it.each(["2026-01-01T00:00:00Z", "2026-01-01T01:00:00+01:00", "2026-01-01T00:00:00.123Z", "2026-01-01T00:00:00.123456789Z", "2026-01-01T00:00:00+14:00", "9999-12-31T23:59:59.999Z"])("accepts the strict instant %s", async (value) => {
    await expect(operation(clockOf(() => value))("k")).resolves.not.toThrow();
  });
});

describe("a clock that cannot be trusted never half-applies a change", () => {
  it("records no claim when the clock read fails, so the same claim still succeeds afterwards", async () => {
    const real = new FakeClock(); let broken = true;
    const guard = new InMemoryReplayGuard(clockOf(() => (broken ? "2026-02-30T00:00:00Z" : real.now())));
    await expect(guard.claim(scope, "call", 60)).rejects.toThrow();
    broken = false;
    expect(await guard.claim(scope, "call", 60)).toBe("claimed");
    expect(await guard.claim(scope, "call", 60)).toBe("duplicate");
  });
  it("counts no hit and sets no block when the clock read fails", async () => {
    const real = new FakeClock(); let broken = true;
    const limiter = new InMemoryRateLimiter(clockOf(() => (broken ? "bad" : real.now())));
    await expect(limiter.hit(scope, "k", one)).rejects.toThrow();
    await expect(limiter.block(scope, "k", 60)).rejects.toThrow();
    broken = false;
    expect(await limiter.hit(scope, "k", one)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(await limiter.isBlocked(scope, "k")).toBe(false);
  });
  it("refuses a clock that goes backwards by even one millisecond, and recovers when it catches up", async () => {
    let now = "2026-01-01T00:00:10.000Z";
    const guard = new InMemoryReplayGuard(clockOf(() => now));
    expect(await guard.claim(scope, "a", 60)).toBe("claimed");
    now = "2026-01-01T00:00:09.999Z";
    await expect(guard.claim(scope, "b", 60)).rejects.toThrow("clock");
    await expect(guard.claim(scope, "a", 60)).rejects.toThrow("clock");
    now = "2026-01-01T00:00:10.000Z";
    expect(await guard.claim(scope, "a", 60)).toBe("duplicate");
    expect(await guard.claim(scope, "b", 60)).toBe("claimed");
  });
  it("accepts the same instant read twice, and the same instant spelled with another offset", async () => {
    let now = "2026-01-01T00:00:10Z";
    const guard = new InMemoryReplayGuard(clockOf(() => now));
    await guard.claim(scope, "a", 60);
    expect(await guard.claim(scope, "a", 60)).toBe("duplicate");
    now = "2026-01-01T01:00:10+01:00";
    expect(await guard.claim(scope, "a", 60)).toBe("duplicate");
  });
  it("keeps full retention at the largest representable instant", async () => {
    let now = "9999-12-31T23:59:59.999Z";
    const guard = new InMemoryReplayGuard(clockOf(() => now));
    expect(await guard.claim(scope, "far", 31_536_000)).toBe("claimed");
    expect(await guard.claim(scope, "far", 31_536_000)).toBe("duplicate");
    const limiter = new InMemoryRateLimiter(clockOf(() => now));
    expect((await limiter.hit(scope, "far", { limit: 1, windowSeconds: 31_536_000 })).allowed).toBe(true);
    expect((await limiter.hit(scope, "far", { limit: 1, windowSeconds: 31_536_000 })).allowed).toBe(false);
    await limiter.block(scope, "far", 31_536_000);
    expect(await limiter.isBlocked(scope, "far")).toBe(true);
    now = "9999-12-31T23:59:59.999Z";
  });
});

describe("the bounded store's own invariants (defence for any adapter built on it)", () => {
  const store = () => new BoundedState<{ readonly expiresAt: number }>(new FakeClock(), { maxEntries: 2 });
  it.each([NaN, Infinity, -Infinity, 1.5, 2 ** 53, 8.64e15 + 2, -8.64e15 - 2, "7", undefined, null])("refuses an expiry of %s", (expiresAt) => {
    expect(() => store().set("k", { expiresAt: expiresAt as number })).toThrow("expiry");
  });
  it.each([0, 1, 8.64e15, -8.64e15])("accepts the expiry %s", (expiresAt) => {
    expect(() => store().set("k", { expiresAt })).not.toThrow();
  });
  it("refuses a new key at capacity but still updates an existing one", () => {
    const state = store();
    state.set("a", { expiresAt: 10 }); state.set("b", { expiresAt: 10 });
    expect(() => state.set("c", { expiresAt: 10 })).toThrow("capacity");
    expect(() => state.set("a", { expiresAt: 20 })).not.toThrow();
    expect(state.get("a")?.expiresAt).toBe(20);
    expect(state.get("c")).toBeUndefined();
  });
  it("refuses a bad expiry before it can occupy the last slot", () => {
    const state = store();
    state.set("a", { expiresAt: 10 });
    expect(() => state.set("b", { expiresAt: NaN })).toThrow("expiry");
    expect(() => state.set("c", { expiresAt: 10 })).not.toThrow();
  });
});

describe("counters never wrap", () => {
  it("refuses to count past the largest safe integer instead of wrapping to a smaller number", async () => {
    const limiter = new InMemoryRateLimiter(new FakeClock());
    await limiter.hit(scope, "k", one);
    // Reaching 2^53 hits in one window is not possible in practice, so seed the counter directly.
    const state = (limiter as unknown as { state: BoundedState<{ readonly expiresAt: number; readonly count?: number }> }).state;
    const key = `counter:${stateKey(scope, "k")}`;
    state.set(key, { ...state.get(key)!, count: Number.MAX_SAFE_INTEGER });
    await expect(limiter.hit(scope, "k", one)).rejects.toThrow("exhausted");
    expect(state.get(key)?.count).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("state keys", () => {
  it("never lets one tenant's key text select another tenant's state, and is injective over (tenant, key)", () => {
    const a = stateKey({ tenantId: TENANT_A }, "x");
    expect(stateKey({ tenantId: TENANT_B }, "x")).not.toBe(a);
    expect(stateKey({ tenantId: TENANT_A }, `${TENANT_B}:x`)).not.toBe(stateKey({ tenantId: TENANT_B }, "x"));
    expect(stateKey({ tenantId: TENANT_A }, JSON.stringify([TENANT_B, "x"]))).not.toBe(stateKey({ tenantId: TENANT_B }, "x"));
    expect(stateKey({ tenantId: TENANT_A.toUpperCase() as typeof TENANT_A }, "x")).toBe(a);
    expect(stateKey({ tenantId: TENANT_A }, "X")).not.toBe(a);
  });
});
