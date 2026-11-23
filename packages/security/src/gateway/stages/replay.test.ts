import { describe, expect, it, vi } from "vitest";
import { InMemoryReplayGuard } from "../../state/memory/replay.js";
import { createReplayStage } from "./replay.js";
import { context, input, run } from "../fixtures.test-support.js";
import type { PipelineRecord } from "../pipeline.js";
import { toPlannerFeedback } from "../feedback.js";

const record = (over: Partial<PipelineRecord> = {}): PipelineRecord => ({ ...input(), context: context(), run, facts: { intake: { callId: "trusted-call", params: { tenantId: "forged", callId: "forged" } } }, budget: { remainingMs: () => 10000 }, ...over });
describe("T117 replay stage", () => {
  it("claims only trusted scope/session/call id with configured retention and never rereads raw", async () => {
    const claim = vi.fn(async () => "claimed" as const); const request = record();
    expect(await createReplayStage({ replay: { claim }, retainSeconds: 86400 })(request)).toEqual({ kind: "continue", data: { claimed: true } });
    expect(claim).toHaveBeenCalledExactlyOnceWith(request.context, "ai-session:trusted-call", 86400);
  });
  it("distinct valid session/call pairs with separators never alias", async () => {
    const stage = createReplayStage({ replay: new InMemoryReplayGuard({ now: () => run.turnStartedAt }), retainSeconds: 86400 });
    for (const [session, callId] of [["a:b", "c"], ["a", "b:c"], ["a%3Ab", "c"]]) {
      const request = record({ run: { ...run, aiSessionId: session! }, facts: { intake: { callId: callId! } } });
      expect(await stage(request)).toMatchObject({ kind: "continue" });
      expect(await stage(request)).toMatchObject({ decision: { reason: "replayed_request" } });
    }
  });
  it("uses a non-default configured retention", async () => {
    const claim = vi.fn(async () => "claimed" as const); const request = record();
    await createReplayStage({ replay: { claim }, retainSeconds: 37 })(request);
    expect(claim).toHaveBeenCalledExactlyOnceWith(request.context, "ai-session:trusted-call", 37);
  });
  it("a duplicate is replayed_request and never a grant; faults/capacity/malformed responses are retryable", async () => {
    for (const answer of ["duplicate", undefined, "claimed ", true, { claimed: true }]) {
      const stage = createReplayStage({ replay: { claim: async () => answer as never }, retainSeconds: 86400 });
      const result = await stage(record());
      expect(result).toMatchObject({ kind: "stop", decision: { stage: "replay", reason: answer === "duplicate" ? "replayed_request" : "dependency_failure" } });
      if (result.kind === "stop") expect(toPlannerFeedback(result.decision)).toEqual({ outcome: "DENIED", category: answer === "duplicate" ? "not_available" : "try_later" });
    }
    expect(await createReplayStage({ replay: { claim: async () => { throw new Error("capacity exhausted"); } }, retainSeconds: 86400 })(record())).toMatchObject({ decision: { reason: "dependency_failure" } });
  });
  it("refuses forged contexts, absent/unvalidated ids and exhausted runner budget without calling state", async () => {
    const claim = vi.fn(async () => "claimed" as const); const stage = createReplayStage({ replay: { claim }, retainSeconds: 86400 });
    const cases: Partial<PipelineRecord>[] = [{ context: { ...context() } }, { facts: {} }, { budget: { remainingMs: () => 0 } }];
    for (const callId of ["", "a b", "a\nb", "x".repeat(257), 4]) cases.push({ facts: { intake: { callId } } });
    for (const aiSessionId of ["", "x".repeat(257), "bad\u0000id"]) cases.push({ run: { ...run, aiSessionId } });
    for (const over of cases) expect(await stage(record(over))).toMatchObject({ decision: { reason: "dependency_failure" } });
    expect(claim).not.toHaveBeenCalled();
  });
  it("a hung guard is bounded by the remaining proposal budget", async () => {
    vi.useFakeTimers();
    try {
      const stage = createReplayStage({ replay: { claim: () => new Promise(() => {}) }, retainSeconds: 86400 });
      const pending = stage(record({ budget: { remainingMs: () => 40 } }));
      await vi.advanceTimersByTimeAsync(40);
      expect(await pending).toMatchObject({ decision: { reason: "dependency_failure" } });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it.each([0, -1, NaN, Infinity, 1.5, 31536001])("rejects invalid retention %s", (retainSeconds) => {
    expect(() => createReplayStage({ replay: { claim: async () => "claimed" }, retainSeconds })).toThrow();
  });
});
