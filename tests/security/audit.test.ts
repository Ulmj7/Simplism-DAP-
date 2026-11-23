/**
 * T081, ATK-AUDIT-01..05 and 07. Each oracle is proven able to FAIL: a good observation passes, and each violation is reported.
 * Representative real-chain proof lives in review-fixes.test.ts and integration/audit-postgres.test.ts; the scenarios run against the real Gateway at the bottom (T071).
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assemble } from "../../packages/security/src/gateway/create-gateway.js";
import { createPipeline } from "../../packages/security/src/gateway/pipeline.js";
import { buildAuditEvent } from "../../packages/security/src/audit/event-builder.js";
import type { AuditEvent, AuditEventType } from "@dap/contracts";
import { createPolicyGateway } from "@dap/security";
import { ALICE, WIDE_GATEWAY_CONFIG, auditScenarios, verifyProjection, withGateway } from "@dap/testkit";
import type { AuditObservation, WorldUser } from "@dap/testkit";

const scenario = (id: string) => auditScenarios.find((entry) => entry.id === id)!;
const event = (over: Partial<AuditEvent>): AuditEvent => ({ id: "e", occurredAt: "2026-01-01T00:00:00Z", type: "AI_ACTION_PROPOSED", requestId: "r1", decisionId: "r1", tenantId: "t", userId: "u", aiSessionId: "s", turnId: "n", model: "m", actionId: null, definitionVersion: null, paramsView: {}, risk: null, outcome: null, reason: null, confirmationId: null, confirmationState: null, executionResult: null, resource: null, ...over }) as AuditEvent;
let counter = 0;
const e = (over: Partial<AuditEvent>) => event({ id: `e${++counter}`, ...over });
const obs = (over: Partial<AuditObservation>): AuditObservation => ({ feedback: [], executorCalls: 0, auditEvents: [], leakFindings: [], auditWriteFailures: 0, ...over }) as AuditObservation;
const verify = (id: string, o: AuditObservation) => scenario(id).verify(o);

describe("the audit scenarios exist, with their catalogue ids", () => {
  it("lists ATK-AUDIT-01..05 and 07", () => {
    expect(auditScenarios.map((entry) => entry.id)).toEqual(["ATK-AUDIT-01", "ATK-AUDIT-02", "ATK-AUDIT-03", "ATK-AUDIT-04", "ATK-AUDIT-05", "ATK-AUDIT-07"]);
    for (const entry of auditScenarios) expect(entry.category).toBe("audit-failure");
  });
  it("rejects an observation that carries no audit telemetry", () => {
    expect(scenario("ATK-AUDIT-01").verify({ feedback: [], executorCalls: 0, auditEvents: [], leakFindings: [] })).toEqual(["no audit telemetry was observed"]);
  });
});

describe("ATK-AUDIT-01 oracle", () => {
  const good = obs({ feedback: [{ outcome: "DENIED", category: "try_later" }] });
  it("passes a denied, unexecuted proposal", () => expect(verify("ATK-AUDIT-01", good)).toEqual([]));
  it.each([
    ["the executor ran", { executorCalls: 1 }, "executor ran without a durable allow-event"], ["the planner was told ok", { feedback: [{ outcome: "ALLOWED", category: "ok" }] }, "planner was not told to try later"],
    ["the planner was told not_available", { feedback: [{ outcome: "DENIED", category: "not_available" }] }, "planner was not told to try later"], ["two answers", { feedback: [{ outcome: "DENIED", category: "try_later" }, { outcome: "DENIED", category: "try_later" }] }, "planner was not told to try later"],
    ["an allow record exists", { auditEvents: [e({ type: "AI_ACTION_ALLOWED" })] }, "an allow or result record exists although the store failed"], ["a result record exists", { auditEvents: [e({ type: "AI_ACTION_EXECUTED" })] }, "an allow or result record exists although the store failed"],
  ] as const)("reports: %s", (_name, over, message) => expect(verify("ATK-AUDIT-01", { ...good, ...over } as AuditObservation)).toContain(message));
});

describe("ATK-AUDIT-02 oracle", () => {
  const good = obs({ feedback: [{ outcome: "INVALID_ACTION", category: "not_available" }], auditWriteFailures: 1 });
  it("passes a denial that stood and was counted", () => expect(verify("ATK-AUDIT-02", good)).toEqual([]));
  it.each([["the executor ran", { executorCalls: 1 }, "executor ran"], ["the denial changed", { feedback: [{ outcome: "DENIED", category: "try_later" }] }, "the denial changed when its record failed"],
    ["the failure was not counted", { auditWriteFailures: 0 }, "the failed record was not counted"]] as const)("reports: %s", (_name, over, message) => expect(verify("ATK-AUDIT-02", { ...good, ...over } as AuditObservation)).toContain(message));
});

describe("ATK-AUDIT-03 oracle", () => {
  const good = obs({ feedback: [{ outcome: "ALLOWED", category: "ok" }], executorCalls: 1, auditWriteFailures: 1, auditEvents: [e({ type: "AI_ACTION_PROPOSED" }), e({ type: "AI_ACTION_ALLOWED" })] });
  it("passes an executed action whose result record failed", () => expect(verify("ATK-AUDIT-03", good)).toEqual([]));
  it.each([["not executed", { executorCalls: 0 }, "the action did not run exactly once"], ["executed twice", { executorCalls: 2 }, "the action did not run exactly once"],
    ["the planner was told try_later", { feedback: [{ outcome: "ALLOWED", category: "try_later" }] }, "the planner did not see the executed result"], ["not counted", { auditWriteFailures: 0 }, "the failed result record was not counted"],
    ["no allow-event", { auditEvents: [e({ type: "AI_ACTION_PROPOSED" })] }, "the pre-execution allow-event is missing"],
    ["a result record exists", { auditEvents: [e({ type: "AI_ACTION_ALLOWED" }), e({ type: "AI_ACTION_EXECUTED" })] }, "a result record exists although the store failed for it"]] as const)("reports: %s", (_name, over, message) => expect(verify("ATK-AUDIT-03", { ...good, ...over } as AuditObservation)).toContain(message));
});

describe("ATK-AUDIT-04 oracle", () => {
  const group = (request: string, types: AuditEvent["type"][]) => types.map((type) => e({ type, requestId: request, decisionId: request }));
  const five = (...groups: AuditEvent[][]) => obs({ feedback: groups.map(() => ({ outcome: "DENIED", category: "not_available" })), auditEvents: groups.flat() });
  const denied = ["AI_ACTION_PROPOSED", "AI_ACTION_DENIED"] as AuditEvent["type"][];
  const allowed = ["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"] as AuditEvent["type"][];
  it("passes denials and a full allowed path, each tied by its request id", () => expect(verify("ATK-AUDIT-04", five(group("a", denied), group("b", allowed), group("c", ["AI_ACTION_PROPOSED", "AI_POLICY_VIOLATION"])))).toEqual([]));
  it.each([
    ["a proposal with no record at all", five(group("a", denied), [], ), "proposals and request ids do not match one to one"],
    ["no PROPOSED", five(group("a", ["AI_ACTION_DENIED"])), "a: not exactly one PROPOSED, first"],
    ["PROPOSED twice", five(group("a", ["AI_ACTION_PROPOSED", "AI_ACTION_PROPOSED", "AI_ACTION_DENIED"])), "a: not exactly one PROPOSED, first"],
    ["PROPOSED after the decision", five(group("a", ["AI_ACTION_DENIED", "AI_ACTION_PROPOSED"])), "a: not exactly one PROPOSED, first"],
    ["no decision", five(group("a", ["AI_ACTION_PROPOSED"])), "a: not exactly one decision"],
    ["two decisions", five(group("a", ["AI_ACTION_PROPOSED", "AI_ACTION_DENIED", "AI_RATE_LIMITED"])), "a: not exactly one decision"],
    ["a stray record beside a decision", five(group("a", ["AI_ACTION_PROPOSED", "AI_ACTION_DENIED", "AI_ACTION_EXECUTED"])), "a: stray records"],
    ["a result without an allow-event", five(group("a", ["AI_ACTION_PROPOSED", "AI_ACTION_EXECUTED"])), "a: not exactly one decision"],
  ] as const)("reports: %s", (_name, o, message) => expect(verify("ATK-AUDIT-04", o as AuditObservation)).toContain(message));
  it("reports a duplicate event id and records whose identity differs", () => {
    const same = event({ id: "dup", requestId: "a" });
    expect(verify("ATK-AUDIT-04", obs({ feedback: [{ outcome: "DENIED", category: "not_available" }], auditEvents: [same, { ...same, type: "AI_ACTION_DENIED" }] }))).toContain("duplicate event id");
    const mixed = [e({ requestId: "a", userId: "u1" }), e({ requestId: "a", userId: "u2", type: "AI_ACTION_DENIED" })];
    expect(verify("ATK-AUDIT-04", obs({ feedback: [{ outcome: "DENIED", category: "not_available" }], auditEvents: mixed }))).toContain("a: identity differs between records");
  });
});

describe("ATK-AUDIT-05 oracle", () => {
  const fixture = { raw: {}, plain: { "/documentId": "doc-1" }, masked: ["/draft"], canaries: ["UNLISTED_CANARY", "MASKED_CANARY"] };
  const allowed = (view: Record<string, never | string>) => obs({ projection: fixture, auditEvents: [e({ type: "AI_ACTION_ALLOWED", paramsView: view as never })] });
  it("passes exactly the listed plain values and the masked markers", () => expect(verifyProjection(allowed({ "/documentId": "doc-1", "/draft": "[masked]" }), fixture)).toEqual([]));
  it.each([["a masked value recorded", { "/documentId": "doc-1", "/draft": "MASKED_CANARY" }], ["an unlisted value recorded", { "/documentId": "doc-1", "/draft": "[masked]", "/other": "UNLISTED_CANARY" }],
    ["a plain value missing", { "/draft": "[masked]" }], ["a plain value changed", { "/documentId": "doc-2", "/draft": "[masked]" }], ["the masked marker missing", { "/documentId": "doc-1" }]])("reports: %s", (_name, view) => {
    expect(verifyProjection(allowed(view as never), fixture).length).toBeGreaterThan(0);
  });
  it("reports a canary anywhere else in the trail, and a missing or doubled allow-event", () => {
    const leaky = obs({ projection: fixture, auditEvents: [e({ type: "AI_ACTION_ALLOWED", paramsView: { "/documentId": "doc-1", "/draft": "[masked]" } }), e({ type: "AI_ACTION_PROPOSED", actionId: "UNLISTED_CANARY" })] });
    expect(verifyProjection(leaky, fixture)).toContain("an unlisted or masked value reached the audit trail");
    expect(verifyProjection(obs({}), fixture)).toEqual(["expected exactly one allow-event"]);
    expect(verifyProjection(obs({ auditEvents: [e({ type: "AI_ACTION_ALLOWED" }), e({ type: "AI_ACTION_ALLOWED" })] }), fixture)).toEqual(["expected exactly one allow-event"]);
  });
  it("the scenario reports a missing fixture", () => expect(verify("ATK-AUDIT-05", obs({}))).toEqual(["no projection fixture was observed"]));
});

describe("ATK-AUDIT-07: the AI layer has no path to an audit reader (runs now: it is static)", () => {
  it("finds none in the packages/ai manifest or sources", async () => {
    const observation = await scenario("ATK-AUDIT-07").run({} as never);
    expect(scenario("ATK-AUDIT-07").verify(observation)).toEqual([]);
  });
  it("the oracle reports every offender it is handed", () => {
    expect(verify("ATK-AUDIT-07", obs({ leakFindings: ["src/x.ts"] }))).toEqual(["the AI layer reaches an audit reader: src/x.ts"]);
  });
});

const A_ALICE: WorldUser = { tenant: "A", user: ALICE };
const DRAFT_JUSTIFICATION = "Saving a private draft is reversible and visible only to its author, so no separate confirmation is needed.";
const DRAFT_VALUE = "NOTE_CANARY_7f3a";
const UNLISTED_CANARY = "UNLISTED_CANARY_9c1d";

/** The audit attacks' target on the REAL Gateway: a sink the test can make refuse some or all event types, and a count of the refusals. */
function auditTarget() {
  let failing: ReadonlySet<AuditEventType> | "all" = new Set();
  let refusals = 0;
  const world = withGateway({
    config: WIDE_GATEWAY_CONFIG,
    mediumConfirmationJustification: DRAFT_JUSTIFICATION,
    inputSchemas: { testMediumDraft: z.strictObject({ documentId: z.string().min(1).max(64), draft: z.string().min(1).max(4000), unlisted: z.string().max(64).optional() }) },
    auditSink: { append: async (record) => { if (failing === "all" || failing.has(record.type)) { refusals++; throw new Error("audit store unavailable"); } } },
  });
  const target = {
    ...world.targetFor("testSafeEcho", A_ALICE),
    failAudit: (which: "all" | readonly AuditEventType[]) => { failing = which === "all" ? "all" : new Set(which); },
    auditWriteFailures: () => refusals,
    projectionProposal: () => ({
      raw: { action: "testMediumDraft", params: { documentId: "doc-1", draft: `notes ${DRAFT_VALUE}`, unlisted: UNLISTED_CANARY } },
      plain: { "/documentId": "doc-1" }, masked: ["/draft"], canaries: [DRAFT_VALUE, UNLISTED_CANARY],
    }),
  };
  return { world, target };
}

