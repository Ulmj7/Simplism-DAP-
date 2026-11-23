import { describe, expect, it, vi } from "vitest";
import { createAuthorizeStage } from "./authorize.js";
import { context, dependencies, input, run } from "../fixtures.test-support.js";
import type { PipelineRecord } from "../pipeline.js";
import type { LimitVerdict } from "../../limits/limiter.js";

function fixture() {
  const { deps } = dependencies(); const entry = deps.registry.get("viewProject")!;
  const checkCapability = vi.fn(async (): Promise<LimitVerdict> => ({ allowed: true }));
  const recordDenial = vi.fn(async () => ({ recorded: true as const, throttled: false }));
  const has = vi.fn(async () => true);
  const stage = createAuthorizeStage({ registry: deps.registry, permissions: { has }, resources: deps.hooks.resources, pages: deps.hooks.pages, clock: deps.clock, limiter: { checkCapability, recordDenial } });
  const request: PipelineRecord = { ...input(), context: context(), run, facts: { resolve: { id: "viewProject", version: 1, risk: "SAFE", definitionHash: entry.definitionHash }, validate: { resource: null } }, budget: { remainingMs: () => 10000 } };
  return { stage, request, checkCapability, recordDenial, has };
}
describe("T117 authorize capability limits", () => {
  it("checks the proven action/risk and requesting identity after permission/resource authorization", async () => {
    const test = fixture();
    test.request = { ...test.request, facts: { ...test.request.facts, resolve: { ...(test.request.facts.resolve as object), risk: "CRITICAL" } } };
    expect(await test.stage(test.request)).toEqual({ kind: "continue", data: { resource: null } });
    expect(test.checkCapability).toHaveBeenCalledExactlyOnceWith({ scope: test.request.context, userId: "alice", actionId: "viewProject", risk: "SAFE" });
    expect(test.has.mock.invocationCallOrder[0]).toBeLessThan(test.checkCapability.mock.invocationCallOrder[0]!);
    expect(test.recordDenial).not.toHaveBeenCalled();
  });
  it("denies capability/risk limits and records only a countable verdict", async () => {
    for (const reason of ["rate_limited_capability", "rate_limited_risk"] as const) {
      const test = fixture();
      test.checkCapability.mockResolvedValue({ allowed: false, outcome: "DENIED", reason, limit: "capability", retryAfterSeconds: 60, countsTowardThrottle: true });
      expect(await test.stage(test.request)).toMatchObject({ decision: { stage: "authorize", reason } });
      expect(test.recordDenial).toHaveBeenCalledTimes(1);
    }
  });
  it("does not spend capability quota on a permission denial; failures/capacity are dependency failures", async () => {
    const test = fixture(); test.has.mockResolvedValue(false);
    expect(await test.stage(test.request)).toMatchObject({ decision: { reason: "permission_missing" } });
    expect(test.checkCapability).not.toHaveBeenCalled(); expect(test.recordDenial).not.toHaveBeenCalled();
    const broken = fixture(); broken.checkCapability.mockRejectedValue(new Error("capacity exhausted"));
    expect(await broken.stage(broken.request)).toMatchObject({ decision: { reason: "dependency_failure" } });
    expect(broken.recordDenial).not.toHaveBeenCalled();
  });
});
