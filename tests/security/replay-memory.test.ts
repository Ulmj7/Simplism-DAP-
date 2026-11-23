import { describe, expect, it } from "vitest";
import { InMemoryReplayGuard } from "@dap/security";
import { FakeClock, TENANT_A } from "@dap/testkit";
import { runReplayConformance } from "../../packages/security/src/state/conformance/replay.conformance.js";

const scope = { tenantId: TENANT_A };
runReplayConformance(async () => {
  const clock = new FakeClock();
  return { store: new InMemoryReplayGuard(clock), advanceSeconds: async (seconds) => { clock.advance(seconds); } };
});
describe("bounded memory replay", () => {
  it("rejects new claims at capacity without evicting live claims, then purges expired claims", async () => {
    const clock = new FakeClock(); const store = new InMemoryReplayGuard(clock, { maxEntries: 2 });
    expect(await store.claim(scope, "a", 10)).toBe("claimed");
    expect(await store.claim(scope, "b", 20)).toBe("claimed");
    await expect(store.claim(scope, "c", 20)).rejects.toThrow("capacity");
    expect(await store.claim(scope, "a", 10)).toBe("duplicate");
    clock.advance(10);
    expect(await store.claim(scope, "c", 20)).toBe("claimed");
    expect(await store.claim(scope, "b", 20)).toBe("duplicate");
  });
  it("cannot accumulate expired entries over many distinct keys", async () => {
    const clock = new FakeClock(); const store = new InMemoryReplayGuard(clock, { maxEntries: 1 });
    for (let index = 0; index < 20; index++) {
      expect(await store.claim(scope, `call:${index}`, 1)).toBe("claimed");
      clock.advance(1);
    }
  });
  it("fails closed for invalid or backwards store clock", async () => {
    const clock = new FakeClock(); let now = clock.now();
    const store = new InMemoryReplayGuard({ now: () => now });
    await store.claim(scope, "valid", 60);
    now = "invalid" as typeof now;
    await expect(store.claim(scope, "invalid", 60)).rejects.toThrow();
    now = "2025-01-01T00:00:00Z" as typeof now;
    await expect(store.claim(scope, "backwards", 60)).rejects.toThrow();
  });
  it("captures a tenant getter once and bounds UTF-8 key bytes", async () => {
    let reads = 0;
    const store = new InMemoryReplayGuard(new FakeClock());
    expect(await store.claim({ get tenantId() { reads++; return TENANT_A; } }, "once", 60)).toBe("claimed");
    expect(reads).toBe(1);
    await expect(store.claim(scope, "界".repeat(400), 60)).rejects.toThrow();
  });
  it.each([0, -1, NaN, Infinity, 1.5, 1000001])("rejects invalid capacity %s", (maxEntries) => {
    expect(() => new InMemoryReplayGuard(new FakeClock(), { maxEntries })).toThrow();
  });
});
