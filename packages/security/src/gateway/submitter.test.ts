import { describe, expect, it } from "vitest";
import type { IdGenerator, PlannerRunMeta, PolicyDecision, ProposalCall } from "@dap/contracts";
import type { PipelineInput } from "./pipeline.js";
import { createProposalGateway, type DecisionPipeline } from "./submitter.js";
import { allowedDecision, confirmationDecision, denyDecision } from "./decision.js";
import { context, run } from "./fixtures.test-support.js";

const denied = (input: PipelineInput): PolicyDecision => denyDecision({ decisionId: input.decisionId, requestId: input.requestId, outcome: "FORBIDDEN_POLICY", reason: "reserved_forbidden_action", stage: "resolve", attemptedAction: "CANARY_ACTION" });
function harness(answer: (input: PipelineInput) => unknown = denied) {
  const inputs: PipelineInput[] = [];
  let next = 0;
  const idCalls: string[] = [];
  const ids: IdGenerator = { newDecisionId: () => { const id = `decision-${++next}`; idCalls.push(id); return id; }, newConfirmationId: () => { throw new Error("unused"); } };
  const pipeline: DecisionPipeline = { evaluate: evaluating((input) => { inputs.push(input); return answer(input); }) };
  return { gateway: createProposalGateway({ pipeline, ids }), inputs, idCalls };
}
/** The tests below describe decisions; the door now asks the runner for an evaluation. */
const evaluating = (decide: (input: PipelineInput) => unknown) => async (input: PipelineInput) => ({ decision: await decide(input) as PolicyDecision });
const call: ProposalCall = { callId: "call", raw: { action: "viewProject", params: {} } };

