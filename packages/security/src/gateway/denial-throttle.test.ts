import { describe, expect, it, vi } from "vitest";
import type { PolicyDecision, ReasonCode } from "@dap/contracts";
import { recordFinalDenial } from "./denial-throttle.js";
import { input } from "./fixtures.test-support.js";
import { denyDecision } from "./decision.js";

const denial = (reason: ReasonCode, outcome: "DENIED" | "INVALID_ACTION" | "UNAUTHORIZED" = "DENIED") => ({ ...denyDecision({ decisionId: "d", requestId: "r" as never, stage: "resolve", reason }), outcome }) as PolicyDecision;

describe("T117 final denials count toward the throttle", () => {
  it.each(["replayed_request", "unknown_action", "malformed_envelope", "invalid_parameters", "permission_missing", "resource_not_available", "action_not_enabled", "internal_error"] as const)("records a final %s denial once, for the trusted tenant and AI session", async (reason) => {
    const recordDenial = vi.fn(async () => ({ recorded: true as const, throttled: false }));
    const request = input();
    await recordFinalDenial({ recordDenial }, request, denial(reason));
    expect(recordDenial).toHaveBeenCalledTimes(1);
    expect(recordDenial).toHaveBeenCalledWith({ scope: request.context, aiSessionId: "ai-session" });
  });
  it.each([["INVALID_ACTION", "unknown_action"], ["UNAUTHORIZED", "permission_missing"]] as const)("records %s outcomes", async (outcome, reason) => {
    const recordDenial = vi.fn(async () => ({ recorded: true as const, throttled: false }));
    await recordFinalDenial({ recordDenial }, input(), denial(reason, outcome));
    expect(recordDenial).toHaveBeenCalledTimes(1);
  });
  it.each(["rate_limited_turn", "rate_limited_tenant", "rate_limited_user", "rate_limited_capability", "rate_limited_risk", "denial_throttle", "dependency_failure"] as const)("leaves %s to the limit gate (no double count, no round trip for faults and blocks)", async (reason) => {
    const recordDenial = vi.fn(async () => ({ recorded: true as const, throttled: false }));
    await recordFinalDenial({ recordDenial }, input(), denial(reason));
    expect(recordDenial).not.toHaveBeenCalled();
  });
  it("never records allowed or confirmation-gated decisions", async () => {
    const recordDenial = vi.fn(async () => ({ recorded: true as const, throttled: false }));
    const request = input();
    for (const outcome of ["ALLOWED", "REQUIRES_CONFIRMATION"] as const) await recordFinalDenial({ recordDenial }, request, { outcome, decisionId: "d", requestId: request.requestId, reason: outcome === "ALLOWED" ? "allowed" : "confirmation_required" } as unknown as PolicyDecision);
    expect(recordDenial).not.toHaveBeenCalled();
  });
  it("records nothing without a minted context and never throws", async () => {
    const recordDenial = vi.fn(async () => ({ recorded: true as const, throttled: false }));
    await recordFinalDenial({ recordDenial }, { ...input(), context: { tenantId: "00000000-0000-4000-8000-000000000001", userId: "alice" } }, denial("replayed_request"));
    await recordFinalDenial({ recordDenial }, { ...input(), context: null }, denial("replayed_request"));
    expect(recordDenial).not.toHaveBeenCalled();
    const failing = { recordDenial: vi.fn(async () => { throw new Error("down"); }) };
    await expect(recordFinalDenial(failing, input(), denial("replayed_request"))).resolves.toBeUndefined();
    expect(failing.recordDenial).toHaveBeenCalledTimes(1);
    await expect(recordFinalDenial({ recordDenial }, { ...input(), run: null }, denial("replayed_request"))).resolves.toBeUndefined();
  });
});