// The REAL Gateway runs ATK-AUDIT-01..05 with the scenarios' own oracles (REQUIRED, representative). ATK-AUDIT-06 (append-only storage) is a PostgreSQL
// property proven by packages/security/src/state/conformance/audit-migration.test.ts; ATK-AUDIT-07 runs above (it is static).
describe("ATK-AUDIT-01..05 against the REAL gateway, through withGateway() (T071, REQUIRED)", () => {
  it.each(["ATK-AUDIT-01", "ATK-AUDIT-02", "ATK-AUDIT-03", "ATK-AUDIT-04", "ATK-AUDIT-05"])("%s: the scenario's own oracle passes on the real chain", async (id) => {
    const { world, target } = auditTarget();
    const observation = await scenario(id).run(target);
    expect(scenario(id).verify(observation)).toEqual([]);
    expect(observation.feedback.length).toBeGreaterThan(0);
    if (id === "ATK-AUDIT-05") expect(world.executor("testMediumDraft").receivedParams).toContainEqual(expect.objectContaining({ unlisted: UNLISTED_CANARY }));
    if (id === "ATK-AUDIT-01") expect(world.executorCalls()).toBe(0); // the same fixture configuration executes with a healthy sink in AUDIT-03 and 04
    if (id === "ATK-AUDIT-03" || id === "ATK-AUDIT-04") expect(world.executorCalls()).toBeGreaterThan(0);
  });
  it("the oracles are not vacuous here: a healthy sink makes ATK-AUDIT-01's expectation false, because the action then runs", async () => {
    const { target } = auditTarget();
    const healthy = { ...target, failAudit: () => undefined };
    const observation = await scenario("ATK-AUDIT-01").run(healthy);
    expect(scenario("ATK-AUDIT-01").verify(observation)).not.toEqual([]);
  });
});