describe("proposal door", () => {
  it("returns feedback only: no id, internal reason, stage, attempted name or raw value", async () => {
    const { gateway } = harness();
    const feedback = await gateway.forSession(context(), run).submit({ callId: "CANARY_CALL", raw: "CANARY_RAW" });
    expect(feedback).toEqual({ outcome: "FORBIDDEN_POLICY", category: "not_available" });
    expect(Object.isFrozen(feedback)).toBe(true);
    const text = JSON.stringify(feedback);
    for (const leaked of ["CANARY", "decision-", "reserved", "resolve", "viewProject"]) expect(text).not.toContain(leaked);
  });

  it.each([
    ["confirmation", (input: PipelineInput) => confirmationDecision({ decisionId: input.decisionId, requestId: input.requestId, actionId: "deleteProject" as never, risk: "HIGH", confirmationId: "00000000-0000-4000-8000-000000000009" as never }), { outcome: "REQUIRES_CONFIRMATION", category: "needs_user_confirmation" }, ["00000000", "deleteProject", "HIGH"]],
    ["allowed", (input: PipelineInput) => allowedDecision({ decisionId: input.decisionId, requestId: input.requestId, actionId: "viewProject" as never, risk: "SAFE", paramsDigest: "a".repeat(64) as never }), { outcome: "ALLOWED", category: "ok" }, ["a".repeat(64), "viewProject"]],
  ])("projects a %s decision without its internal fields", async (_name, answer, expected, hidden) => {
    const feedback = await harness(answer).gateway.forSession(context(), run).submit(call);
    expect(feedback).toEqual(expected);
    for (const secret of hidden) expect(JSON.stringify(feedback)).not.toContain(secret);
  });

  it("draws one fresh id per proposal and uses it for both the decision and the request", async () => {
    const { gateway, inputs, idCalls } = harness();
    const submitter = gateway.forSession(context(), run);
    await submitter.submit(call);
    await submitter.submit(call);
    await gateway.forSession(context(), run).submit(call);
    expect(idCalls).toEqual(["decision-1", "decision-2", "decision-3"]);
    expect(inputs.map((input) => [input.decisionId, input.requestId])).toEqual([["decision-1", "decision-1"], ["decision-2", "decision-2"], ["decision-3", "decision-3"]]);
  });

  it("binds the exact minted context and a frozen detached copy of the run metadata", async () => {
    const { gateway, inputs } = harness();
    const ctx = context();
    const metadata: PlannerRunMeta = { ...run };
    const submitter = gateway.forSession(ctx, metadata);
    (metadata as { model: string }).model = "swapped after binding";
    await submitter.submit(call);
    expect(inputs[0]!.context).toBe(ctx);
    expect(inputs[0]!.run).toEqual(run);
    expect(inputs[0]!.run).not.toBe(metadata);
    expect(Object.isFrozen(inputs[0]!.run)).toBe(true);
  });

  it("reads run metadata exactly once however many proposals follow", async () => {
    let reads = 0;
    const { gateway } = harness();
    const submitter = gateway.forSession(context(), { ...run, get model() { reads++; return "model"; } });
    await submitter.submit(call);
    await submitter.submit(call);
    expect(reads).toBe(1);
  });

  it("never touches the proposal itself: the pipeline decides when, and whether, to read it", async () => {
    let reads = 0;
    const hostile = { get callId(): never { reads++; throw new Error("CANARY"); }, get raw(): never { reads++; throw new Error("CANARY"); } };
    const { gateway, inputs } = harness();
    expect(await gateway.forSession(context(), run).submit(hostile)).toEqual({ outcome: "FORBIDDEN_POLICY", category: "not_available" });
    expect(reads).toBe(0);
    expect(inputs[0]!.readProposal()).toBe(hostile);
  });

  it.each([
    ["rejects", () => { throw new Error("CANARY_SECRET"); }], ["returns undefined", () => undefined], ["returns null", () => null], ["returns a bare string", () => "ALLOWED"],
    ["returns an unknown outcome", (input: PipelineInput) => ({ decisionId: input.decisionId, requestId: input.requestId, outcome: "PERMIT", reason: "allowed", stage: "execute" })],
  ])("a pipeline that %s becomes a generic retry, never an allow", async (_name, answer) => {
    const feedback = await harness(answer).gateway.forSession(context(), run).submit(call);
    expect(feedback).toEqual({ outcome: "DENIED", category: "try_later" });
    expect(JSON.stringify(feedback)).not.toContain("CANARY");
  });

  it("a synchronously throwing pipeline is contained", async () => {
    const pipeline = { evaluate: () => { throw new Error("CANARY_SECRET"); } } as unknown as DecisionPipeline;
    const gateway = createProposalGateway({ pipeline, ids: { newDecisionId: () => "decision" } });
    expect(await gateway.forSession(context(), run).submit(call)).toEqual({ outcome: "DENIED", category: "try_later" });
  });

  it.each([undefined, null, 42, "", {}, Promise.resolve("id")])("an unusable decision id %j denies without calling the pipeline", async (id) => {
    let runs = 0;
    const pipeline: DecisionPipeline = { evaluate: async () => { runs++; throw new Error("unreachable"); } };
    const gateway = createProposalGateway({ pipeline, ids: { newDecisionId: () => id as string } });
    expect(await gateway.forSession(context(), run).submit(call)).toEqual({ outcome: "DENIED", category: "try_later" });
    expect(runs).toBe(0);
  });

  it("consumes the rejection of a promise-returning id generator instead of leaking it", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", listener);
    try {
      const pipeline: DecisionPipeline = { evaluate: async () => { throw new Error("unreachable"); } };
      const gateway = createProposalGateway({ pipeline, ids: { newDecisionId: () => Promise.reject(new Error("CANARY")) as never } });
      expect(await gateway.forSession(context(), run).submit(call)).toEqual({ outcome: "DENIED", category: "try_later" });
      for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setImmediate(resolve));
    } finally { process.off("unhandledRejection", listener); }
    expect(unhandled).toEqual([]);
  });

  it("an id generator that throws is contained and reveals nothing", async () => {
    let runs = 0;
    const pipeline: DecisionPipeline = { evaluate: async () => { runs++; throw new Error("unreachable"); } };
    const gateway = createProposalGateway({ pipeline, ids: { newDecisionId: () => { throw new Error("CANARY"); } } });
    const feedback = await gateway.forSession(context(), run).submit(call);
    expect(feedback).toEqual({ outcome: "DENIED", category: "try_later" });
    expect(runs).toBe(0);
  });

  it("unusable run metadata still yields a submitter whose proposals are not decided as if valid", async () => {
    const { gateway, inputs } = harness();
    const cyclic: Record<string, unknown> = { ...run };
    cyclic.self = cyclic;
    const submitter = gateway.forSession(context(), cyclic as unknown as PlannerRunMeta);
    await submitter.submit(call);
    expect(inputs[0]!.run).toBeNull();
  });

  it("keeps concurrent proposals from one submitter independent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inputs: PipelineInput[] = [];
    let next = 0;
    const pipeline: DecisionPipeline = { evaluate: evaluating(async (input) => {
      inputs.push(input);
      if (input.decisionId === "decision-1") await gate;
      return input.decisionId === "decision-1" ? denied(input) : allowedDecision({ decisionId: input.decisionId, requestId: input.requestId, actionId: "viewProject" as never, risk: "SAFE", paramsDigest: "a".repeat(64) as never });
    }) };
    const gateway = createProposalGateway({ pipeline, ids: { newDecisionId: () => `decision-${++next}` } });
    const submitter = gateway.forSession(context(), run);
    const first = submitter.submit(call);
    expect(await submitter.submit(call)).toEqual({ outcome: "ALLOWED", category: "ok" });
    release();
    expect(await first).toEqual({ outcome: "FORBIDDEN_POLICY", category: "not_available" });
    expect(inputs.map((input) => input.decisionId)).toEqual(["decision-1", "decision-2"]);
  });

  it("exposes only frozen doors", () => {
    const { gateway } = harness();
    const submitter = gateway.forSession(context(), run);
    expect(Object.keys(gateway)).toEqual(["forSession"]);
    expect(Object.keys(submitter)).toEqual(["submit"]);
    for (const door of [gateway, gateway.forSession, submitter, submitter.submit]) expect(Object.isFrozen(door)).toBe(true);
  });
});
