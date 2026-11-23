import { describe, expect, it } from "vitest";
import {
  OUTCOMES,
  RISK_LEVELS,
  defineAction,
  defineExecutor,
  ExecutionGuardError,
} from "./index.js";

// T018: the barrel exposes every contract module except the minting runtime, and the
// mint runtime is reachable ONLY through the `@dap/contracts/mint` subpath.

describe("@dap/contracts barrel", () => {
  it("exposes the runtime helpers", () => {
    expect(typeof defineExecutor).toBe("function");
    expect(typeof defineAction).toBe("function");
    expect(typeof ExecutionGuardError).toBe("function");
  });

  it("exposes the shared vocabulary", () => {
    expect(RISK_LEVELS).toContain("FORBIDDEN");
    expect(OUTCOMES).toContain("ALLOWED");
  });

  it("does NOT re-export the minting runtime from the root (ATK-ARCH-05)", async () => {
    const mod = (await import("./index.js")) as Record<string, unknown>;
    expect(mod.mintAuthorizationContext).toBeUndefined();
    expect(mod.isMintedContext).toBeUndefined();
    expect(mod.mintExecutionGrant).toBeUndefined();
    expect(mod.consumeExecutionGrant).toBeUndefined();
    // The internal registry helpers are not leaked either.
    expect(mod.registerGrant).toBeUndefined();
    expect(mod.grantRecord).toBeUndefined();
  });
});
