/**
 * The runner's decision auditor, called directly with hand-made records, to pin each branch: what it records for each kind of decision,
 * from which facts, and that nothing it does can throw or change the decision.
 */
import { describe, expect, it } from "vitest";
import type { AuditEvent, PolicyDecision, ReasonCode } from "@dap/contracts";
import { createAuditEventFactory } from "../audit/event-factory.js";
import { createAuditWriter } from "../audit/audit-writer.js";
import { chain } from "./chain.test-support.js";
import type { ChainOptions } from "./chain.test-support.js";
import { createDecisionAuditor } from "./decision-auditor.js";
import { allowedDecision, confirmationDecision, denyDecision } from "./decision.js";
import type { PipelineRecord } from "./pipeline.js";
import { context } from "./fixtures.test-support.js";
import { bend, goodFacts, recordOf } from "./stages/stage-facts.test-support.js";
import type { Facts } from "./stages/stage-facts.test-support.js";

function build(options: ChainOptions & { clock?: () => unknown } = {}) {
  const world = chain(options);
  const seen: unknown[] = [];
  const failures: string[] = [];
  const rate: string[] = [];
  const telemetry = { decision: (sample: unknown) => { seen.push(sample); }, auditWriteFailed: (kind: string) => { failures.push(kind); }, rateLimited: (scope: string) => { rate.push(scope); } } as never;
  const clock = options.clock === undefined ? world.deps.clock : { now: options.clock as never };
  const events = createAuditEventFactory({ clock });
  const writer = createAuditWriter({ sink: world.deps.audit, telemetry });
  const auditor = createDecisionAuditor({ registry: world.registry, events, writer, telemetry, registeredActionIds: new Set(["openProject"]) });
  return { world, auditor, seen, failures, rate, facts: () => goodFacts(world) };
}
const deny = (request: PipelineRecord, reason: ReasonCode, outcome: "DENIED" | "UNAUTHORIZED" | "INVALID_ACTION" | "FORBIDDEN_POLICY" | "INVALID_PARAMETERS" = "DENIED", extra: object = {}): PolicyDecision =>
  denyDecision({ decisionId: request.decisionId, requestId: request.requestId, outcome, reason, stage: "authorize", ...extra } as never);
const only = async (world: ReturnType<typeof chain>): Promise<AuditEvent> => { const all = await world.events(); expect(all).toHaveLength(1); return all[0]!; };

describe("proposed", () => {
  it("records the attempted name it is given, for a minted context", async () => {
    const { auditor, world } = build();
    await auditor.proposed(recordOf({}), "openProject");
    expect(await only(world)).toMatchObject({ type: "AI_ACTION_PROPOSED", actionId: "openProject", outcome: null, requestId: "request" });
  });
  it("falls back to the action intake read, and prefers the name it is given", async () => {
    const a = build();
    await a.auditor.proposed(recordOf({ intake: { callId: "c", action: "fromIntake", params: {} } }), undefined);
    expect((await only(a.world)).actionId).toBe("fromIntake");
    const b = build();
    await b.auditor.proposed(recordOf({ intake: { callId: "c", action: "fromIntake", params: {} } }), "given");
    expect((await only(b.world)).actionId).toBe("given");
  });
  it("records no name when there is none, or when intake's action is not text", async () => {
    for (const facts of [{}, { intake: { action: 5 } }, { intake: [] }, { intake: null }]) {
      const { auditor, world } = build();
      await auditor.proposed(recordOf(facts), undefined);
      expect((await only(world)).actionId, JSON.stringify(facts)).toBeNull();
    }
  });
  it("cannot attribute a proposal whose context is not minted: nothing is written and nothing is counted as failed", async () => {
    const { auditor, world, failures } = build();
    await auditor.proposed(recordOf({}, { context: { ...context() } }), "openProject");
    await auditor.proposed(recordOf({}, { context: null }), "openProject");
    expect(world.sinkCalls).toHaveLength(0);
    expect(failures).toEqual([]);
  });
  it("a record that cannot be made is counted, never raised", async () => {
    const { auditor, failures } = build({ clock: () => { throw new Error("CANARY"); } });
    await expect(auditor.proposed(recordOf({}), "x")).resolves.toBeUndefined();
    expect(failures).toEqual(["proposed"]);
  });
  it("is frozen", () => { expect(Object.isFrozen(build().auditor)).toBe(true); });
});

describe("telemetry names only registered actions", () => {
  it("labels an action the registry does not hold as `unknown`", async () => {
    const world = chain();
    const seen: unknown[] = [];
    const auditor = createDecisionAuditor({ registry: world.registry, events: createAuditEventFactory({ clock: world.deps.clock }), writer: createAuditWriter({ sink: world.deps.audit }), telemetry: { decision: (sample) => { seen.push(sample); } }, registeredActionIds: new Set(["someOtherAction"]) });
    const request = recordOf(goodFacts(world));
    await auditor.decided(request, deny(request, "permission_missing", "UNAUTHORIZED"));
    expect(seen).toEqual([{ outcome: "UNAUTHORIZED", reason: "permission_missing", risk: "SAFE", action: "unknown" }]);
  });
});

