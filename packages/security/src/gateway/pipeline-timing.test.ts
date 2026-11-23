import { describe, expect, it } from "vitest";
import type { HookTimer } from "./hook-wrapper.js";
import { createPipeline, type PolicyStage } from "./pipeline.js";
import { allowedDecision } from "./decision.js";
import { chain } from "./chain.test-support.js";
import { input, stageMap } from "./fixtures.test-support.js";

class ManualTimer implements HookTimer {
  time = 0;
  private next = 0;
  readonly pending = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, ms: number): number { const id = this.next++; this.pending.set(id, { at: this.time + ms, callback }); return id; }
  clearTimeout(handle: unknown): void { this.pending.delete(handle as number); }
  advance(ms: number): void {
    this.time += ms;
    for (const [id, entry] of this.pending) if (entry.at <= this.time) { this.pending.delete(id); entry.callback(); }
  }
}
const allow: PolicyStage = (request) => ({ kind: "stop", decision: allowedDecision({ decisionId: request.decisionId, requestId: request.requestId, actionId: "viewProject" as never, risk: "SAFE", paramsDigest: "a".repeat(64) as never }) });
const never = () => { throw new Error("terminal must not run"); };
const timeout = { outcome: "DENIED", reason: "dependency_failure", stage: "context" };

/** Runs the pipeline with the first stage (`context`) replaced, so a broken timer is attributed to it; `execute` counts, so every denial also proves nothing ran. */
function harness(first: PolicyStage, timer: HookTimer, hookTimeoutMs?: number) {
  let executions = 0;
  const stages = stageMap(() => { executions++; return never(); });
  stages.context = first;
  return { run: () => createPipeline(stages, { timer, ...(hookTimeoutMs ? { hookTimeoutMs } : {}) }).run(input()), executions: () => executions };
}

describe("stage deadline and timer boundary", () => {
  it("times out at the default 2000 ms, clears its timer, and never observes a late answer", async () => {
    const timer = new ManualTimer();
    let reads = 0;
    let resolve!: (answer: unknown) => void;
    const test = harness(() => new Promise((done) => { resolve = done; }) as never, timer);
    let settled = false;
    const pending = test.run().then((decision) => { settled = true; return decision; });
    await Promise.resolve();
    timer.advance(1999); await Promise.resolve(); expect(settled).toBe(false);
    timer.advance(1);
    expect(await pending).toMatchObject(timeout);
    expect(timer.pending.size).toBe(0);
    resolve({ get kind() { reads++; return "continue"; }, data: {} });
    await Promise.resolve();
    expect(reads).toBe(0);
    expect(test.executions()).toBe(0);
  });

  it("gives every stage its own deadline", async () => {
    const timer = new ManualTimer();
    const real = chain();
    const stages = { ...real.built.stages, ...real.standIns };
    for (const name of ["context", "intake", "resolve"] as const) { const stage = stages[name]!; stages[name] = request => { timer.time += 1500; return stage(request); }; }
    expect((await createPipeline(stages, { timer, hookTimeoutMs: 2000 }).run({ ...input(), readProposal: () => ({ callId: "timing", raw: real.text({ projectId: "p1" }) }) })).outcome).toBe("ALLOWED");
    expect(real.executorCalls).toHaveLength(1);
  });

  it("checks elapsed time even if synchronous stage code blocks timer dispatch", async () => {
    const timer = new ManualTimer();
    const test = harness(() => { timer.time = 2001; return { kind: "continue", data: {} }; }, timer);
    expect(await test.run()).toMatchObject(timeout);
    expect(test.executions()).toBe(0);
    expect(timer.pending.size).toBe(0);
  });

  it("does not snapshot an already-expired answer", async () => {
    const timer = new ManualTimer();
    let reads = 0;
    const test = harness(() => { timer.time = 2001; return { get kind() { reads++; return "continue"; }, data: {} } as never; }, timer);
    expect(await test.run()).toMatchObject(timeout);
    expect(reads).toBe(0);
  });

  it("rejects an answer that was captured in time but whose capture itself overran", async () => {
    const timer = new ManualTimer();
    let readings = 0;
    // The runner reads the timer twice before the first stage (its start and the budget check); the stage's own deadline reads it at start, on arrival and on capture.
    timer.now = () => (++readings >= 5 ? 2001 : 0);
    const test = harness(() => ({ kind: "continue", data: {} }), timer);
    expect(await test.run()).toMatchObject(timeout);
    expect(test.executions()).toBe(0);
  });

  it("clears its timer on success, rejection, throw and malformed answers", async () => {
    for (const first of [() => ({ kind: "continue", data: {} }), () => Promise.reject(new Error("x")), () => { throw new Error("x"); }, () => ({ nonsense: true })] as unknown as PolicyStage[]) {
      const timer = new ManualTimer();
      await harness(first, timer).run();
      expect(timer.pending.size).toBe(0);
    }
  });

  it("denies, without running the stage, when the timer cannot be armed", async () => {
    const timer = new ManualTimer();
    timer.setTimeout = () => { throw new Error("CANARY timer"); };
    let calls = 0;
    const test = harness(() => { calls++; return { kind: "continue", data: {} }; }, timer);
    const decision = await test.run();
    expect(decision).toMatchObject(timeout);
    expect(JSON.stringify(decision)).not.toContain("CANARY");
    expect(calls).toBe(0);
    expect(test.executions()).toBe(0);
  });

  it.each([NaN, Infinity, -Infinity, undefined, "0"])("denies, without running the stage, on a non-finite start reading %j", async (reading) => {
    const timer = new ManualTimer();
    timer.now = () => reading as number;
    let calls = 0;
    const test = harness(() => { calls++; return { kind: "continue", data: {} }; }, timer);
    expect(await test.run()).toMatchObject(timeout);
    expect(calls).toBe(0);
  });

  it.each([-1, NaN, Infinity, undefined])("denies on a clock that moves backwards or breaks after the start (%j)", async (later) => {
    const timer = new ManualTimer();
    let readings = 0;
    timer.now = () => (++readings === 1 ? 100 : later as number);
    expect(await harness(() => ({ kind: "continue", data: {} }), timer).run()).toMatchObject(timeout);
  });

  it("denies when the timer cannot be cleared, even for a good answer", async () => {
    const timer = new ManualTimer();
    timer.clearTimeout = () => { throw new Error("CANARY cleanup"); };
    const test = harness(() => ({ kind: "continue", data: {} }), timer);
    const decision = await test.run();
    expect(decision).toMatchObject(timeout);
    expect(JSON.stringify(decision)).not.toContain("CANARY");
    expect(test.executions()).toBe(0);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2 ** 31, "20", null])("refuses the invalid timeout %j at construction", (hookTimeoutMs) => {
    expect(() => createPipeline(stageMap(allow), { hookTimeoutMs: hookTimeoutMs as number })).toThrow(RangeError);
  });
});
