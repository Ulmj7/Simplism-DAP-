/**
 * T089, stage 8. A durable AI_ACTION_ALLOWED before EVERY execution, SAFE included; no record, no execution.
 */
import { describe, expect, it } from "vitest";
import type { RiskLevel } from "@dap/contracts";
import { createAuditEventFactory } from "../../audit/event-factory.js";
import { createAuditWriter } from "../../audit/audit-writer.js";
import { chain, TENANT } from "../chain.test-support.js";
import type { Chain } from "../chain.test-support.js";
import type { HookTimer } from "../hook-wrapper.js";
import type { PolicyStage } from "../pipeline.js";
import { createAuditStage } from "./audit.js";
import { CONFIRMATION, DIGEST, bend, goodFacts, recordOf, without } from "./stage-facts.test-support.js";
import type { Facts } from "./stage-facts.test-support.js";
import { context } from "../fixtures.test-support.js";

class ManualTimer implements HookTimer {
  time = 0; private next = 0;
  readonly pending = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, ms: number): number { const id = this.next++; this.pending.set(id, { at: this.time + ms, callback }); return id; }
  clearTimeout(handle: unknown): void { this.pending.delete(handle as number); }
  advance(ms: number): void { this.time += ms; for (const [id, entry] of [...this.pending]) if (entry.at <= this.time) { this.pending.delete(id); entry.callback(); } }
}
const ALLOW = { allowed: true } as const;
function build(options: { clock?: () => unknown; timer?: HookTimer; claim?: (input: unknown) => unknown } = {}) {
  const world: Chain = chain();
  const claims: unknown[] = [];
  const limiter = { claimExecution: async (input: unknown) => { claims.push(input); return options.claim === undefined ? ALLOW : options.claim(input); }, recordDenial: async () => ({ recorded: true as const, throttled: false }) };
  const clock = options.clock === undefined ? world.deps.clock : { now: options.clock as never };
  const stage = createAuditStage({
    registry: world.registry, events: createAuditEventFactory({ clock }, options.timer === undefined ? {} : { timer: options.timer }),
    writer: createAuditWriter({ sink: world.deps.audit }, options.timer === undefined ? {} : { timer: options.timer }),
    limiter: limiter as never, executors: world.deps.executors,
  }, options.timer === undefined ? {} : { timer: options.timer }) as PolicyStage;
  return { world, stage, claims };
}
const stopOf = (result: unknown) => result as { kind: string; decision: Record<string, unknown>; data: Record<string, unknown> };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe("a consistent proposal is recorded durably, then continues with the binding it wrote", () => {
  it("writes one AI_ACTION_ALLOWED from trusted facts and publishes facts.audit exactly", async () => {
    const { world, stage } = build();
    const result = stopOf(await stage(recordOf(goodFacts(world))));
    const [event] = await world.events();
    expect(result.kind).toBe("continue");
    expect(result.data).toEqual({ eventId: event!.id, actionId: "openProject", version: 2, risk: "SAFE", paramsDigest: DIGEST, confirmationId: null });
    expect(await world.events()).toHaveLength(1);
    expect(event).toMatchObject({ type: "AI_ACTION_ALLOWED", outcome: "ALLOWED", reason: "allowed", tenantId: TENANT, userId: context().userId, actionId: "openProject", definitionVersion: 2, risk: "SAFE", requestId: "request", decisionId: "decision-request", executionResult: null, confirmationId: null, resource: { type: "project", id: "p1" } });
  });

  it("projects parameters through the capability's allowlist: listed plain, masked masked, the rest absent", async () => {
    const { world, stage } = build();
    await stage(recordOf(goodFacts(world)));
    const [event] = await world.events();
    expect(event!.paramsView).toEqual({ "/projectId": "p1", "/note": "[masked]" });
    expect(JSON.stringify(event)).not.toMatch(/SECRET_NOTE|RAW_NOTE|Project One/);
  });

  it("records the accepted confirmation when there is one", async () => {
    const { world, stage } = build();
    const facts = { ...bend(goodFacts(world, { risk: "HIGH" }), "risk", { confirmation: "accepted" }), confirmation: { state: "accepted", confirmationId: CONFIRMATION } };
    const result = stopOf(await stage(recordOf(facts)));
    expect(result.data.confirmationId).toBe(CONFIRMATION);
    expect((await world.events())[0]).toMatchObject({ confirmationId: CONFIRMATION, confirmationState: "accepted", risk: "HIGH" });
  });

  it("records no resource when the action targets none", async () => {
    const { world, stage } = build();
    await stage(recordOf({ ...bend(goodFacts(world), "validate", { resource: null }), authorize: { resource: null } }));
    expect((await world.events())[0]!.resource).toBeNull();
  });

  it.each(["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as RiskLevel[])("audits a %s action: a failing sink denies, and a working one records it", async (risk) => {
    const confirm = risk === "MEDIUM" || risk === "HIGH" || risk === "CRITICAL";
    const facts = (world: Chain): Facts => (confirm ? { ...bend(goodFacts(world, { risk }), "risk", { confirmation: "accepted" }), confirmation: { state: "accepted", confirmationId: CONFIRMATION } } : goodFacts(world, { risk }));
    const down = build();
    down.world.faults.all = true;
    expect(stopOf(await down.stage(recordOf(facts(down.world)))).decision).toMatchObject({ outcome: "DENIED", reason: "audit_unavailable", stage: "audit" });
    const up = build();
    expect(stopOf(await up.stage(recordOf(facts(up.world)))).kind).toBe("continue");
    expect((await up.world.events())[0]).toMatchObject({ type: "AI_ACTION_ALLOWED", risk });
  });
});

