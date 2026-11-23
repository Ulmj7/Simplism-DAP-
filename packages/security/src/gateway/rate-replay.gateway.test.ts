import { describe, expect, it } from "vitest";
import { InMemoryReplayGuard } from "../state/memory/replay.js";
import { InMemoryRateLimiter } from "../state/memory/rate-limiter.js";
import { composeStages, createPolicyGateway } from "./create-gateway.js";
import { createPipeline } from "./pipeline.js";
import { context, dependencies, input, now, run } from "./fixtures.test-support.js";

function world() {
  const { deps, calls } = dependencies(); const clock = { now: () => now };
  let checks = 0;
  const replay = new InMemoryReplayGuard(clock);
  const wired = { ...deps, state: { ...deps.state, replay, rateLimiter: new InMemoryRateLimiter(clock) }, hooks: { ...deps.hooks, permissions: { has: async () => { checks++; return true; } } } };
  const stages = composeStages(wired);
  return { wired, calls, stages, checks: () => checks };
}
describe("T117 real composed stages", () => {
  it("reaches audit through real rate/replay, authorize, risk and confirmation, and still fails closed there (the fixture's audit sink is unavailable)", async () => {
    const w = world(); const decision = await createPipeline(w.stages).run(input());
    expect(decision).toMatchObject({ outcome: "DENIED", reason: "audit_unavailable", stage: "audit" });
    expect(w.checks()).toBe(1); expect(w.calls()).toBe(0);
    expect(Object.keys(w.stages).sort()).toEqual(["audit", "authorize", "confirmation", "context", "execute", "intake", "rate_limit", "replay", "resolve", "risk", "validate"]);
    expect(await createPolicyGateway(w.wired).proposals.forSession(context(), run).submit({ callId: "other", raw: { action: "viewProject", params: {} } })).toEqual({ outcome: "DENIED", category: "try_later" });
    expect(w.calls()).toBe(0);
  });
  it("consumes the claim before schema validation and never releases it after a denial", async () => {
    const w = world(); const pipeline = createPipeline(w.stages);
    const invalid = { ...input(), readProposal: () => ({ callId: "same", raw: { action: "viewProject", params: { unexpected: 1 } } }) };
    expect(await pipeline.run(invalid)).toMatchObject({ stage: "validate", outcome: "INVALID_PARAMETERS" });
    const corrected = { ...input(), readProposal: () => ({ callId: "same", raw: { action: "viewProject", params: {} } }) };
    expect(await pipeline.run(corrected)).toMatchObject({ stage: "replay", reason: "replayed_request" });
    expect(w.checks()).toBe(0); expect(w.calls()).toBe(0);
  });
});