describe("decided: allowed", () => {
  it("writes nothing (the audit and execute stages wrote their own) and counts the decision", async () => {
    const { auditor, world, seen } = build();
    const request = recordOf(build().facts());
    await auditor.decided(request, allowedDecision({ decisionId: "d", requestId: "request" as never, actionId: "openProject" as never, risk: "HIGH", paramsDigest: "a".repeat(64) as never }));
    expect(world.sinkCalls).toHaveLength(0);
    expect(seen).toEqual([{ outcome: "ALLOWED", reason: "allowed", risk: "HIGH", action: "openProject" }]);
  });
});

describe("decided: confirmation request", () => {
  const id = "55555555-5555-4555-8555-555555555555";
  const decide = (request: PipelineRecord) => confirmationDecision({ decisionId: request.decisionId, requestId: request.requestId, actionId: "openProject" as never, risk: "SAFE", confirmationId: id as never });
  it("records AI_CONFIRMATION_REQUIRED with the decision's own id, pending, the projected parameters, and counts it", async () => {
    const { auditor, world, seen, facts } = build();
    const request = recordOf(facts());
    await auditor.decided(request, decide(request));
    expect(await only(world)).toMatchObject({ type: "AI_CONFIRMATION_REQUIRED", outcome: "REQUIRES_CONFIRMATION", reason: "confirmation_required", confirmationId: id, confirmationState: "pending", actionId: "openProject", risk: "SAFE", paramsView: { "/projectId": "p1", "/note": "[masked]" }, resource: { type: "project", id: "p1" } });
    expect(seen).toEqual([{ outcome: "REQUIRES_CONFIRMATION", reason: "confirmation_required", risk: "SAFE", action: "openProject" }]);
  });
  it("without a minted context it counts but cannot record", async () => {
    const { auditor, world, seen, facts } = build();
    const request = recordOf(facts(), { context: null });
    await auditor.decided(request, decide(request));
    expect(world.sinkCalls).toHaveLength(0);
    expect(seen).toHaveLength(1);
  });
  it("is recorded with no parameters when none were validated yet", async () => {
    const { auditor, world, facts } = build();
    const { validate: _v, authorize: _a, ...early } = facts() as Facts;
    void _v; void _a;
    const request = recordOf(early);
    await auditor.decided(request, decide(request));
    expect(await only(world)).toMatchObject({ paramsView: {}, resource: null });
  });
});

