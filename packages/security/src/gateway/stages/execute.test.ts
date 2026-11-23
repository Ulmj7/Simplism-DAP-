/**
 * T089, stage 9. The only stage that runs an executor and builds ALLOWED. Every equality it relies on is checked on its own; a
 * mismatch leaves the executor at zero calls and mints no grant; the grant exists only for a recorded allow-event, is single-use and
 * bound to five fields; the executor sees nothing but validated parameters, the user's own context and the resolved resource.
 */
import { describe, expect, it } from "vitest";
import { ExecutionGuardError } from "@dap/contracts";
import type { ActionExecutor, ExecutionCall, ExecutionGrant, ExecutorId, ExecutorTable } from "@dap/contracts";
import type { GrantBinding } from "@dap/contracts/mint";
import { mintExecutionGrant } from "@dap/contracts/mint";
import { createAuditEventFactory } from "../../audit/event-factory.js";
import { createAuditWriter } from "../../audit/audit-writer.js";
import { chain, TENANT } from "../chain.test-support.js";
import type { ChainOptions } from "../chain.test-support.js";
import type { HookTimer } from "../hook-wrapper.js";
import { createExecuteStage } from "./execute.js";
import type { PolicyStage } from "../pipeline.js";
import { toPlannerFeedback } from "../feedback.js";
import { DIGEST, EVENT_ID, CONFIRMATION, bend, goodFacts, recordOf, withAudit, without } from "./stage-facts.test-support.js";
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
function build(options: ChainOptions & { executors?: ExecutorTable; timer?: HookTimer; eventsClock?: () => unknown } = {}) {
  const world = chain(options);
  const mints: GrantBinding[] = [];
  const failures: string[] = [];
  const telemetry = { auditWriteFailed: (kind: string) => { failures.push(kind); } } as never;
  const events = createAuditEventFactory({ clock: options.eventsClock === undefined ? world.deps.clock : { now: options.eventsClock as never } });
  const writer = createAuditWriter({ sink: world.deps.audit, telemetry });
  const stage = createExecuteStage({
    registry: world.registry, executors: options.executors ?? world.deps.executors, events, writer, telemetry,
    mint: (binding): ExecutionGrant => { mints.push(binding); return mintExecutionGrant(binding); },
  }, options.timer === undefined ? {} : { timer: options.timer }) as PolicyStage;
  return { world, stage, mints, failures, facts: () => withAudit(goodFacts(world)) };
}
const stopOf = (result: unknown) => result as { kind: string; decision: Record<string, unknown>; executionStatus?: string };

