/**
 * The runner owns the overall per-proposal deadline (proposalBudgetMs, default 10 000): no stage can extend it, it is
 * checked before every stage, and it is judged on the runner's own monotonic timer (a counter in these tests, never the wall clock).
 */
import { describe, expect, it } from "vitest";
import type { PipelineStage } from "@dap/contracts";
import { createPipeline, type PolicyStage } from "./pipeline.js";
import { createPolicyGateway, pipelineOptions } from "./create-gateway.js";
import type { HookTimer } from "./hook-wrapper.js";
import { allowedDecision } from "./decision.js";
import { chain } from "./chain.test-support.js";
import { dependencies, input as rawInput, stageMap } from "./fixtures.test-support.js";

/**
 * `gap` is time that passes BETWEEN stages: the runner clears a stage's timer as the stage settles, which is after the
 * stage's own deadline was judged, so time added there is not charged to the stage but is to the proposal.
 */
class ManualTimer implements HookTimer {
  time = 0; gap = 0; private next = 0;
  readonly pending = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, ms: number): number { const id = this.next++; this.pending.set(id, { at: this.time + ms, callback }); return id; }
  clearTimeout(handle: unknown): void { this.pending.delete(handle as number); this.time += this.gap; }
  advance(ms: number): void { this.time += ms; for (const [id, entry] of [...this.pending]) if (entry.at <= this.time) { this.pending.delete(id); entry.callback(); } }
}
const input = (name?: string) => ({ ...rawInput(name), readProposal: () => ({ callId: name ?? "budget", raw: { action: "openProject", params: { projectId: "p1" } } }) });
const allow: PolicyStage = (request) => ({ kind: "stop", decision: allowedDecision({ decisionId: request.decisionId, requestId: request.requestId, actionId: "viewProject" as never, risk: "SAFE", paramsDigest: "a".repeat(64) as never }) });
/** Every stage but the terminal one just continues, recording that it ran; time passes between stages via `timer.gap`. */
function costing(timer: ManualTimer, gap: number, ran: PipelineStage[] = [], committed = false) {
  timer.gap = gap;
  const real = committed ? chain() : undefined;
  const stages = real ? { ...real.built.stages, ...real.standIns } : stageMap(allow);
  for (const name of Object.keys(stages) as PipelineStage[]) if (name !== "execute") { const stage = stages[name]!; stages[name] = request => { ran.push(name); return stage(request); }; }
  return stages;
}

