/**
 * The runner's two additions in T089/T090: the execution status that only the execute stage may report, and the audit calls around a
 * proposal (PROPOSED once, then exactly one decision call), none of which can change a decision.
 */
import { describe, expect, it } from "vitest";
import type { PipelineStage, PolicyDecision } from "@dap/contracts";
import { createPipeline } from "./pipeline.js";
import type { DecisionAuditor, PipelineRecord, PolicyStage } from "./pipeline.js";
import { allowedDecision, confirmationDecision, denyDecision } from "./decision.js";
import { chain } from "./chain.test-support.js";
import { input as rawInput, stageMap } from "./fixtures.test-support.js";

const input = () => ({ ...rawInput(), readProposal: () => ({ callId: "evaluate", raw: { action: "openProject", params: { projectId: "p1" } } }) });
const realStages = (status: "success" | "failure" = "success") => { const real = chain({ execute: () => status === "success" ? { status } : { status, code: "test_failure" } }); return { ...real.built.stages, ...real.standIns }; };
async function afterAllow(stage: PolicyStage) {
  const real = chain();
  let entered = 0;
  const result = await createPipeline({ ...real.built.stages, ...real.standIns, execute: request => { entered++; return stage(request); } }).evaluate(input());
  expect(entered).toBe(1);
  expect(result).toMatchObject({ decision: { outcome: "ALLOWED" }, executionStatus: "failure" });
  expect(real.executorCalls).toHaveLength(0);
}
const allow = (request: PipelineRecord) => allowedDecision({ decisionId: request.decisionId, requestId: request.requestId, actionId: "viewProject" as never, risk: "SAFE", paramsDigest: "a".repeat(64) as never });
const executeWith = (status: unknown, decide: (request: PipelineRecord) => PolicyDecision = allow): PolicyStage => (request) => ({ kind: "stop", decision: decide(request), ...(status === undefined ? {} : { executionStatus: status }) }) as never;

describe("evaluate returns execution status only from the real execute checkpoint", () => {
  it.each(["success", "failure"] as const)("execute's `%s` reaches the caller beside the decision", async (status) => {
    const evaluation = await createPipeline(realStages(status)).evaluate(input());
    expect(evaluation.decision).toMatchObject({ outcome: "ALLOWED" });
    expect(evaluation.executionStatus).toBe(status);
    expect(Object.isFrozen(evaluation)).toBe(true);
  });

  it("an unconfirmed fixture and an earlier denial have no execution status", async () => {
    const allowed = await createPipeline(stageMap(executeWith(undefined))).evaluate(input());
    expect(Object.keys(allowed)).toEqual(["decision"]);
    expect(allowed.decision).toMatchObject({ outcome: "DENIED", stage: "execute", reason: "dependency_failure" });
    const stages = stageMap(executeWith(undefined));
    delete stages.authorize;
    const denied = await createPipeline(stages).evaluate(input());
    expect(Object.keys(denied)).toEqual(["decision"]);
    expect(denied.decision).toMatchObject({ outcome: "DENIED", stage: "authorize" });
  });

  it("run() is the decision alone", async () => {
    const pipeline = createPipeline(realStages("failure"));
    expect(await pipeline.run(input())).toMatchObject({ outcome: "ALLOWED" });
    expect(Object.keys(await pipeline.run(input())).includes("executionStatus")).toBe(false);
  });

  it.each(["maybe", "SUCCESS", 1, null, true, {}, ["success"]])("a post-ALLOW execution fixture cannot attest status %j", async (status) => {
    await afterAllow(executeWith(status));
  });

  it("a present undefined status after ALLOW is execution failure", async () => {
    const stage: PolicyStage = (request) => ({ kind: "stop", decision: allow(request), executionStatus: undefined }) as never;
    await afterAllow(stage);
  });

  it.each(["context", "intake", "rate_limit", "replay", "resolve", "validate", "authorize", "risk", "confirmation", "audit"] as PipelineStage[])("%s cannot claim an executor ran, whatever it decides", async (stage) => {
    const stages = stageMap(executeWith(undefined));
    stages[stage] = (request) => ({ kind: "stop", decision: denyDecision({ decisionId: request.decisionId, requestId: request.requestId, outcome: "DENIED", reason: "permission_missing", stage }), executionStatus: "success" }) as never;
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage });
  });

  it("a post-ALLOW execute denial cannot attest execution success", async () => {
    const stage = executeWith("success", (request) => denyDecision({ decisionId: request.decisionId, requestId: request.requestId, outcome: "DENIED", reason: "permission_missing", stage: "execute" }));
    await afterAllow(stage);
  });

  it("a post-ALLOW execute confirmation cannot attest execution success", async () => {
    const stage = executeWith("success", (request) => confirmationDecision({ decisionId: request.decisionId, requestId: request.requestId, actionId: "viewProject" as never, risk: "HIGH", confirmationId: "00000000-0000-4000-8000-000000000009" as never }));
    await afterAllow(stage);
  });

  it("a continue result cannot carry a status", async () => {
    const stages = stageMap(executeWith(undefined));
    stages.resolve = () => ({ kind: "continue", data: {}, executionStatus: "success" }) as never;
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "resolve" });
  });

  it("ALLOWED from any stage but execute is still refused", async () => {
    for (const stage of ["context", "audit", "risk", "confirmation"] as PipelineStage[]) {
      const stages = stageMap(executeWith(undefined));
      stages[stage] = (request) => ({ kind: "stop", decision: allow(request) });
      expect(await createPipeline(stages).run(input()), stage).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage });
    }
  });
});

