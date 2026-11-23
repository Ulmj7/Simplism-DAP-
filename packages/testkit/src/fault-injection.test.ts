import { describe, expect, it } from "vitest";
import type { PermissionChecker } from "@dap/contracts";
import { mintAuthorizationContext } from "@dap/contracts/mint";
import type { AuthenticatedPrincipal } from "@dap/contracts";
import type { FaultMode } from "./fault-injection.js";
import { FAULT_CANARY, faulty } from "./fault-injection.js";

// T032: faulty(port, mode) returns a plain object (no Proxy) with the same method names,
// where EVERY method misbehaves per mode.

const SENTINEL = Symbol("sentinel");
const PRINCIPAL: AuthenticatedPrincipal = {
  userId: "user-alice",
  tenantId: "11111111-1111-4111-8111-111111111111",
  sessionId: "sess-1",
  authenticatedAt: "2026-01-01T00:00:00.000Z",
  validUntil: "2026-01-01T00:10:00.000Z",
};

function healthyPort(): PermissionChecker {
  return {
    async has() {
      return true;
    },
  };
}

describe("faulty", () => {
  it("exposes the same method names as the port and nothing else", () => {
    const port = { ping: () => true, check: async () => false } as object;
    const wrapped = faulty(port, "throws");
    expect(Object.keys(wrapped)).toEqual(["ping", "check"]);
  });

  it("throws mode: every method throws an Error whose message contains the canary", () => {
    const ctx = mintAuthorizationContext(PRINCIPAL);
    const wrapped = faulty(healthyPort(), "throws") as PermissionChecker;
    expect(() => wrapped.has(ctx, "p" as never)).toThrow(Error);
    expect(() => wrapped.has(ctx, "p" as never)).toThrow(FAULT_CANARY);
  });

  it("hangs mode: every method returns a promise that never resolves", async () => {
    const ctx = mintAuthorizationContext(PRINCIPAL);
    const wrapped = faulty(healthyPort(), "hangs") as PermissionChecker;
    const never = wrapped.has(ctx, "p" as never);
    // Do NOT await it: race against an already-resolved sentinel.
    await expect(Promise.race([never, Promise.resolve(SENTINEL)])).resolves.toBe(SENTINEL);
  });

  it("undefined mode: every method returns undefined", async () => {
    const ctx = mintAuthorizationContext(PRINCIPAL);
    const wrapped = faulty(healthyPort(), "undefined") as unknown as Record<string, (...a: unknown[]) => unknown>;
    expect(wrapped["has"]!(ctx, "p")).toBeUndefined();
  });

  it("wrong-type mode returns a deterministic invalid value regardless of method name or async shape", async () => {
    const port = {
      syncThing: () => 1,
      asyncThingAsync: async () => 2,
      has: async () => true,
    };
    const wrapped = faulty(port, "wrong-type") as unknown as Record<string, (...a: unknown[]) => unknown>;
    expect(wrapped["syncThing"]!()).toBe("yes");
    expect(await wrapped["asyncThingAsync"]!()).toBe("yes");
    expect(await wrapped["has"]!()).toBe("yes");
  });

  it("rejects unknown modes", () => {
    expect(() => faulty({ a: () => 1 }, "explode" as FaultMode)).toThrow(RangeError);
  });
});