it("the audit builder independently normalizes an empty attempted action to null", async () => {
  const world = withGateway();
  const { context, run } = await world.submitterFor(A_ALICE);
  const record = buildAuditEvent({ type: "AI_ACTION_DENIED", id: randomUUID(), occurredAt: world.deps.clock.now(), requestId: randomUUID(), decisionId: randomUUID(), context, run, action: { kind: "attempted", name: "" }, outcome: "INVALID_ACTION", reason: "malformed_envelope" });
  expect(record.actionId).toBeNull();
});


it.each([['ATK-AUDIT-02', 'decision'], ['ATK-AUDIT-03', 'executed']] as const)("%s reports failed writes through Gateway telemetry, independently of sink refusal counts", async (id, kind) => {
  const { world, target } = auditTarget();
  const failures: string[] = [];
  const { context, run } = await world.submitterFor(A_ALICE);
  const gateway = createPolicyGateway(world.deps, { telemetry: { auditWriteFailed: value => { failures.push(value); } } });
  const submitter = gateway.proposals.forSession(context, run);
  const observation = await scenario(id).run({ ...target, submit: call => submitter.submit(call), auditWriteFailures: () => failures.length });
  expect(scenario(id).verify(observation)).toEqual([]);
  expect(failures).toContain(kind);
});