describe("the runner's audit calls", () => {
  function recorder(options: { throwOn?: "proposed" | "decided" } = {}) {
    const log: { call: string; attempted?: unknown; decision?: PolicyDecision; context?: unknown }[] = [];
    const audit: DecisionAuditor = {
      proposed: async (request, attempted) => { log.push({ call: "proposed", attempted, context: request.context }); if (options.throwOn === "proposed") throw new Error("CANARY"); },
      decided: async (_request, decision) => { log.push({ call: "decided", decision }); if (options.throwOn === "decided") throw new Error("CANARY"); },
    };
    return { log, audit };
  }
  const stagesWith = (overrides: Partial<Record<PipelineStage, PolicyStage>> = {}, status: "success" | "failure" = "success") => ({ ...realStages(status), ...overrides });

  it("records the proposal once, with the intake action name, before the one decision call", async () => {
    const { log, audit } = recorder();
    await createPipeline(stagesWith(), { audit }).evaluate(input());
    expect(log.map((entry) => entry.call)).toEqual(["proposed", "decided"]);
    expect(log[0]!.attempted).toBe("openProject");
    expect(log[1]!.decision).toMatchObject({ outcome: "ALLOWED" });
  });

  it("records the proposal as soon as intake is done, before later stages run", async () => {
    const { log, audit } = recorder();
    const order: string[] = [];
    const stages = stagesWith({ resolve: () => { order.push(`resolve after ${log.map((entry) => entry.call).join(",")}`); return { kind: "continue", data: {} }; } });
    await createPipeline(stages, { audit }).evaluate(input());
    expect(order).toEqual(["resolve after proposed"]);
  });

  it("an intake denial reports the attempted name from the decision", async () => {
    const { log, audit } = recorder();
    const stages = stagesWith({ intake: (request) => ({ kind: "stop", decision: denyDecision({ decisionId: request.decisionId, requestId: request.requestId, outcome: "INVALID_ACTION", reason: "malformed_envelope", stage: "intake", attemptedAction: "bad name" }) }) });
    await createPipeline(stages, { audit }).evaluate(input());
    expect(log.map((entry) => [entry.call, entry.attempted])).toEqual([["proposed", "bad name"], ["decided", undefined]]);
  });

  it("an intake denial with no name reports none", async () => {
    const { log, audit } = recorder();
    const stages = stagesWith({ intake: (request) => ({ kind: "stop", decision: denyDecision({ decisionId: request.decisionId, requestId: request.requestId, outcome: "INVALID_ACTION", reason: "malformed_envelope", stage: "intake" }) }) });
    await createPipeline(stages, { audit }).evaluate(input());
    expect(log[0]).toMatchObject({ call: "proposed", attempted: undefined });
  });

  it("an unminted context is still reported to the auditor (which cannot attribute it): proposed, then decided", async () => {
    const { log, audit } = recorder();
    const evaluation = await createPipeline(stagesWith(), { audit }).evaluate({ ...input(), context: { plain: true } });
    expect(evaluation.decision).toMatchObject({ outcome: "UNAUTHORIZED", reason: "unauthenticated" });
    expect(log.map((entry) => entry.call)).toEqual(["proposed", "decided"]);
    expect(log[0]!.context).toBeNull();
  });

  it("evaluate is frozen, and a stage that returns a stop with data instead of a decision is refused", async () => {
    const pipeline = createPipeline(stagesWith());
    expect(Object.isFrozen(pipeline.evaluate)).toBe(true);
    const stages = stagesWith({ authorize: () => ({ kind: "stop", data: {} }) as never });
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "authorize" });
  });

  it("a denial before intake still records the proposal first (with no name) and then the decision", async () => {
    const { log, audit } = recorder();
    const stages = stagesWith({ context: (request) => ({ kind: "stop", decision: denyDecision({ decisionId: request.decisionId, requestId: request.requestId, outcome: "UNAUTHORIZED", reason: "session_expired", stage: "context" }) }) });
    await createPipeline(stages, { audit }).evaluate(input());
    expect(log.map((entry) => [entry.call, entry.attempted])).toEqual([["proposed", undefined], ["decided", undefined]]);
  });

  it("an absent stage and an exhausted budget are decisions too: each is recorded once", async () => {
    const absent = recorder();
    const stages = stagesWith();
    delete stages.replay;
    await createPipeline(stages, { audit: absent.audit }).evaluate(input());
    expect(absent.log.map((entry) => entry.call)).toEqual(["proposed", "decided"]);
    const spent = recorder();
    await createPipeline(stagesWith(), { audit: spent.audit, timer: { now: () => Number.NaN, setTimeout: () => 0, clearTimeout: () => undefined } }).evaluate(input());
    expect(spent.log.map((entry) => entry.call)).toEqual(["proposed", "decided"]);
  });

  it("an internal error is recorded once", async () => {
    const { log, audit } = recorder();
    const stages = stagesWith({ validate: () => { throw new Error("CANARY"); } });
    const evaluation = await createPipeline(stages, { audit }).evaluate(input());
    expect(evaluation.decision).toMatchObject({ reason: "internal_error", stage: "validate" });
    expect(log.map((entry) => entry.call)).toEqual(["proposed", "decided"]);
  });

  it("the decision it records is the decision it returns", async () => {
    const { log, audit } = recorder();
    const stages = stagesWith({ authorize: (request) => ({ kind: "stop", decision: denyDecision({ decisionId: request.decisionId, requestId: request.requestId, outcome: "UNAUTHORIZED", reason: "permission_missing", stage: "authorize" }) }) });
    const evaluation = await createPipeline(stages, { audit }).evaluate(input());
    expect(log[1]!.decision).toBe(evaluation.decision);
  });

  it.each(["proposed", "decided"] as const)("an auditor that throws in `%s` changes no decision and no status", async (throwOn) => {
    const { audit } = recorder({ throwOn });
    const evaluation = await createPipeline(stagesWith(), { audit }).evaluate(input());
    expect(evaluation).toEqual({ decision: expect.objectContaining({ outcome: "ALLOWED" }), executionStatus: "success" });
    const stages = stagesWith({ authorize: (request) => ({ kind: "stop", decision: denyDecision({ decisionId: request.decisionId, requestId: request.requestId, outcome: "UNAUTHORIZED", reason: "permission_missing", stage: "authorize" }) }) });
    expect((await createPipeline(stages, { audit: recorder({ throwOn }).audit }).evaluate(input())).decision).toMatchObject({ outcome: "UNAUTHORIZED", reason: "permission_missing" });
  });

  it("without a runner auditor the real stages still publish the execution checkpoint", async () => {
    expect((await createPipeline(stagesWith()).evaluate(input())).executionStatus).toBe("success");
  });

  it("the proposal door passes the status to the planner feedback: success is ok, failure is try_later", async () => {
    for (const [status, category] of [["success", "ok"], ["failure", "try_later"]] as const) {
      const { createProposalGateway } = await import("./submitter.js");
      const gateway = createProposalGateway({ pipeline: createPipeline(stagesWith({}, status)), ids: { newDecisionId: () => "decision" } });
      const { context, run } = await import("./fixtures.test-support.js");
      expect(await gateway.forSession(context(), run).submit({ callId: "c", raw: { action: "openProject", params: { projectId: "p1" } } })).toEqual({ outcome: "ALLOWED", category });
    }
  });
});
