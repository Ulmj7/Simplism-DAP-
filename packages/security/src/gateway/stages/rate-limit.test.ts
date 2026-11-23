import { describe, expect, it, vi } from "vitest";
import { createLimiter } from "../../limits/limiter.js";
import { DEFAULT_LIMIT_CONFIG } from "../../limits/limit-config.js";
import type { LimitVerdict } from "../../limits/limiter.js";
import type { PipelineRecord } from "../pipeline.js";
import { context, input, run } from "../fixtures.test-support.js";
import { withDeferredLimitDenials } from "./limit-gate.js";
import { createRateLimitStage } from "./rate-limit.js";
import { denyDecision } from "../decision.js";
import { toPlannerFeedback } from "../feedback.js";

const record = (over: Partial<PipelineRecord> = {}): PipelineRecord => ({ ...input(), context: context(), run, facts: { intake: { callId: "trusted" } }, budget: { remainingMs: () => 10000 }, ...over });
const denied = (count = true): LimitVerdict => ({ allowed: false, outcome: "DENIED", reason: "rate_limited_user", limit: "user", retryAfterSeconds: 60, countsTowardThrottle: count });
function fixture(answer: unknown = { allowed: true }) {
  const checkProposal = vi.fn(async () => answer as LimitVerdict);
  const recordDenial = vi.fn(async () => ({ recorded: true as const, throttled: false }));
  const limiter = { checkProposal, recordDenial };
  return { ...limiter, stage: createRateLimitStage(limiter) };
}
describe("T117 stage 2 rate limits", () => {
  it("continues, never ALLOWED, using only minted identity and trusted runner metadata", async () => {
    const test = fixture(); const request = record();
    expect(await test.stage(request)).toEqual({ kind: "continue", data: {} });
    expect(test.checkProposal).toHaveBeenCalledExactlyOnceWith({ scope: request.context, userId: "alice", aiSessionId: run.aiSessionId, turnId: run.turnId, chainDepth: run.depth, turnStartedAt: run.turnStartedAt });
    expect(test.recordDenial).not.toHaveBeenCalled();
  });
  it("returns the exact rate verdict and counts it exactly once only when instructed", async () => {
    for (const count of [false, true]) {
      const test = fixture(denied(count)); const request = record();
      const result = await test.stage(request);
      expect(result).toMatchObject({ kind: "stop", decision: { outcome: "DENIED", reason: "rate_limited_user", stage: "rate_limit" } });
      expect(test.recordDenial).toHaveBeenCalledTimes(count ? 1 : 0);
      if (count) expect(test.recordDenial).toHaveBeenCalledExactlyOnceWith({ scope: request.context, aiSessionId: run.aiSessionId });
      if (result.kind === "stop") expect(toPlannerFeedback(result.decision)).toEqual({ outcome: "DENIED", category: "try_later" });
    }
  });
  it("a denial-recording failure never replaces the rate decision", async () => {
    const test = fixture(denied()); test.recordDenial.mockRejectedValue(new Error("capacity exhausted"));
    expect(await test.stage(record())).toMatchObject({ decision: { reason: "rate_limited_user" } });
  });
  it.each([undefined, null, {}, { allowed: "yes" }, { ...denied(), reason: "allowed" }, { ...denied(), countsTowardThrottle: "yes" }])("malformed verdict %j fails closed", async (answer) => {
    const test = fixture(answer); if (answer === undefined) test.checkProposal.mockResolvedValue(undefined as never);
    expect(await test.stage(record())).toMatchObject({ kind: "stop", decision: { reason: "dependency_failure" } });
    expect(test.recordDenial).not.toHaveBeenCalled();
  });
  it("throws/capacity errors and forged context fail closed without throttling", async () => {
    const test = fixture(); test.checkProposal.mockRejectedValue(new Error("capacity exhausted"));
    expect(await test.stage(record())).toMatchObject({ decision: { reason: "dependency_failure" } });
    test.checkProposal.mockClear();
    expect(await test.stage(record({ context: { ...context() } }))).toMatchObject({ decision: { reason: "dependency_failure" } });
    expect(test.checkProposal).not.toHaveBeenCalled();
  });
  it("missing, exhausted or unreadable runner budget fails before invoking the limiter", async () => {
    for (const budget of [{ remainingMs: () => 0 }, { remainingMs: () => NaN }, { remainingMs: () => { throw new Error("clock"); } }, {}]) {
      const test = fixture();
      expect(await test.stage(record({ budget: budget as never }))).toMatchObject({ decision: { reason: "dependency_failure" } });
      expect(test.checkProposal).not.toHaveBeenCalled(); expect(test.recordDenial).not.toHaveBeenCalled();
    }
  });
  it("a hung limiter and a hung denial recorder are bounded by deterministic timers", async () => {
    vi.useFakeTimers();
    try {
      const test = fixture(); test.checkProposal.mockImplementation(() => new Promise(() => {}));
      const pending = test.stage(record({ budget: { remainingMs: () => 2000 } })); await vi.advanceTimersByTimeAsync(2000);
      expect(await pending).toMatchObject({ decision: { reason: "dependency_failure" } });
      const rate = fixture(denied()); rate.recordDenial.mockImplementation(() => new Promise(() => {}));
      const other = rate.stage(record()); await vi.advanceTimersByTimeAsync(4000);
      expect(await other).toMatchObject({ decision: { reason: "rate_limited_user" } });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("healthy sequential store calls may use the aggregate proposal budget", async () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      const pause = async (name: string) => { seen.push(name); await new Promise((resolve) => setTimeout(resolve, 600)); };
      const limiter = createLimiter({ config: DEFAULT_LIMIT_CONFIG, clock: { now: () => run.turnStartedAt }, rateLimiter: {
        async isBlocked() { await pause("blocked"); return false; },
        async hit() { await pause("hit"); return { allowed: true, retryAfterSeconds: 0 }; }, async block() {},
      } });
      const pending = createRateLimitStage(limiter)(record());
      await vi.advanceTimersByTimeAsync(2400);
      expect(await pending).toEqual({ kind: "continue", data: {} });
      expect(seen).toEqual(["blocked", "hit", "hit", "hit"]);
    } finally { vi.useRealTimers(); }
  });
  it("finalizes denial recording outside the pipeline deadline and preserves the rate reason", async () => {
    vi.useFakeTimers();
    try {
      const test = fixture(denied());
      let decisionMade = false;
      const recordingSawFinal: boolean[] = [];
      test.recordDenial.mockImplementation(() => { recordingSawFinal.push(decisionMade); return new Promise(() => {}); });
      const pending = withDeferredLimitDenials(async () => {
        const result = await test.stage(record({ budget: { remainingMs: () => decisionMade ? 0 : 40 } }));
        if (result.kind !== "stop") throw new Error("Expected rate denial");
        decisionMade = true;
        return result.decision;
      });
      await vi.advanceTimersByTimeAsync(4000);
      expect(await pending).toMatchObject({ reason: "rate_limited_user" });
      expect(decisionMade).toBe(true); expect(test.recordDenial).toHaveBeenCalledTimes(1);
      expect(recordingSawFinal).toEqual([true]);
    } finally { vi.useRealTimers(); }
  });

  it("a countable final denial gets a real recording budget when less than one millisecond remains", async () => {
    vi.useFakeTimers();
    try {
      const test = fixture(denied()); let reads = 0; let returned = false;
      test.recordDenial.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return { recorded: true, throttled: false }; });
      const pending = withDeferredLimitDenials(async () => {
        const result = await test.stage(record({ budget: { remainingMs: () => ++reads === 1 ? 100 : 0.5 } }));
        if (result.kind !== "stop") throw new Error("Expected denial");
        return result.decision;
      }).then((decision) => { returned = true; return decision; });
      await vi.advanceTimersByTimeAsync(1); expect(returned).toBe(false);
      await vi.advanceTimersByTimeAsync(10); expect(await pending).toMatchObject({ reason: "rate_limited_user" });
      expect(test.recordDenial).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it("does not record an abandoned countable verdict when another final decision won", async () => {
    for (const alternate of [{ stage: "rate_limit", reason: "dependency_failure" }, { stage: "authorize", reason: "rate_limited_user" }] as const) {
      const test = fixture(denied()); const request = record();
      await withDeferredLimitDenials(async () => {
        await test.stage(request);
        return denyDecision({ decisionId: request.decisionId, requestId: request.requestId, ...alternate });
      });
      expect(test.recordDenial).not.toHaveBeenCalled();
    }
  });

});