describe("proposalBudgetMs", () => {
  it("defaults to 10 000 ms: execution succeeds with budget left; a committed policy stays ALLOWED when execution cannot start", async () => {
    const within = new ManualTimer();
    expect(await createPipeline(costing(within, 999, [], true), { timer: within, hookTimeoutMs: 2000 }).evaluate(input())).toMatchObject({ decision: { outcome: "ALLOWED" }, executionStatus: "success" }); // 10 gaps x 999 = 9990
    const over = new ManualTimer();
    expect(await createPipeline(costing(over, 1000, [], true), { timer: over, hookTimeoutMs: 2000 }).evaluate(input())).toMatchObject({ decision: { outcome: "ALLOWED" }, executionStatus: "failure" }); // The allow-event committed before the last gap; no execution budget remains
  });

  it("defaults to exactly 10 000 ms: 9999 ms spent leaves the next stage 1 ms, 10 000 leaves none", async () => {
    for (const [spentMs, reaches] of [[9999, "rate_limit"], [10_000, "intake"]] as const) {
      const timer = new ManualTimer();
      const ran: PipelineStage[] = [];
      const stages = costing(timer, 0, ran);
      stages.context = () => { ran.push("context"); timer.gap = spentMs; return { kind: "continue", data: {} }; };
      stages.intake = () => { ran.push("intake"); timer.gap = 0; return { kind: "continue", data: {} }; };
      const decision = await createPipeline(stages, { timer }).run(input());
      expect(ran.includes("intake"), String(spentMs)).toBe(reaches !== "intake");
      expect(decision, String(spentMs)).toMatchObject({ outcome: "DENIED", stage: spentMs === 9999 ? "execute" : "intake", reason: "dependency_failure" });
    }
  });

  it("denies the NEXT stage once the budget is spent, attributed to that stage, and never runs it", async () => {
    const timer = new ManualTimer();
    const ran: PipelineStage[] = [];
    const decision = await createPipeline(costing(timer, 40, ran), { timer, proposalBudgetMs: 100 }).run(input());
    expect(ran).toEqual(["context", "intake", "rate_limit"]); // 40, 80 and 120 ms have passed when each next stage is due
    expect(decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "replay" });
  });

  it("a budget spent exactly at a stage boundary leaves nothing for the next stage", async () => {
    const timer = new ManualTimer();
    const ran: PipelineStage[] = [];
    const decision = await createPipeline(costing(timer, 50, ran), { timer, proposalBudgetMs: 100 }).run(input());
    expect(ran).toEqual(["context", "intake"]); // 50 and 100 ms have passed when each next stage is due
    expect(decision).toMatchObject({ stage: "rate_limit", reason: "dependency_failure" });
  });

  it("is enforced ahead of the authorize stage: authorize is not entered when earlier stages used the budget", async () => {
    const timer = new ManualTimer();
    const stages = costing(timer, 0);
    let entered = 0;
    stages.validate = () => { timer.gap = 500; return { kind: "continue", data: {} }; };
    stages.authorize = () => { entered++; return { kind: "continue", data: {} }; };
    expect(await createPipeline(stages, { timer, proposalBudgetMs: 500 }).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "authorize" });
    expect(entered).toBe(0);
  });

  it("gives the authorize stage the remaining budget as its deadline, not hookTimeoutMs", async () => {
    const timer = new ManualTimer();
    const stages = costing(timer, 0);
    stages.authorize = () => new Promise(() => {}) as never;
    let settled = false;
    const pending = createPipeline(stages, { timer, hookTimeoutMs: 100, proposalBudgetMs: 1000 }).run(input()).then((decision) => { settled = true; return decision; });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    timer.advance(999); for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(settled).toBe(false); // hookTimeoutMs (100) did NOT end it
    timer.advance(1);
    expect(await pending).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "authorize" });
    expect(timer.pending.size).toBe(0);
  });

  it("gives every other stage min(hookTimeoutMs, what is left)", async () => {
    const timer = new ManualTimer();
    const stages = costing(timer, 0);
    stages.resolve = () => new Promise(() => {}) as never;
    // 150 of 200 ms already spent before resolve: the stage may have only the remaining 50 although hookTimeoutMs is 2000.
    stages.validate = stages.validate!; stages.intake = () => { timer.time += 150; return { kind: "continue", data: {} }; };
    let settled = false;
    const pending = createPipeline(stages, { timer, hookTimeoutMs: 2000, proposalBudgetMs: 200 }).run(input()).then((decision) => { settled = true; return decision; });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    timer.advance(49); for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(settled).toBe(false);
    timer.advance(1);
    expect(await pending).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "resolve" });
  });

  it("still caps a stage with plenty of budget at hookTimeoutMs", async () => {
    const timer = new ManualTimer();
    const stages = costing(timer, 0);
    stages.resolve = () => new Promise(() => {}) as never;
    const pending = createPipeline(stages, { timer, hookTimeoutMs: 100, proposalBudgetMs: 60_000 }).run(input());
    for (let i = 0; i < 20; i++) await Promise.resolve();
    timer.advance(100);
    expect(await pending).toMatchObject({ stage: "resolve", reason: "dependency_failure" });
  });

  it("a stage cannot extend the budget by being slow: the time it takes counts", async () => {
    const timer = new ManualTimer();
    const stages = costing(timer, 0);
    stages.intake = () => { timer.time += 1_000_000; return { kind: "continue", data: {} }; }; // synchronous blocking, no timer dispatch
    const decision = await createPipeline(stages, { timer, hookTimeoutMs: 2_000_000, proposalBudgetMs: 5000 }).run(input());
    expect(decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
  });

  it.each([["NaN at the start", () => Number.NaN], ["infinite at the start", () => Number.POSITIVE_INFINITY], ["negative infinity at the start", () => Number.NEGATIVE_INFINITY]])("a timer that cannot tell the time leaves no budget (%s)", async (_name, reading) => {
    const timer = new ManualTimer();
    timer.now = reading;
    const ran: PipelineStage[] = [];
    const decision = await createPipeline(costing(timer, 0, ran), { timer }).run(input());
    expect(decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "context" });
    expect(ran).toEqual([]);
  });

  it("a timer that runs backwards leaves no budget", async () => {
    const timer = new ManualTimer();
    timer.time = 1000;
    const ran: PipelineStage[] = [];
    const stages = costing(timer, -2000, ran);
    expect(await createPipeline(stages, { timer }).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "intake" });
    expect(ran).toEqual(["context"]);
  });

  it.each([0, -1, 1.5, Number.NaN, 0x8000_0000, "100", null])("rejects an invalid proposalBudgetMs of %j", (value) => {
    expect(() => createPipeline(stageMap(allow), { proposalBudgetMs: value as number })).toThrow(RangeError);
  });

  it("passes every stage a budget that reads the same timer, and that is frozen", async () => {
    const timer = new ManualTimer();
    const stages = stageMap(allow);
    const seen: number[] = [];
    let frozen = false;
    stages.context = (request) => { frozen = Object.isFrozen(request.budget); seen.push(request.budget.remainingMs()); timer.time += 30; return { kind: "continue", data: {} }; };
    stages.intake = (request) => { seen.push(request.budget.remainingMs()); return { kind: "continue", data: {} }; };
    await createPipeline(stages, { timer, proposalBudgetMs: 100 }).run(input());
    expect(seen).toEqual([100, 70]);
    expect(frozen).toBe(true);
  });

  it("is per proposal: one proposal's time does not reduce another's", async () => {
    const timer = new ManualTimer();
    const pipeline = createPipeline(costing(timer, 400, [], true), { timer, proposalBudgetMs: 4400 });
    expect(await pipeline.evaluate(input("a"))).toMatchObject({ decision: { outcome: "ALLOWED" }, executionStatus: "success" }); // 10 stages x 400 = 4000
    expect(await pipeline.evaluate(input("b"))).toMatchObject({ decision: { outcome: "ALLOWED" }, executionStatus: "success" });
  });
});