describe("decided: denials", () => {
  it("record the registered action, the risk and the projected parameters once the action is resolved and validated, and a resource only when authorized", async () => {
    const { auditor, world, facts, seen } = build();
    const request = recordOf(facts());
    await auditor.decided(request, deny(request, "permission_missing", "UNAUTHORIZED"));
    expect(await only(world)).toMatchObject({ type: "AI_ACTION_DENIED", outcome: "UNAUTHORIZED", reason: "permission_missing", actionId: "openProject", definitionVersion: 2, risk: "SAFE", paramsView: { "/projectId": "p1", "/note": "[masked]" }, resource: { type: "project", id: "p1" } });
    expect(JSON.stringify(await world.events())).not.toMatch(/Project One|SECRET_NOTE/);
    expect(seen).toEqual([{ outcome: "UNAUTHORIZED", reason: "permission_missing", risk: "SAFE", action: "openProject" }]);
  });

  it("omit parameters until validate has run, and the resource until authorize has", async () => {
    const { auditor, world, facts } = build();
    const { validate: _v, authorize: _a, risk: _r, confirmation: _c, ...resolved } = facts() as Facts;
    void _v; void _a; void _r; void _c;
    const request = recordOf(resolved);
    await auditor.decided(request, deny(request, "tenant_action_disabled"));
    expect(await only(world)).toMatchObject({ actionId: "openProject", risk: "SAFE", paramsView: {}, resource: null });
  });

  it("record a resource only when its type and id are text", async () => {
    for (const resource of [{ type: 5, id: "p1" }, { type: "project", id: 5 }, { id: "p1" }, { type: "project" }]) {
      const { auditor, world, facts } = build();
      const request = recordOf({ ...facts(), authorize: { resource } });
      await auditor.decided(request, deny(request, "permission_missing", "UNAUTHORIZED"));
      expect((await only(world)).resource, JSON.stringify(resource)).toBeNull();
    }
  });

  it("fall back to the attempted name when the facts do not describe a registered action", async () => {
    const bad: Facts[] = [
      { resolve: { id: "openProject", version: 2, risk: "SAFE", definitionHash: "c".repeat(64) } },
      { resolve: { id: 5, version: 2, risk: "SAFE", definitionHash: "c".repeat(64) } },
      { resolve: { id: "openProject", version: "2", risk: "SAFE" } }, { resolve: { id: "openProject", version: 2, risk: 5 } }, { resolve: [] }, { resolve: null },
    ];
    for (const facts of bad) {
      const { auditor, world } = build();
      const request = recordOf(facts);
      await auditor.decided(request, deny(request, "unknown_action", "INVALID_ACTION", { attemptedAction: "named" }));
      expect(await only(world), JSON.stringify(facts)).toMatchObject({ actionId: "named", definitionVersion: null, risk: null, paramsView: {} });
    }
  });

  it("use the real definition hash: a resolved action the registry no longer holds is only an attempted name", async () => {
    const { auditor, world, facts } = build();
    const request = recordOf(bend(facts(), "resolve", { definitionHash: "c".repeat(64) }));
    await auditor.decided(request, deny(request, "dependency_failure"));
    expect(await only(world)).toMatchObject({ actionId: "openProject", definitionVersion: null, risk: null });
  });

  it("take the name from intake when the decision has none, and prefer the decision's", async () => {
    const a = build();
    const requestA = recordOf({ intake: { callId: "c", action: "fromIntake", params: {} } });
    await a.auditor.decided(requestA, deny(requestA, "dependency_failure"));
    expect((await only(a.world)).actionId).toBe("fromIntake");
    const b = build();
    const requestB = recordOf({ intake: { callId: "c", action: "fromIntake", params: {} } });
    await b.auditor.decided(requestB, deny(requestB, "dependency_failure", "DENIED", { attemptedAction: "fromDecision" }));
    expect((await only(b.world)).actionId).toBe("fromDecision");
  });

  it("an attempted name that is not text is ignored", async () => {
    const { auditor, world } = build();
    const request = recordOf({});
    await auditor.decided(request, { ...deny(request, "dependency_failure"), attemptedAction: 5 } as never);
    expect((await only(world)).actionId).toBeNull();
  });

  it("without a minted context they are counted but not recorded", async () => {
    const { auditor, world, seen } = build();
    const request = recordOf({}, { context: null });
    await auditor.decided(request, deny(request, "unauthenticated", "UNAUTHORIZED"));
    expect(world.sinkCalls).toHaveLength(0);
    expect(seen).toHaveLength(1);
  });

  it("a forbidden policy outcome is AI_POLICY_VIOLATION", async () => {
    const { auditor, world } = build();
    const request = recordOf({});
    await auditor.decided(request, deny(request, "reserved_forbidden_action", "FORBIDDEN_POLICY", { attemptedAction: "executeShell" }));
    expect(await only(world)).toMatchObject({ type: "AI_POLICY_VIOLATION", outcome: "FORBIDDEN_POLICY", actionId: "executeShell" });
  });
});

describe("decided: rate limits", () => {
  it.each([["rate_limited_turn", "turn"], ["rate_limited_user", "user"], ["rate_limited_tenant", "tenant"], ["rate_limited_capability", "capability"], ["rate_limited_risk", "risk"], ["denial_throttle", "throttle"]] as const)(
    "%s is AI_RATE_LIMITED with no parameters and no resource, and counts the `%s` hit", async (reason, scope) => {
      const { auditor, world, rate, facts } = build();
      const request = recordOf(facts());
      await auditor.decided(request, deny(request, reason));
      expect(await only(world)).toMatchObject({ type: "AI_RATE_LIMITED", reason, paramsView: {}, resource: null, actionId: "openProject", risk: "SAFE" });
      expect(rate).toEqual([scope]);
    });

  it("an ordinary denial counts no rate-limit hit", async () => {
    const { auditor, rate, facts } = build();
    const request = recordOf(facts());
    await auditor.decided(request, deny(request, "permission_missing", "UNAUTHORIZED"));
    await auditor.decided(request, deny(request, "replayed_request"));
    expect(rate).toEqual([]);
  });
});

describe("decided: failures never escape", () => {
  it("a record that cannot be made is counted as a decision failure", async () => {
    const { auditor, failures } = build({ clock: () => { throw new Error("CANARY"); } });
    const request = recordOf({});
    await expect(auditor.decided(request, deny(request, "permission_missing", "UNAUTHORIZED"))).resolves.toBeUndefined();
    const other = recordOf({});
    await expect(auditor.decided(other, confirmationDecision({ decisionId: other.decisionId, requestId: other.requestId, actionId: "openProject" as never, risk: "SAFE", confirmationId: "55555555-5555-4555-8555-555555555555" as never }))).resolves.toBeUndefined();
    expect(failures).toEqual(["decision", "decision"]);
  });
  it("a decision that cannot even be read does not throw", async () => {
    const { auditor } = build();
    await expect(auditor.decided(recordOf({}), { get outcome(): never { throw new Error("CANARY"); } } as never)).resolves.toBeUndefined();
  });
  it("a sink that fails is counted once, by the writer", async () => {
    const { auditor, world, failures } = build();
    world.faults.all = true;
    const request = recordOf({});
    await auditor.decided(request, deny(request, "permission_missing", "UNAUTHORIZED"));
    expect(failures).toEqual(["decision"]);
  });
});
