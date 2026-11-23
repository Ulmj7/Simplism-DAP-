import { describe, expect, it } from "vitest";
import { mintAuthorizationContext } from "@dap/contracts/mint";
import { contextViolations } from "./positive-controls.js";

const session = (sessionId: string) => mintAuthorizationContext({ userId: "alice", tenantId: "00000000-0000-4000-8000-000000000001", sessionId, authenticatedAt: "2026-01-01T00:00:00Z", validUntil: "2026-01-01T01:00:00Z" });

describe("the ATK-PRIV-04 oracle", () => {
  it("reports another session of the same user, even when user and tenant match", () => {
    expect(contextViolations(session("other"), session("mine"), 0)).toContain("the executor's identity differs from the requesting user's");
  });
  it("accepts the very same context object", () => {
    const mine = session("mine");
    expect(contextViolations(mine, mine, 0)).toEqual([]);
  });
});