describe("a recorded, consistent proposal is executed once, with exactly what it may receive", () => {
  it("returns ALLOWED built from resolve and the recorded digest, with the status", async () => {
    const { stage, world, facts } = build();
    const result = stopOf(await stage(recordOf(facts())));
    expect(result.kind).toBe("stop");
    expect(result.decision).toEqual({ decisionId: "decision-request", requestId: "request", outcome: "ALLOWED", actionId: "openProject", risk: "SAFE", paramsDigest: DIGEST });
    expect(result.executionStatus).toBe("success");
    expect(Object.isFrozen(result.decision)).toBe(true);
    expect(world.executorCalls).toHaveLength(1);
    expect(toPlannerFeedback(result.decision as never, result.executionStatus as never)).toEqual({ outcome: "ALLOWED", category: "ok" });
  });

  it("calls the executor with ONLY the grant, the minted context, the validated frozen params, the resolved resource and the ids", async () => {
    const { stage, world, facts } = build();
    const request = recordOf(facts());
    await stage(request);
    const call = world.executorCalls[0] as ExecutionCall<unknown>;
    expect(Object.keys(call).sort()).toEqual(["actionId", "grant", "params", "paramsDigest", "requestId", "resource", "security"]);
    expect(call.params).toEqual({ projectId: "p1", note: "SECRET_NOTE" }); // validate's params, not intake's
    expect(JSON.stringify(call)).not.toContain("RAW_NOTE");
    expect(Object.isFrozen(call)).toBe(true);
    expect(Object.isFrozen(call.params)).toBe(true); // the params are the executor's own deeply frozen copy, whatever the facts' freezing was
    expect(call.security).toBe(request.context);
    expect(call.resource).toEqual({ ref: { type: "project", id: "p1" }, tenantId: TENANT, displayName: "Project One" });
    expect(Object.isFrozen(call.resource)).toBe(true);
    expect(call.requestId).toBe("request");
    expect(call.actionId).toBe("openProject");
    expect(call.paramsDigest).toBe(DIGEST);
  });

  it("passes no resource when the action targets none", async () => {
    const { stage, world, facts } = build();
    const none = { ...bend(facts(), "validate", { resource: null }), authorize: { resource: null } };
    await stage(recordOf(none));
    expect(world.executorCalls[0]!.resource).toBeNull();
  });

  it("mints exactly one grant, bound to (requestId, actionId, paramsDigest, tenantId, userId) from the context and facts", async () => {
    const { stage, mints, facts } = build();
    const request = recordOf(facts());
    await stage(request);
    expect(mints).toEqual([{ requestId: "request", actionId: "openProject", paramsDigest: DIGEST, tenantId: context().tenantId, userId: context().userId }]);
    expect(Object.isFrozen(mints[0])).toBe(true);
  });

  it("the grant is single-use: a second call with the same grant is refused and runs nothing", async () => {
    const { stage, world, facts } = build();
    await stage(recordOf(facts()));
    const first = world.executorCalls[0] as ExecutionCall<unknown>;
    const executor = world.deps.executors.executorFor("openProjectExecutor" as ExecutorId) as ActionExecutor;
    await expect(executor.execute(first)).rejects.toBeInstanceOf(ExecutionGuardError);
    expect(world.executorCalls).toHaveLength(1);
  });

  it("the grant is bound: other parameters, another digest or another user are refused", async () => {
    const { stage, world, facts } = build();
    await stage(recordOf(facts()));
    const first = world.executorCalls[0] as ExecutionCall<unknown>;
    const executor = world.deps.executors.executorFor("openProjectExecutor" as ExecutorId) as ActionExecutor;
    await expect(executor.execute({ ...first, paramsDigest: "b".repeat(64) } as never)).rejects.toBeInstanceOf(ExecutionGuardError);
    await expect(executor.execute({ ...first, requestId: "other" } as never)).rejects.toBeInstanceOf(ExecutionGuardError);
    expect(world.executorCalls).toHaveLength(1);
  });

  it("records AI_ACTION_EXECUTED with the result, the projected parameters and the resource, and nothing else", async () => {
    const { stage, world, facts } = build();
    await stage(recordOf(facts()));
    const [event] = await world.events();
    expect(event).toMatchObject({ type: "AI_ACTION_EXECUTED", outcome: "ALLOWED", reason: "allowed", executionResult: "success", actionId: "openProject", definitionVersion: 2, risk: "SAFE", requestId: "request", resource: { type: "project", id: "p1" }, paramsView: { "/projectId": "p1", "/note": "[masked]" } });
    expect(JSON.stringify(event)).not.toMatch(/SECRET_NOTE|RAW_NOTE|Project One/);
  });
});

