import { afterEach, describe, expect, it, vi } from "vitest";
import { PIPELINE_STAGES } from "@dap/contracts";
import { createPipeline, type PolicyStage } from "./pipeline.js";
import { allowedDecision } from "./decision.js";
import { input, run, stageMap } from "./fixtures.test-support.js";

afterEach(() => { vi.useRealTimers(); });
const allow: PolicyStage = (request) => ({ kind: "stop", decision: allowedDecision({ decisionId: request.decisionId, requestId: request.requestId, actionId: "viewProject" as never, risk: "SAFE", paramsDigest: "a".repeat(64) as never }) });

describe("ordered immutable request pipeline", () => {
  it("runs pre-execution D6 positions in order and refuses an unconfirmed terminal fixture", async () => {
    const seen: string[] = [];
    const stages = stageMap(allow);
    for (const name of [...PIPELINE_STAGES].reverse()) {
      const original = stages[name]!;
      stages[name] = (request) => { seen.push(name); return original(request); };
    }
    const result = await createPipeline(stages).run(input());
    expect(result).toMatchObject({ outcome: "DENIED", stage: "execute", reason: "dependency_failure" });
    expect(seen).toEqual(PIPELINE_STAGES.filter(name => name !== "execute"));
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("a continuing execute stage still denies", async () => {
    expect(await createPipeline(stageMap(() => ({ kind: "continue", data: {} }))).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "execute" });
  });

  it("snapshots a stage result once and does not let later stages mutate earlier facts", async () => {
    const original = { nested: { values: ["initial"] } };
    let reads = 0;
    let earlier: unknown;
    const stages = stageMap(allow);
    stages.intake = (request) => { earlier = request; return { kind: "continue", get data() { reads++; return original; } }; };
    stages.resolve = (request) => {
      const data = request.facts.intake as unknown as typeof original;
      expect(data).toEqual(original);
      original.nested.values[0] = "source changed";
      expect(data.nested.values).toEqual(["initial"]);
      expect(() => { data.nested.values.push("mutation"); }).toThrow();
      expect(Object.isFrozen(request)).toBe(true);
      expect(Object.isFrozen(request.run)).toBe(true);
      expect(Object.isFrozen(request.facts)).toBe(true);
      expect((earlier as { facts: object }).facts).not.toHaveProperty("intake");
      return { kind: "continue", data: {} };
    };
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", stage: "execute", reason: "dependency_failure" });
    expect(reads).toBe(1);
  });

  it("reads every proposal field exactly once however often intake asks", async () => {
    let callIdReads = 0;
    let rawReads = 0;
    const raw = { action: "viewProject", params: {} };
    const call = { get callId() { callIdReads++; return "call"; }, get raw() { rawReads++; return raw; } };
    const seen: unknown[] = [];
    const stages = stageMap(allow);
    stages.intake = (request) => { seen.push(request.readProposal(), request.readProposal(), request.readProposal()); return { kind: "continue", data: {} }; };
    expect(await createPipeline(stages).run({ ...input(), readProposal: () => call as never })).toMatchObject({ outcome: "DENIED", stage: "execute", reason: "dependency_failure" });
    expect([callIdReads, rawReads]).toEqual([1, 1]);
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toEqual({ callId: "call", raw });
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it.each(PIPELINE_STAGES.filter((name) => name !== "intake" && name !== "execute"))("%s cannot read the untrusted proposal; only intake may", async (stage) => {
    let reads = 0;
    let executions = 0;
    const call = { get callId(): string { reads++; return "call"; }, get raw(): unknown { reads++; return {}; } };
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    stages[stage] = (request) => { request.readProposal(); return allow(request); };
    expect(await createPipeline(stages).run({ ...input(), readProposal: () => call as never })).toMatchObject({ outcome: "DENIED", reason: "internal_error", stage });
    expect(reads).toBe(0);
    expect(executions).toBe(0);
  });

  it("never lets a stage after context run without a minted context", async () => {
    let later = 0;
    const stages = stageMap(() => { later++; throw new Error("unreachable"); });
    stages.context = () => ({ kind: "continue", data: {} });
    stages.intake = () => { later++; return { kind: "continue", data: {} }; };
    expect(await createPipeline(stages).run({ ...input(), context: { forged: true } })).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "context" });
    expect(await createPipeline(stages).run({ ...input(), context: undefined })).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "context" });
    expect(later).toBe(0);
  });

  it.each([
    ["null", null], ["undefined", undefined], ["empty", {}], ["negative depth", { ...run, depth: -1 }], ["fractional depth", { ...run, depth: 1.5 }], ["missing model", { ...run, model: undefined }],
    ["empty turn", { ...run, turnId: "" }], ["extra key", { ...run, userId: "mallory" }], ["bad instant", { ...run, turnStartedAt: "yesterday" }],
  ])("denies before any stage when run metadata is %s", async (_label, metadata) => {
    let calls = 0;
    const stages = stageMap(() => { calls++; return allow({ ...input(), run, context: null, facts: {}, budget: { remainingMs: () => 1 } }); });
    for (const name of PIPELINE_STAGES) { const original = stages[name]!; stages[name] = (request) => { calls++; return original(request); }; }
    expect(await createPipeline(stages).run({ ...input(), run: metadata })).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "context" });
    expect(calls).toBe(0);
    expect(await createPipeline(stageMap(allow)).run(input())).toMatchObject({ outcome: "DENIED", stage: "execute", reason: "dependency_failure" });
  });

  it("denies before any stage when run metadata cannot even be read", async () => {
    let calls = 0;
    const cyclic: Record<string, unknown> = { ...run };
    cyclic.self = cyclic;
    const stages = stageMap(allow);
    for (const name of PIPELINE_STAGES) { const original = stages[name]!; stages[name] = (request) => { calls++; return original(request); }; }
    const decision = await createPipeline(stages).run({ ...input(), run: cyclic });
    expect(decision).toMatchObject({ outcome: "DENIED", stage: "context" });
    expect(["internal_error", "dependency_failure"]).toContain((decision as { reason: string }).reason);
    expect(calls).toBe(0);
  });

  it.each([["decisionId", undefined], ["decisionId", ""], ["decisionId", 7], ["requestId", undefined], ["requestId", ""], ["requestId", null], ["readProposal", undefined], ["readProposal", "call"]])("denies before any stage when %s is %j", async (field, value) => {
    let calls = 0;
    const stages = stageMap(allow);
    for (const name of PIPELINE_STAGES) { const original = stages[name]!; stages[name] = (request) => { calls++; return original(request); }; }
    const decision = await createPipeline(stages).run({ ...input(), [field]: value });
    expect(decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "context" });
    expect(calls).toBe(0);
  });

  it("stays unavailable when the proposal throws once, without a second read", async () => {
    let reads = 0;
    let executions = 0;
    const call = { callId: "call", get raw(): never { reads++; throw new Error("CANARY"); } };
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    const failures: unknown[] = [];
    stages.intake = (request) => {
      for (let attempt = 0; attempt < 2; attempt++) { try { request.readProposal(); } catch (error) { failures.push(error); } }
      throw failures[0];
    };
    const decision = await createPipeline(stages).run({ ...input(), readProposal: () => call });
    expect(decision).toMatchObject({ outcome: "DENIED", reason: "internal_error", stage: "intake" });
    expect(failures).toHaveLength(2);
    expect(reads).toBe(1);
    expect(executions).toBe(0);
    expect(JSON.stringify(decision)).not.toContain("CANARY");
  });

  it.each([null, undefined, 7, "text"])("an unusable proposal object %j is unavailable, not a crash", async (value) => {
    let outcome = "";
    const stages = stageMap(allow);
    stages.intake = (request) => { try { request.readProposal(); outcome = "read"; } catch { outcome = "unavailable"; } return { kind: "continue", data: {} }; };
    await createPipeline(stages).run({ ...input(), readProposal: () => value as never });
    expect(outcome).toBe("unavailable");
  });

  it("takes a snapshot of stage registrations", async () => {
    const stages = stageMap(allow);
    const pipeline = createPipeline(stages);
    stages.intake = () => { throw new Error("replacement"); };
    expect(await pipeline.run(input())).toMatchObject({ outcome: "DENIED", stage: "execute", reason: "dependency_failure" });
  });

  it("isolates concurrent requests through one pipeline", async () => {
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const observed: string[] = [];
    const stages = stageMap(allow);
    stages.intake = async (request) => {
      if (request.requestId === "first") await gate;
      return { kind: "continue", data: { requestId: request.requestId } };
    };
    stages.audit = (request) => {
      observed.push((request.facts.intake as { requestId: string }).requestId);
      return { kind: "continue", data: {} };
    };
    const pipeline = createPipeline(stages);
    const first = pipeline.run(input("first"));
    expect((await pipeline.run(input("second"))).requestId).toBe("second");
    resume();
    expect((await first).requestId).toBe("first");
    expect(observed).toEqual(["second", "first"]);
  });

  it("does not touch an answer arriving after timeout and handles late rejection", async () => {
    vi.useFakeTimers();
    let resolve!: (answer: unknown) => void;
    let reject!: (error: Error) => void;
    let reads = 0;
    for (const mode of ["resolve", "reject"]) {
      const stages = stageMap(allow);
      stages.intake = (() => new Promise<unknown>((yes, no) => { resolve = yes; reject = no; })) as PolicyStage;
      const pending = createPipeline(stages, { hookTimeoutMs: 20 }).run(input());
      await vi.advanceTimersByTimeAsync(20);
      expect(await pending).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
      if (mode === "resolve") resolve({ get kind() { reads++; return "continue"; }, data: {} });
      else reject(new Error("late error"));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(reads).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a decision bound to a different request", async () => {
    const stages = stageMap(() => allow({ ...input("other"), run, context: null, facts: {}, budget: { remainingMs: () => 1 } }));
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
  });

  it.each([null, false, [], "wrong", 4])("denies malformed continuation data %j", async (data) => {
    let executions = 0;
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    stages.intake = (() => ({ kind: "continue", data })) as unknown as PolicyStage;
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "intake" });
    expect(executions).toBe(0);
  });

  it("does not re-read an unexpected then getter after promise assimilation", async () => {
    let reads = 0;
    let executions = 0;
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    stages.intake = () => ({ kind: "continue", data: {}, get then() { reads++; return undefined; } });
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
    expect(reads).toBe(1);
    expect(executions).toBe(0);
  });
});