describe("the execution slot (bounded execution, Constitution XV)", () => {
  const denial = (reason: string, limit: string, countsTowardThrottle = false) => ({ allowed: false, outcome: "DENIED", reason, limit, retryAfterSeconds: null, countsTowardThrottle });

  it("claims exactly one slot for the minted scope, session and turn, before anything is written, and then records the allow-event", async () => {
    const { world, stage, claims } = build({ claim: () => { expect(world.sinkCalls).toHaveLength(0); return ALLOW; } });
    const request = recordOf(goodFacts(world));
    const result = stopOf(await stage(request));
    expect(result.kind).toBe("continue");
    expect(claims).toEqual([{ scope: request.context, aiSessionId: request.run.aiSessionId, turnId: request.run.turnId }]);
    expect(world.sinkCalls).toHaveLength(1);
  });

  it.each([["rate_limited_turn", "turn_executions"]])("a refused slot (%s) is the limiter's own denial at the audit stage: nothing is written", async (reason, limit) => {
    const { world, stage, claims } = build({ claim: () => denial(reason, limit) });
    const result = stopOf(await stage(recordOf(goodFacts(world))));
    expect(result.kind).toBe("stop");
    expect(result.decision).toMatchObject({ outcome: "DENIED", reason, stage: "audit" });
    expect(claims).toHaveLength(1);
    expect(world.sinkCalls).toHaveLength(0);
  });

  it.each([
    ["throws", () => { throw new Error("CANARY limiter"); }], ["answers nothing", () => undefined], ["answers a string", () => "yes"], ["answers allowed with extra data", () => ({ allowed: true, extra: 1 })],
    ["answers a denial without a limit", () => ({ allowed: false, outcome: "DENIED", reason: "rate_limited_turn" })], ["answers an unknown reason", () => denial("because", "turn_executions")],
  ])("a limiter that %s is a dependency_failure: nothing is written and nothing runs", async (_name, claim) => {
    const { world, stage } = build({ claim });
    const result = stopOf(await stage(recordOf(goodFacts(world))));
    expect(result.decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "audit" });
    expect(world.sinkCalls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("CANARY");
  });

  it("a limiter that never answers is cut off at the proposal's remaining budget", async () => {
    const timer = new ManualTimer();
    const { world, stage } = build({ timer, claim: () => new Promise(() => {}) });
    const pending = Promise.resolve(stage(recordOf(goodFacts(world), { budget: { remainingMs: () => 50 } })));
    await flush();
    timer.advance(50);
    expect(stopOf(await pending).decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
    expect(world.sinkCalls).toHaveLength(0);
  });

  it("consumes no slot when the facts are not a consistent allowed proposal", async () => {
    const { world, stage, claims } = build();
    const bent = bend(goodFacts(world), "validate", { paramsDigest: "not-a-digest" });
    expect(stopOf(await stage(recordOf(bent))).decision).toMatchObject({ reason: "dependency_failure" });
    expect(stopOf(await stage(recordOf(without(goodFacts(world), "risk")))).decision).toMatchObject({ reason: "dependency_failure" });
    expect(stopOf(await stage(recordOf(goodFacts(world), { context: null }))).decision).toMatchObject({ reason: "dependency_failure" });
    expect(claims).toHaveLength(0);
  });

  it("never refunds: an audit sink that fails after the claim still leaves the slot spent, and a second proposal claims a second one", async () => {
    const { world, stage, claims } = build();
    world.faults.all = true;
    expect(stopOf(await stage(recordOf(goodFacts(world)))).decision).toMatchObject({ reason: "audit_unavailable" });
    expect(claims).toHaveLength(1);
    await stage(recordOf(goodFacts(world)));
    expect(claims).toHaveLength(2);
  });
});

describe("no durable record, no execution", () => {
  const faults: [string, (world: Chain) => void][] = [
    ["a sink that throws", (w) => { w.faults.all = true; }],
    ["a sink that refuses only allow-events", (w) => { w.faults.types.add("AI_ACTION_ALLOWED"); }],
  ];
  it.each(faults)("%s is DENIED / audit_unavailable and publishes no facts", async (_name, fault) => {
    const { world, stage } = build();
    fault(world);
    const result = stopOf(await stage(recordOf(goodFacts(world))));
    expect(result).toMatchObject({ kind: "stop", decision: { outcome: "DENIED", reason: "audit_unavailable", stage: "audit", attemptedAction: "openProject" } });
    expect(result.data).toBeUndefined();
    expect(await world.events()).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("CANARY");
  });

  it("a sink that hangs is audit_unavailable when the hook timeout passes", async () => {
    const timer = new ManualTimer();
    const { world, stage } = build({ timer });
    world.faults.hang = true;
    const pending = stage(recordOf(goodFacts(world)));
    await flush();
    timer.advance(2000);
    expect(stopOf(await pending).decision).toMatchObject({ outcome: "DENIED", reason: "audit_unavailable" });
  });

  it("an exhausted proposal budget is denied before an execution slot can be claimed (dependency_failure), and the sink is never called", async () => {
    const { world, stage, claims } = build();
    const result = stopOf(await stage(recordOf(goodFacts(world), { budget: { remainingMs: () => 0 } })));
    expect(result.decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
    expect(world.sinkCalls).toHaveLength(0);
    expect(claims).toHaveLength(0);
  });

  it.each([["throws", () => { throw new Error("CANARY clock"); }], ["answers the wrong shape", () => "yesterday"], ["answers undefined", () => undefined]])("a clock that %s cannot date the record: audit_unavailable, sink untouched", async (_name, clock) => {
    const { world, stage } = build({ clock });
    const result = stopOf(await stage(recordOf(goodFacts(world))));
    expect(result.decision).toMatchObject({ outcome: "DENIED", reason: "audit_unavailable" });
    expect(world.sinkCalls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("CANARY");
  });

  it("writes before it continues: the record is in the sink when the stage resolves, and only one append is made", async () => {
    const { world, stage } = build();
    await stage(recordOf(goodFacts(world)));
    expect(world.sinkCalls).toHaveLength(1);
    expect(world.sinkCalls[0]!.type).toBe("AI_ACTION_ALLOWED");
  });
});

describe("inconsistent or missing facts are a dependency failure, and nothing is written", () => {
  const refuses = async (make: (facts: Facts) => Facts, over: Record<string, unknown> = {}) => {
    const { world, stage } = build();
    const result = stopOf(await stage(recordOf(make(goodFacts(world)), over)));
    expect(result.decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "audit" });
    expect(world.sinkCalls).toHaveLength(0);
  };
  it.each(["intake", "resolve", "validate", "authorize", "risk", "confirmation"])("a missing %s slot", async (slot) => { await refuses((f) => without(f, slot)); });
  it.each(["intake", "resolve", "validate", "authorize", "risk", "confirmation"])("a %s slot with an undefined field", async (slot) => { await refuses((f) => bend(f, slot, { surprise: 1 })); });
  it("intake read another action than resolve found", async () => { await refuses((f) => bend(f, "intake", { action: "other" })); });
  it("the risk stage reports another risk", async () => { await refuses((f) => bend(f, "risk", { risk: "HIGH" })); });
  it("a FORBIDDEN risk is never audited as allowed", async () => { await refuses((f) => ({ ...bend(f, "resolve", { risk: "FORBIDDEN" }), risk: { risk: "FORBIDDEN", confirmation: "not_required" } })); });
  it("a confirmation that is half there", async () => { await refuses((f) => bend(f, "confirmation", { state: "accepted" })); });
  it("a resource mismatch between validate and authorize", async () => { await refuses((f) => bend(f, "authorize", { resource: { type: "project", id: "p2", displayName: "x" } })); });
  it("an unminted context and a missing context", async () => {
    await refuses((f) => f, { context: { ...context() } });
    await refuses((f) => f, { context: null });
  });
  it("a registry that no longer holds the resolved definition", async () => { await refuses((f) => bend(f, "resolve", { definitionHash: "c".repeat(64) })); });
  it("run metadata the builder refuses cannot be recorded: audit_unavailable, nothing written", async () => {
    const { world, stage } = build();
    const result = stopOf(await stage(recordOf(goodFacts(world), { run: { aiSessionId: "", turnId: "t", model: "m" } })));
    expect(result.decision).toMatchObject({ outcome: "DENIED", reason: "audit_unavailable", stage: "audit" });
    expect(world.sinkCalls).toHaveLength(0);
  });
});