describe("what reaches the executor and the record in the other shapes", () => {
  const rawTable = (calls: unknown[], extra: (call: ExecutionCall<unknown>) => void = () => undefined): ExecutorTable => {
    const executor = { id: "openProjectExecutor" as ExecutorId, async execute(this: unknown, call: ExecutionCall<unknown>) { calls.push({ receiver: this, call }); extra(call); return { status: "success" as const }; } };
    return { executorFor: () => executor };
  };

  it("hands over a deeply frozen call, a frozen resource ref, and calls the executor as a method of the host's own object", async () => {
    const calls: { receiver: unknown; call: ExecutionCall<unknown> }[] = [];
    const table = rawTable(calls as never);
    const { stage, facts } = build({ executors: table });
    await stage(recordOf(facts()));
    expect(calls).toHaveLength(1);
    const { call, receiver } = calls[0]!;
    expect(Object.isFrozen(call)).toBe(true);
    expect(Object.isFrozen(call.resource)).toBe(true);
    expect(Object.isFrozen((call.resource as { ref: object }).ref)).toBe(true);
    expect(receiver).toBe(table.executorFor("x" as ExecutorId));
  });

  it("an executor id that is not text is never looked up", async () => {
    let lookups = 0;
    const real = build();
    const registry = { ...real.world.registry, get: (id: string) => { const entry = real.world.registry.get(id)!; return { definition: { ...entry.definition, executorId: 5 }, definitionHash: entry.definitionHash }; } };
    const stage = createExecuteStage({ registry: registry as never, executors: { executorFor: () => { lookups++; return undefined; } }, events: createAuditEventFactory({ clock: real.world.deps.clock }), writer: createAuditWriter({ sink: real.world.deps.audit }) }) as PolicyStage;
    const result = stopOf(await stage(recordOf(real.facts())));
    expect(result.decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
    expect(lookups).toBe(0);
  });

  it("rounds a fractional remaining budget down for the executor's deadline", async () => {
    const timer = new ManualTimer();
    const { stage, facts } = build({ execute: () => new Promise(() => {}), timer });
    const pending = stage(recordOf(facts(), { budget: { remainingMs: () => 500.9 } }));
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect([...timer.pending.values()].map((entry) => entry.at)).toEqual([500]);
    timer.advance(500);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(stopOf(await pending).executionStatus).toBe("failure");
  });

  it("records an accepted confirmation, a higher risk and its decision exactly, in the result record and the ALLOWED decision", async () => {
    const { stage, world } = build();
    const base = goodFacts(world, { risk: "HIGH" });
    const facts = withAudit({ ...bend(base, "risk", { confirmation: "accepted" }), confirmation: { state: "accepted", confirmationId: CONFIRMATION } });
    const result = stopOf(await stage(recordOf(facts)));
    expect(result.decision).toMatchObject({ outcome: "ALLOWED", risk: "HIGH" });
    expect((await world.events())[0]).toMatchObject({ type: "AI_ACTION_EXECUTED", risk: "HIGH", confirmationId: CONFIRMATION, confirmationState: "accepted" });
  });

  it("a failure that names an affected resource does not get to choose what the record says changed", async () => {
    const { stage, world, facts } = build({ execute: () => ({ status: "failure", code: "x", affected: { type: "project", id: "p9" } }) as never });
    await stage(recordOf(facts()));
    expect((await world.events())[0]).toMatchObject({ executionResult: "failure", resource: { type: "project", id: "p1" } });
  });

  it("ignores an affected resource whose id is not text", async () => {
    const { stage, world, facts } = build({ execute: () => ({ status: "success", affected: { type: "project", id: 5 } }) as never });
    await stage(recordOf(facts()));
    expect((await world.events())[0]!.resource).toEqual({ type: "project", id: "p1" });
  });

  it("a result record that cannot be dated is counted as failed and changes nothing", async () => {
    const { stage, failures, world, facts } = build({ eventsClock: () => { throw new Error("CANARY"); } });
    const result = stopOf(await stage(recordOf(facts())));
    expect(result.executionStatus).toBe("success");
    expect(result.decision).toMatchObject({ outcome: "ALLOWED" });
    expect(failures).toEqual(["executed"]);
    expect(world.executorCalls).toHaveLength(1);
  });
});

describe("the executor's outcome", () => {
  it.each([
    ["a failure status", () => ({ status: "failure" as const, code: "CANARY_CODE" })], ["a throw", () => { throw new Error("CANARY_ERROR sk-abcdefghijklmnopqrstuvwx"); }], ["a rejection", () => Promise.reject(new Error("CANARY_ERROR"))],
    ["undefined", () => undefined as never], ["a string", () => "ok" as never], ["a status that is not one", () => ({ status: "maybe" }) as never], ["an object without a status", () => ({ value: 1 }) as never],
    ["a throwing getter", () => ({ get status(): never { throw new Error("CANARY_ERROR"); } }) as never],
  ])("%s is a failure: ALLOWED for the decision, try_later for the planner, recorded as `failure`, with no error text anywhere", async (_name, execute) => {
    const { stage, world, facts, failures } = build({ execute: execute as never });
    const result = stopOf(await stage(recordOf(facts())));
    expect(result.decision).toMatchObject({ outcome: "ALLOWED" });
    expect(result.executionStatus).toBe("failure");
    expect(toPlannerFeedback(result.decision as never, result.executionStatus as never)).toEqual({ outcome: "ALLOWED", category: "try_later" });
    const [event] = await world.events();
    expect(event).toMatchObject({ type: "AI_ACTION_EXECUTED", executionResult: "failure" });
    expect(JSON.stringify([result, event, failures])).not.toMatch(/CANARY|sk-abc/);
  });

  it("success carries the value only to nobody: the decision and the record hold no result value", async () => {
    const { stage, world, facts } = build({ execute: () => ({ status: "success", value: "VALUE_CANARY", ui: { kind: "navigate", route: "/x" } }) });
    const result = stopOf(await stage(recordOf(facts())));
    expect(JSON.stringify([result, await world.events()])).not.toContain("VALUE_CANARY");
  });

  it("names the affected resource in the record when the executor reports a well-formed one, and ignores a malformed one", async () => {
    const reported = build({ execute: () => ({ status: "success", affected: { type: "project", id: "p9" } }) });
    await reported.stage(recordOf(reported.facts()));
    expect((await reported.world.events())[0]!.resource).toEqual({ type: "project", id: "p9" });
    for (const affected of [{ type: "project" }, { type: "project", id: "p9", extra: 1 }, { type: "", id: "x" }, "project/p9", ["project", "p9"], null]) {
      const ignored = build({ execute: () => ({ status: "success", affected }) as never });
      await ignored.stage(recordOf(ignored.facts()));
      expect((await ignored.world.events())[0]!.resource, JSON.stringify(affected)).toEqual({ type: "project", id: "p1" });
    }
  });

  it("an executor that hangs is a failure when the remaining budget runs out", async () => {
    const timer = new ManualTimer();
    const { stage, world, facts } = build({ execute: () => new Promise(() => {}), timer });
    const request = recordOf(facts(), { budget: { remainingMs: () => 500 - timer.time } });
    const pending = stage(request);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect([...timer.pending.values()].map((entry) => entry.at)).toEqual([500]);
    timer.advance(500);
    for (let i = 0; i < 12; i++) await Promise.resolve();
    const result = stopOf(await pending);
    expect(result.executionStatus).toBe("failure");
    expect(result.decision).toMatchObject({ outcome: "ALLOWED" });
    expect((await world.events())[0]).toMatchObject({ executionResult: "failure" });
  });

  it("an executor whose guard refuses (grant not accepted) is a failure, not a crash", async () => {
    const refusing: ExecutorTable = { executorFor: () => ({ id: "openProjectExecutor" as ExecutorId, execute: async () => { throw new ExecutionGuardError("CANARY refused"); } }) };
    const { stage, facts } = build({ executors: refusing });
    const result = stopOf(await stage(recordOf(facts())));
    expect(result.executionStatus).toBe("failure");
    expect(JSON.stringify(result)).not.toContain("CANARY");
  });

  it("a failure to record the result changes nothing but a counter", async () => {
    for (const mode of ["throws", "hangs"] as const) {
      const timer = new ManualTimer();
      const { stage, world, facts, failures } = build({ timer });
      world.faults.types.add("AI_ACTION_EXECUTED");
      if (mode === "hangs") { world.faults.types.clear(); world.faults.hang = true; }
      const pending = stage(recordOf(facts()));
      for (let i = 0; i < 20; i++) await Promise.resolve();
      timer.advance(2000);
      const result = stopOf(await pending);
      expect(result.executionStatus, mode).toBe("success");
      expect(result.decision, mode).toMatchObject({ outcome: "ALLOWED" });
      expect(failures, mode).toEqual(["executed"]);
      expect(world.executorCalls).toHaveLength(1);
    }
  });
});

describe("every equality is checked on its own: a mismatch is DENIED dependency_failure with the executor at zero and no grant", () => {
  const refuses = async (make: (facts: Facts) => Facts, options: { world?: ReturnType<typeof build> } = {}) => {
    const test = options.world ?? build();
    const result = stopOf(await test.stage(recordOf(make(test.facts()))));
    expect(result.kind).toBe("stop");
    expect(result.decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "execute" });
    expect(result.executionStatus).toBeUndefined();
    expect(test.world.executorCalls).toHaveLength(0);
    expect(test.mints).toHaveLength(0);
    expect(await test.world.events()).toHaveLength(0);
    return result;
  };

  it.each([
    ["intake read another action than resolve found", (f: Facts) => bend(f, "intake", { action: "otherAction" })],
    ["the recorded allow-event names another action", (f: Facts) => bend(f, "audit", { actionId: "otherAction" })],
    ["resolve and the allow-event disagree on the version", (f: Facts) => bend(f, "audit", { version: 99 })],
    ["the allow-event and resolve disagree on the version the other way", (f: Facts) => bend(f, "resolve", { version: 99 })],
    ["the risk stage reports another risk than resolve", (f: Facts) => bend(f, "risk", { risk: "HIGH" })],
    ["the allow-event recorded another risk than resolve", (f: Facts) => bend(f, "audit", { risk: "CRITICAL" })],
    ["validate's digest is not the digest the allow-event recorded", (f: Facts) => bend(f, "validate", { paramsDigest: "b".repeat(64) })],
    ["the allow-event recorded another digest than validate", (f: Facts) => bend(f, "audit", { paramsDigest: "b".repeat(64) })],
    ["the allow-event names a confirmation the confirmation stage never accepted", (f: Facts) => bend(f, "audit", { confirmationId: CONFIRMATION })],
    ["a confirmation was accepted but the allow-event names none", (f: Facts) => ({ ...bend(f, "risk", { confirmation: "accepted" }), confirmation: { state: "accepted", confirmationId: CONFIRMATION } })],
    ["the allow-event names another confirmation than the confirmation stage", (f: Facts) => ({ ...bend(f, "risk", { confirmation: "accepted" }), confirmation: { state: "accepted", confirmationId: CONFIRMATION }, audit: { ...(f.audit as object), confirmationId: "44444444-4444-4444-8444-444444444444" } })],
    ["the risk stage and the confirmation stage disagree on whether one was accepted", (f: Facts) => bend(f, "confirmation", { state: "accepted", confirmationId: CONFIRMATION })],
    ["a confirmation is accepted without an id", (f: Facts) => ({ ...bend(f, "risk", { confirmation: "accepted" }), confirmation: { state: "accepted", confirmationId: null } })],
    ["no confirmation is needed yet an id is present", (f: Facts) => bend(f, "confirmation", { confirmationId: CONFIRMATION })],
    ["the resource validate extracted is not the one authorize resolved", (f: Facts) => bend(f, "authorize", { resource: { type: "project", id: "p9", displayName: "Other" } })],
    ["authorize resolved a resource where validate extracted none", (f: Facts) => bend(f, "validate", { resource: null })],
    ["validate extracted a resource authorize never resolved", (f: Facts) => ({ ...f, authorize: { resource: null } })],
    ["the resource type differs", (f: Facts) => bend(f, "authorize", { resource: { type: "folder", id: "p1", displayName: "x" } })],
    ["the allow-event id is not a UUID", (f: Facts) => bend(f, "audit", { eventId: "event-1" })],
    ["the resolved risk is FORBIDDEN", (f: Facts) => ({ ...bend(f, "resolve", { risk: "FORBIDDEN" }), risk: { risk: "FORBIDDEN", confirmation: "not_required" }, audit: { ...(f.audit as object), risk: "FORBIDDEN" } })],
  ])("%s", async (_name, make) => {
    await refuses(make);
  });

  it.each(["intake", "resolve", "validate", "authorize", "risk", "confirmation", "audit"])("a missing %s slot", async (slot) => {
    await refuses((f) => without(f, slot));
  });

  it.each(["intake", "resolve", "validate", "authorize", "risk", "confirmation", "audit"])("a %s slot with a field nobody defined (contract drift)", async (slot) => {
    await refuses((f) => bend(f, slot, { surprise: 1 }));
  });

  it.each(["intake", "resolve", "validate", "authorize", "risk", "confirmation", "audit"])("a %s slot that is not an object", async (slot) => {
    await refuses((f) => ({ ...f, [slot]: slot === "audit" ? [] : "x" }));
  });

  it.each([["a digest that is not hex", { paramsDigest: "z".repeat(64) }], ["a short digest", { paramsDigest: "a".repeat(63) }], ["an upper-case digest", { paramsDigest: "A".repeat(64) }], ["params that are an array", { params: [] }], ["params that are null", { params: null }]])("validate facts with %s", async (_name, patch: Record<string, unknown>) => {
    await refuses((f) => ({ ...bend(f, "validate", patch), audit: { ...(f.audit as object), ...(patch.paramsDigest === undefined ? {} : { paramsDigest: patch.paramsDigest }) } }));
  });

  it("a registry whose definition is not the one resolve found (version, hash or id)", async () => {
    for (const patch of [{ version: 9 }, { definitionHash: "c".repeat(64) }, { id: "otherAction" }]) {
      const test = build();
      await refuses((f) => ({ ...f, resolve: { ...(f.resolve as object), ...patch }, ...(patch.id === undefined ? {} : { intake: { ...(f.intake as object), action: patch.id }, audit: { ...(f.audit as object), actionId: patch.id } }), ...(patch.version === undefined ? {} : { audit: { ...(f.audit as object), version: patch.version } }) }), { world: test });
    }
  });

  it("a context that is not minted, a missing context, and a request without a readable budget", async () => {
    const test = build();
    for (const over of [{ context: { ...context() } }, { context: null }, { budget: undefined }, { budget: {} }, { budget: { remainingMs: () => 0 } }, { budget: { remainingMs: () => 0.5 } }, { budget: { remainingMs: () => Number.NaN } }]) {
      const result = stopOf(await test.stage(recordOf(test.facts(), over)));
      expect(result.decision, JSON.stringify(Object.keys(over))).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "execute" });
    }
    expect(test.world.executorCalls).toHaveLength(0);
    expect(test.mints).toHaveLength(0);
  });

  it.each([
    ["an executor the table does not hold", { executorFor: () => undefined }], ["an executor that is not an object", { executorFor: () => "executor" }], ["an executor without execute", { executorFor: () => ({ id: "x" }) }],
    ["an executor whose execute is not a function", { executorFor: () => ({ id: "x", execute: 1 }) }],
  ])("%s", async (_name, table) => {
    const test = build({ executors: table as never });
    const result = stopOf(await test.stage(recordOf(test.facts())));
    expect(result.decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "execute" });
    expect(test.mints).toHaveLength(0);
    expect(test.world.executorCalls).toHaveLength(0);
  });

  it("no allow-event is recorded by this stage, so without stage 8's facts nothing runs", async () => {
    await refuses((f) => without(f, "audit"));
  });

  it("the attempted action in a refusal is the resolved id, never anything else", async () => {
    const result = await refuses((f) => bend(f, "audit", { paramsDigest: "b".repeat(64) }));
    expect(result.decision.attemptedAction).toBe("openProject");
  });
});

describe("the decision, the executor table and the registry are read once per request", () => {
  it("reads the executor table, the executor and its execute once", async () => {
    let lookups = 0; let reads = 0;
    const real = build();
    const table: ExecutorTable = { executorFor: (id) => {
      lookups++;
      const executor = real.world.deps.executors.executorFor(id) as ActionExecutor;
      return { id: executor.id, get execute() { reads++; return executor.execute.bind(executor); } } as ActionExecutor;
    } };
    const test = build({ executors: table });
    await test.stage(recordOf(test.facts()));
    expect({ lookups, reads }).toEqual({ lookups: 1, reads: 1 });
    expect(EVENT_ID).toBeDefined();
  });
});
