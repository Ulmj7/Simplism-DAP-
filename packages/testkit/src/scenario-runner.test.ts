import { describe, it, expect } from "vitest";
import type { AttackScenario, CapabilityTraits, ExecutionResult, PlannerFeedback, ProposalCall } from "@dap/contracts";
import { InMemoryAuditSink } from "./audit-capture.js";
import { RecordingExecutor } from "./recording-executor.js";

const RESULT: ExecutionResult<unknown> = { status: "success" };
import { runScenario } from "./scenario-runner.js";
import type { ScenarioTarget } from "./scenario-runner.js";

const TRAITS = {
  actionId: "testSafeEcho",
  risk: "SAFE" as const,
  changesState: false,
  targetsResource: false,
  requiresConfirmation: false,
};

function makeExecutor() {
  return new RecordingExecutor<unknown, unknown>({ id: "leaky-exec", result: RESULT });
}

function targetFor(overrides: Partial<ScenarioTarget> = {}): ScenarioTarget {
  return {
    ...TRAITS,
    planner: { script: [] },
    submit: async (): Promise<PlannerFeedback> => ({ outcome: "ALLOWED", category: "ok" }),
    executor: makeExecutor(),
    audit: new InMemoryAuditSink(),
    visibleOutput: null,
    ...overrides,
  };
}

/** A trivial scenario: send every scripted proposal through the target's submitter. */
function trivialScenario(): AttackScenario {
  return {
    id: "ATK-TRIVIAL-01",
    category: "secret-extraction",
    title: "trivial scripted run",
    appliesTo: () => true,
    run: async (target) => {
      const t = target as unknown as ScenarioTarget;
      const feedback: PlannerFeedback[] = [];
      for (const call of t.planner.script) {
        feedback.push(await t.submit(call));
      }
      return {
        feedback,
        executorCalls: t.executor.calls,
        auditEvents: [...t.audit.events],
        leakFindings: [],
      };
    },
    verify: () => [],
  };
}

describe("scenario-runner (T035)", () => {
  it("collects feedback, executor call count, and audit events for a clean run", async () => {
    const calls: ProposalCall[] = [
      { callId: "c1", raw: JSON.stringify({ action: "testSafeEcho", params: { message: "ok" } }) },
    ];
    const target = targetFor({ planner: { script: calls } });
    const obs = await runScenario(trivialScenario(), target);

    expect(obs.feedback).toEqual([{ outcome: "ALLOWED", category: "ok" }]);
    expect(obs.executorCalls).toBe(0);
    expect(obs.auditEvents).toEqual([]);
    expect(obs.leakFindings).toEqual([]);
  });

  it("runs LeakScanner over all planner-visible output (feedback and visibleOutput)", async () => {
    const target = targetFor({
      visibleOutput: {
        // A weak stand-in gateway that reflects an untrusted error object: the stack trace
        // is pattern-detectable without any registered canary.
        text: "Error: boom\n    at boom (a.js:1:2)",
      },
    });
    const scenario: AttackScenario = {
      id: "ATK-LEAK-01",
      category: "secret-extraction",
      title: "leaky output",
      appliesTo: () => true,
      run: async () => ({
        feedback: [{ outcome: "ALLOWED", category: "ok" }],
        executorCalls: 0,
        auditEvents: [],
        leakFindings: ["canary:$"], // the scenario's own findings must be preserved
      }),
      verify: () => [],
    };
    const obs = await runScenario(scenario, target);
    expect(obs.leakFindings).toContain("canary:$");
    expect(obs.leakFindings.some((f) => f.startsWith("stack-trace:"))).toBe(true);
  });

  it("is fail-closed: a throwing scenario records the failure instead of crashing", async () => {
    const throwing: AttackScenario = {
      id: "ATK-THROW-01",
      category: "dependency-failure",
      title: "boom",
      appliesTo: () => true,
      run: async () => {
        throw new Error("internal explosion");
      },
      verify: () => [],
    };
    const obs = await runScenario(throwing, targetFor());
    expect(obs.feedback).toEqual([{ outcome: "DENIED", category: "not_available" }]);
    expect(obs.executorCalls).toBe(0);
    expect(obs.auditEvents).toEqual([]);
    expect(obs.leakFindings).toEqual(["runner-error:$"]);
  });

  it("is fail-closed: a throwing target submitter does not crash the runner", async () => {
    const calls: ProposalCall[] = [{ callId: "c1", raw: "{}" }];
    const target = targetFor({
      planner: { script: calls },
      submit: async (): Promise<PlannerFeedback> => {
        throw new Error("submit exploded");
      },
    });
    // The scenario propagates the submitter error; the runner must not.
    const obs = await runScenario(trivialScenario(), target);
    expect(obs.feedback).toEqual([{ outcome: "DENIED", category: "not_available" }]);
    expect(obs.executorCalls).toBe(0);
  });
});