it("consistent-looking audit facts without an opaque durable receipt cannot reach the REAL execute stage", async () => {
  const world = withGateway();
  const bound = await world.submitterFor(A_ALICE);
  const { stages, auditor } = assemble(world.deps);
  // Simulate an audit-stage regression. All other stages, including execute and its guarded executor, are real.
  stages.audit = request => ({ kind: "continue", data: { eventId: randomUUID(), actionId: "testSafeEcho", version: 1, risk: "SAFE", paramsDigest: (request.facts.validate as { paramsDigest: string }).paramsDigest, confirmationId: null } });
  const requestId = randomUUID();
  const answer = await createPipeline(stages, { audit: auditor }).evaluate({ context: bound.context, run: bound.run, requestId: requestId as never, decisionId: requestId, readProposal: () => world.proposal("testSafeEcho") });
  expect(answer.decision.outcome).toBe("DENIED");
  expect(world.executorCalls()).toBe(0);
  expect(world.events().some(event => event.type === "AI_ACTION_ALLOWED" || event.type === "AI_ACTION_EXECUTED")).toBe(false);
  expect(await world.submit(A_ALICE, world.proposal("testSafeEcho"))).toEqual({ outcome: "ALLOWED", category: "ok" });
  expect(world.executorCalls()).toBe(1);
});
