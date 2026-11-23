/**
 * T090: ALLOWED is bound. Through the real chain, bend each fact the allow decision rests on (action, version, risk, digest, confirmation
 * id, resource) and the executor stays at zero calls. Pre-ALLOW faults deny; post-ALLOW faults retain the committed policy decision.
 * Also: a pipeline whose stage 7 is absent still fails closed, and the real gateway's telemetry sees the allowed decision.
 */
import { describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "@dap/contracts";
import { chain } from "./chain.test-support.js";
import type { Chain } from "./chain.test-support.js";
import { createPolicyGateway } from "./create-gateway.js";
import type { PipelineRecord, PolicyStage, StageMap } from "./pipeline.js";
import { context, run } from "./fixtures.test-support.js";

const CONFIRMATION = "22222222-2222-4222-8222-222222222222";
const TRY_LATER = { outcome: "DENIED", category: "try_later" };
const submit = (world: Chain, overrides: StageMap) => world.submitter(overrides).submit({ callId: `call-${Math.random()}`, raw: world.text({ projectId: "p1", note: "n" }) });
const types = (events: readonly AuditEvent[]) => events.map((event) => event.type);

/** The real audit stage, with what it publishes bent afterwards: the disagreement appears between stages 8 and 9. */
const tamperedAudit = (world: Chain, patch: Record<string, unknown>): PolicyStage => async (request: PipelineRecord) => {
  const result = await (world.built.stages.audit as PolicyStage)(request);
  return result.kind === "continue" ? { kind: "continue", data: { ...result.data, ...patch } as never } : result;
};

describe("a disagreement seen at stage 9: the allow-event exists, the executor never runs, no result is recorded", () => {
  it.each([
    ["action", { actionId: "otherAction" }], ["version", { version: 7 }], ["risk", { risk: "CRITICAL" }], ["digest", { paramsDigest: "b".repeat(64) }], ["confirmation id", { confirmationId: CONFIRMATION }],
  ])("the recorded %s is not the one validated and resolved", async (_name, patch) => {
    const world = chain();
    const feedback = await submit(world, { audit: tamperedAudit(world, patch) });
    expect(feedback).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(world.executorCalls).toHaveLength(0);
    const events = await world.events();
    expect(types(events)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED"]);
    expect(events[1]).toMatchObject({ outcome: "ALLOWED", actionId: "openProject" });
  });
});

describe("a disagreement seen at stage 8: nothing is recorded as allowed, the executor never runs", () => {
  const stage7 = (data: Record<string, unknown>): PolicyStage => () => ({ kind: "continue", data: data as never });
  it.each([
    ["the risk stage reports another risk", { risk: stage7({ risk: "HIGH", confirmation: "not_required" }) }],
    ["a confirmation the risk stage does not know of", { confirmation: stage7({ state: "accepted", confirmationId: CONFIRMATION }) }],
    ["a risk stage that publishes a field nobody defined", { risk: stage7({ risk: "SAFE", confirmation: "not_required", approved: true }) }],
    ["a confirmation stage that publishes a field nobody defined", { confirmation: stage7({ state: "not_required", confirmationId: null, approved: true }) }],
    ["a risk stage that reports FORBIDDEN", { risk: stage7({ risk: "FORBIDDEN", confirmation: "not_required" }) }],
    ["a risk stage that publishes nothing", { risk: stage7({}) }],
  ])("%s", async (_name, overrides) => {
    const world = chain();
    const feedback = await submit(world, overrides as StageMap);
    expect(feedback).toEqual(TRY_LATER);
    expect(world.executorCalls).toHaveLength(0);
    expect(types(await world.events())).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_DENIED"]);
  });

  it("a different resource than the one validate extracted", async () => {
    const world = chain();
    const authorize: PolicyStage = async (request) => {
      const result = await (world.built.stages.authorize as PolicyStage)(request);
      return result.kind === "continue" ? { kind: "continue", data: { resource: { type: "project", id: "p2", displayName: "Other" } } } : result;
    };
    expect(await submit(world, { authorize })).toEqual(TRY_LATER);
    expect(world.executorCalls).toHaveLength(0);
    expect(types(await world.events())).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_DENIED"]);
  });
});

describe("the untampered chain is the only one that executes", () => {
  it("runs exactly once, with the validated parameters", async () => {
    const world = chain();
    expect(await submit(world, {})).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(world.executorCalls).toHaveLength(1);
    expect(world.executorCalls[0]!.params).toEqual({ projectId: "p1", note: "n" });
  });
});

describe("an absent stage 7 and the real gateway's telemetry", () => {
  it("a pipeline with no risk stage is denied fail-closed at it, records the proposal and the denial, and never executes", async () => {
    const world = chain();
    const feedback = await world.submitter({ risk: undefined as never }).submit({ callId: "c", raw: world.text({ projectId: "p1" }) });
    expect(feedback).toEqual(TRY_LATER);
    expect(world.executorCalls).toHaveLength(0);
    // The chain still ran authorize (permission and resource checks) before it reached the absent stage.
    expect(world.hostCalls).toEqual(["has", "resolve"]);
    const events = await world.events();
    expect(types(events)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_DENIED"]);
    expect(events[1]).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", actionId: "openProject" });
  });

  it("hands decision counts to the host's telemetry and survives a telemetry that throws", async () => {
    const seen: unknown[] = [];
    const world = chain();
    const gateway = createPolicyGateway(world.deps, { telemetry: { decision: (sample) => { seen.push(sample); } } });
    await gateway.proposals.forSession(context(), run).submit({ callId: "c", raw: world.text({ projectId: "p1" }) });
    // The real chain now allows a SAFE capability, so the host's telemetry counts an ALLOWED decision attributed to the resolved action.
    expect(seen).toEqual([{ outcome: "ALLOWED", reason: "allowed", risk: "SAFE", action: "openProject" }]);
    const hostile = createPolicyGateway(world.deps, { telemetry: { decision: () => { throw new Error("CANARY"); } } });
    expect(await hostile.proposals.forSession(context(), run).submit({ callId: "c2", raw: world.text({ projectId: "p1" }) })).toEqual({ outcome: "ALLOWED", category: "ok" });
  });

  it("a sink that fails changes neither the decision nor the executor count", async () => {
    const world = chain();
    world.faults.all = true;
    const feedback = await createPolicyGateway(world.deps).proposals.forSession(context(), run).submit({ callId: "c", raw: world.text({ projectId: "p1" }) });
    expect(feedback).toEqual(TRY_LATER);
    expect(world.executorCalls).toHaveLength(0);
  });
});

describe("how the gateway wires its audit pieces", () => {
  it("reads the host's telemetry once, however many pieces use it", () => {
    const world = chain();
    let reads = 0;
    createPolicyGateway(world.deps, { get telemetry() { reads += 1; return {}; } });
    expect(reads).toBe(1);
  });

  it("counts a result record that could not be dated through the host's telemetry", async () => {
    const failures: string[] = [];
    let reads = 0;
    // Readings: context stage, PROPOSED record, authorize stage, the execution-slot claim, allow-event record, then the result record, which fails.
    const world = chain({ telemetry: { auditWriteFailed: (kind) => { failures.push(kind); } }, clock: () => { reads += 1; if (reads === 6) throw new Error("clock down"); return "2026-01-01T00:00:00Z"; } });
    const feedback = await submit(world, {});
    expect(feedback).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(failures).toEqual(["executed"]);
    expect(world.executorCalls).toHaveLength(1);
  });

  it("gives the clock reads that date records the configured hook timeout", async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      // The allow-event's date never arrives: it must be cut off after hookTimeoutMs, not the 2000 ms default.
      const world = chain({ config: { hookTimeoutMs: 30 }, clock: () => { reads += 1; return reads === 5 ? new Promise(() => {}) : "2026-01-01T00:00:00Z"; } });
      let settled = false;
      const pending = submit(world, {}).then((feedback) => { settled = true; return feedback; });
      await vi.advanceTimersByTimeAsync(29);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual(TRY_LATER);
      expect(world.executorCalls).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });
});
