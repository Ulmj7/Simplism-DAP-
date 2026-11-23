import { describe, expect, it } from "vitest";
import type { ActionId, RequestId, Sha256Hex } from "@dap/contracts";
import { allowedDecision, confirmationDecision, denyDecision } from "./decision.js";

const base = { decisionId: "decision-1", requestId: "request-1" as RequestId };
const action = { ...base, actionId: "testSafeEcho" as ActionId, risk: "SAFE" as const };
describe("typed immutable PolicyDecision builders", () => {
  it("denies by default with only the selected contract fields", () => {
    const decision = denyDecision({ ...base, reason: "unknown_action", stage: "resolve" });
    expect(decision).toEqual({ ...base, outcome: "DENIED", reason: "unknown_action", stage: "resolve" });
    expect(Object.isFrozen(decision)).toBe(true);
  });
  it("requires complete fields for allowed and confirmation decisions", () => {
    expect(allowedDecision({ ...action, paramsDigest: "a".repeat(64) as Sha256Hex }).outcome).toBe("ALLOWED");
    expect(confirmationDecision({ ...action, confirmationId: "00000000-0000-4000-8000-000000000001" as never }).outcome).toBe("REQUIRES_CONFIRMATION");
    expect(() => allowedDecision({ ...action, paramsDigest: "invalid" as Sha256Hex })).toThrow(TypeError);
    expect(() => allowedDecision({ ...action, paramsDigest: "a".repeat(64) as Sha256Hex, risk: "FORBIDDEN" })).toThrow(TypeError);
    expect(() => confirmationDecision({ ...action, confirmationId: "not-a-uuid" as never })).toThrow(TypeError);
  });
  it("snapshots issues and truncates the attempted action at 64 characters", () => {
    const issue = { path: "/name", code: "type" as const };
    const input = { ...base, outcome: "INVALID_PARAMETERS" as const, reason: "invalid_parameters" as const, stage: "validate" as const, issues: [issue], attemptedAction: "x".repeat(100) };
    const decision = denyDecision(input);
    issue.path = "/mutated"; input.issues.length = 0;
    expect(decision.issues).toEqual([{ path: "/name", code: "type" }]);
    expect(decision.attemptedAction).toHaveLength(64);
    expect(Object.isFrozen(decision.issues?.[0])).toBe(true);
  });
  it("captures accessor fields once and rejects extra fields without forwarding their values", () => {
    const reads = new Map<PropertyKey, number>();
    const input = new Proxy({ ...base, reason: "unknown_action" as const, stage: "resolve" as const }, { get(target, key, receiver) {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      if (reads.get(key)! > 1) throw new Error("repeat");
      return Reflect.get(target, key, receiver);
    } });
    expect(denyDecision(input).outcome).toBe("DENIED");
    for (const count of reads.values()) expect(count).toBe(1);
    expect(() => denyDecision({ ...base, reason: "unknown_action", stage: "resolve", secret: "CANARY" } as never)).toThrow("Invalid decision fields");
  });
});