describe("runScenario hands through the controls a scenario drives beyond a plain target", () => {
  type Driven = ScenarioTarget & { validProposal(): unknown; setPermissionAnswer(answer: unknown): void; resourceProposal(kind: string): unknown; readonly foreignDisplayNames: readonly string[] };
  const driving = (run: (target: Driven) => Promise<PlannerFeedback[]>): AttackScenario => ({
    id: "T-EXT", category: "privilege-escalation", title: "drives extra controls", appliesTo: () => true,
    async run(t) {
      const target = t as Driven;
      const feedback = await run(target);
      return { feedback, executorCalls: target.executor.calls, auditEvents: target.audit.events, leakFindings: [] };
    },
    verify: () => [],
  });

  it("calls an extra method on the real target (with its own `this`), and reads an extra value, while submissions stay guarded", async () => {
    const log: unknown[] = [];
    const target = Object.assign(targetFor(), {
      state: "s0", setPermissionAnswer(this: { state: string }, answer: unknown) { log.push([answer, this.state]); },
      get foreignDisplayNames() { return ["planted"]; },
    });
    const scenario = driving(async (t) => { t.setPermissionAnswer("yes"); log.push(t.foreignDisplayNames); return [await t.submit({ callId: "c", raw: "{}" })]; });
    const observation = await runScenario(scenario, target);
    expect(log).toEqual([["yes", "s0"], ["planted"]]);
    expect(observation.feedback).toEqual([{ outcome: "ALLOWED", category: "ok" }]);
  });

  it("an extra member can neither replace the guarded submitter nor the recording executor", async () => {
    const real = makeExecutor();
    const target = { ...targetFor({ executor: real }), executorCalls: 0 };
    const scenario = driving(async (t) => {
      for (const key of ["submit", "executor", "audit"]) { try { (t as unknown as Record<string, unknown>)[key] = {}; } catch { /* frozen */ } }
      return [await t.submit({ callId: "c", raw: "{}" })];
    });
    const observation = await runScenario(scenario, target);
    expect(observation.feedback).toEqual([{ outcome: "ALLOWED", category: "ok" }]);
    expect(real.calls).toBe(0);
    expect(observation.executorCalls).toBe(0);
  });

  it("is still fail-closed: an extra control that throws is a recorded failure, not a crash", async () => {
    const target = Object.assign(targetFor(), { setPermissionAnswer() { throw new Error("CANARY-boom"); } });
    const observation = await runScenario(driving(async (t) => { t.setPermissionAnswer(true); return []; }), target);
    expect(observation.feedback).toEqual([{ outcome: "DENIED", category: "not_available" }]);
    expect(JSON.stringify(observation)).not.toContain("CANARY-boom");
  });  it("exposes only read-only evidence and the named world controls, never a raw world, sink, executor or minter", async () => {
    const target = Object.assign(targetFor(), { gateway: { submit() {} }, mint() {}, self() { return this; }, foreignDisplayNames: ["PLANTED"] });
    let checked = false;
    const observation = await runScenario(driving(async (t) => {
      const view = t as unknown as Record<string, unknown>;
      for (const name of ["gateway", "mint", "self"]) expect(Object.hasOwn(view, name)).toBe(false);
      expect(Object.keys(t.audit)).toEqual(["events"]);
      expect(Object.keys(t.executor).sort()).toEqual(["calls", "grantsSeen", "receivedParams"]);
      expect(Object.isFrozen(t.audit)).toBe(true); expect(Object.isFrozen(t.executor)).toBe(true);
      expect(Object.isFrozen(t.planner)).toBe(true);
      expect(Object.isFrozen(t.planner.script)).toBe(true);
      checked = true;
      return [await t.submit({ callId: "c", raw: "{}" })];
    }), target);
    expect(checked).toBe(true);
    expect(observation.feedback).toHaveLength(1); expect(observation.leakFindings).toEqual([]);
  });
  it("hands through the two controls of the secret-extraction target (plantCanaries, failPermissionsWith) and still hides every other member", async () => {
    const log: unknown[] = [];
    const target = Object.assign(targetFor(), { plantCanaries() { log.push("planted"); }, failPermissionsWith(message: string) { log.push(message); }, setExecutorResult() { log.push("hidden"); } });
    const observation = await runScenario(driving(async (t) => {
      const view = t as unknown as Record<string, (...args: unknown[]) => void>;
      view.plantCanaries!(); view.failPermissionsWith!("boom");
      expect(Object.hasOwn(view, "setExecutorResult")).toBe(false);
      return [await t.submit({ callId: "c", raw: "{}" })];
    }), target);
    expect(log).toEqual(["planted", "boom"]);
    expect(observation.leakFindings).toEqual([]);
  });
  it("a caught throwing control still invalidates the observation", async () => {
    const target = Object.assign(targetFor(), { setPermissionAnswer() { throw new Error("CONTROL_SECRET"); } });
    const observation = await runScenario(driving(async (t) => {
      try { t.setPermissionAnswer(true); } catch { /* an attacker cannot conceal the failed control */ }
      return [await t.submit({ callId: "c", raw: "{}" })];
    }), target);
    expect(observation.leakFindings).toContain("runner-error:$");
    expect(JSON.stringify(observation)).not.toContain("CONTROL_SECRET");
  });
  it("captures nonempty planted names from the world before running; scenario-added names cannot erase them", async () => {
    const target = Object.assign(targetFor(), { foreignDisplayNames: ["WORLD_CANARY"] });
    const scenario = { ...trivialScenario(), async run(t: CapabilityTraits) {
      await (t as ScenarioTarget).submit({ callId: "c", raw: "{}" });
      return { feedback: [], executorCalls: 0, auditEvents: [], leakFindings: [], foreignDisplayNames: [] };
    } };
    const result = await runScenario(scenario, target);
    expect((result as typeof result & { foreignDisplayNames: readonly string[] }).foreignDisplayNames).toEqual(["WORLD_CANARY"]);
    const empty = await runScenario(scenario, Object.assign(targetFor(), { foreignDisplayNames: [] }));
    expect(empty.leakFindings).toContain("runner-error:$");
  });
  it("a control cannot return a live world, function, executor or mutable audit sink", async () => {
    const original = targetFor();
    for (const handle of [original, () => original, original.executor, original.audit]) {
      const target = Object.assign(targetFor(), { validProposal: () => handle });
      const result = await runScenario(driving(async (t) => {
        try { t.validProposal(); } catch { /* the runner retains the failed hand-over */ }
        return [await t.submit({ callId: "c", raw: "{}" })];
      }), target);
      expect(result.leakFindings).toContain("runner-error:$");
    }
  });

});