describe("per-stage deadlines for the stages added by T089", () => {
  const hang = (stage: PipelineStage) => {
    const timer = new ManualTimer();
    const stages = costing(timer, 0, [], stage === "execute");
    let entered = false;
    stages[stage] = () => { entered = true; return new Promise(() => {}) as never; };
    let settled = false;
    const pending = createPipeline(stages, { timer, hookTimeoutMs: 100, proposalBudgetMs: 1000 }).run(input()).then((decision) => { settled = true; return decision; });
    return { timer, pending, settled: () => settled, entered: () => entered };
  };
  const flush = async () => { for (let i = 0; i < 300; i++) await Promise.resolve(); };

  it("audit gets the remaining budget, not a hook timeout", async () => {
    const test = hang("audit");
    await flush(); expect(test.entered()).toBe(true); test.timer.advance(999); await flush();
    expect(test.settled()).toBe(false);
    test.timer.advance(1);
    expect(await test.pending).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "audit" });
  });

  it("execute gets the remaining budget plus one hook timeout, exactly", async () => {
    const test = hang("execute");
    await flush(); expect(test.entered()).toBe(true); test.timer.advance(1099); await flush();
    expect(test.settled()).toBe(false);
    test.timer.advance(1);
    expect(await test.pending).toMatchObject({ outcome: "ALLOWED" }); // The receipt is confirmed; the missing execution result is failure.
  });

  it("authorize gets the remaining budget", async () => {
    const test = hang("authorize");
    await flush(); expect(test.entered()).toBe(true); test.timer.advance(999); await flush();
    expect(test.settled()).toBe(false);
    test.timer.advance(1);
    expect(await test.pending).toMatchObject({ stage: "authorize" });
  });
});

describe("the gateway's proposalBudgetMs setting", () => {
  it.each([0, -1, 1.5, "60", null, 0x8000_0000])("rejects an invalid configured value %j at the config check", (value) => {
    const { deps } = dependencies();
    Object.assign(deps.config, { proposalBudgetMs: value });
    expect(() => createPolicyGateway(deps)).toThrow(TypeError); // the config schema, not the pipeline's own RangeError
  });

  it("reaches the runner: pipelineOptions carries the configured budget and hook timeout, and omits an unset budget", () => {
    const { deps } = dependencies();
    expect(pipelineOptions(deps.config)).toEqual({ hookTimeoutMs: 2000 });
    expect(Object.hasOwn(pipelineOptions(deps.config), "proposalBudgetMs")).toBe(false);
    expect(pipelineOptions({ ...deps.config, proposalBudgetMs: 4321, hookTimeoutMs: 77 })).toEqual({ hookTimeoutMs: 77, proposalBudgetMs: 4321 });
  });

  it("is optional, and accepts a positive integer", () => {
    const { deps } = dependencies();
    expect(() => createPolicyGateway(deps)).not.toThrow();
    Object.assign(deps.config, { proposalBudgetMs: 5000 });
    expect(() => createPolicyGateway(deps)).not.toThrow();
  });
});
