/**
 * T073, ATK-XTENANT-01..04. Runs now: the scenario definitions, every oracle proven able to FAIL with hand-built observations, and the
 * REAL feedback builder from @dap/security: the planner's answer for another tenant's resource, a missing resource and a resource the host
 * returned for the wrong tenant is the same bytes. The scenario runs against the whole chain are `it.todo` with their precise blockers.
 */
import { describe, expect, it } from "vitest";
import type { AttackObservation, AuditEvent, CapabilityTraits, PlannerFeedback, ReasonCode } from "@dap/contracts";
import { denyDecision, toPlannerFeedback } from "@dap/security";
import { ALICE, NOT_AVAILABLE_BYTES, TENANT_A, TENANT_B, TENANT_B_RESOURCES, byteIdentical, WIDE_GATEWAY_CONFIG, crossTenantScenarios, runScenario, validParamsFor, withGateway } from "@dap/testkit";
import type { DenialScenario, WorldUser } from "@dap/testkit";

const scenario = (id: string) => crossTenantScenarios.find((entry) => entry.id === id)!;
const traits = (over: Partial<CapabilityTraits> = {}): CapabilityTraits => ({ actionId: "testMediumDraft", risk: "MEDIUM", changesState: true, targetsResource: true, requiresConfirmation: true, ...over });
const event = (over: Partial<AuditEvent>): AuditEvent => ({ id: "e", occurredAt: "2026-01-01T00:00:00Z", type: "AI_ACTION_DENIED", requestId: "r", decisionId: "r", tenantId: "t", userId: "u", aiSessionId: "s", turnId: "n", model: "m", actionId: null, definitionVersion: null, paramsView: {}, risk: null, outcome: "DENIED", reason: "resource_not_available", confirmationId: null, confirmationState: null, executionResult: null, resource: null, ...over }) as AuditEvent;
const generic: PlannerFeedback = { outcome: "DENIED", category: "not_available" };
const FOREIGN = TENANT_B_RESOURCES.map((resource) => resource.displayName);
const obs = (over: Partial<AttackObservation> & { foreignDisplayNames?: readonly string[] }): AttackObservation => ({ feedback: [generic, generic], executorCalls: 0, auditEvents: [], leakFindings: [], foreignDisplayNames: FOREIGN, ...over }) as AttackObservation;
const decisions = (...reasons: string[]) => reasons.map((reason, index) => event({ id: `d${index}`, reason: reason as ReasonCode }));

it("the canary oracle requires nonempty world expectations, not an empty or malformed list", () => {
  for (const names of [[], [""], [1]]) {
    const observation = obs({ auditEvents: decisions("resource_not_available", "resource_not_available"), foreignDisplayNames: names as never });
    expect(scenario("ATK-XTENANT-01").verify(observation)).toContain("no foreign display names were observed");
  }
});

describe("the scenarios", () => {
  it("are ATK-XTENANT-01..04, in order, of category cross-tenant", () => {
    expect(crossTenantScenarios.map((entry) => entry.id)).toEqual(["ATK-XTENANT-01", "ATK-XTENANT-02", "ATK-XTENANT-03", "ATK-XTENANT-04"]);
    for (const entry of crossTenantScenarios) expect(entry.category).toBe("cross-tenant");
  });
  it("01, 02 and 04 apply only to capabilities that target a resource; 03 applies to every non-forbidden capability", () => {
    for (const id of ["ATK-XTENANT-01", "ATK-XTENANT-02", "ATK-XTENANT-04"]) {
      expect(scenario(id).appliesTo(traits()), id).toBe(true);
      expect(scenario(id).appliesTo(traits({ targetsResource: false })), id).toBe(false);
      expect(scenario(id).appliesTo(traits({ risk: "FORBIDDEN" })), id).toBe(false);
    }
    expect(scenario("ATK-XTENANT-03").appliesTo(traits({ targetsResource: false }))).toBe(true);
    expect(scenario("ATK-XTENANT-03").appliesTo(traits({ risk: "FORBIDDEN" }))).toBe(false);
  });
});

describe("byte-identical feedback, from the real feedback builder", () => {
  const feedbackFor = (reason: ReasonCode, extra: object = {}) => toPlannerFeedback(denyDecision({ decisionId: "d", requestId: "r", outcome: "DENIED", reason, stage: "authorize", ...extra } as never));
  it("is the same bytes for another tenant's resource, a missing resource, a resource the user may not use and a foreign resource the host returned", () => {
    const answers = [feedbackFor("resource_not_available"), feedbackFor("resource_not_available", { attemptedAction: "testMediumDraft" }), feedbackFor("tenant_mismatch"), feedbackFor("tenant_mismatch", { attemptedAction: "other", stage: "authorize" })];
    expect(byteIdentical(answers)).toBe(true);
    for (const answer of answers) expect(JSON.stringify(answer)).toBe(NOT_AVAILABLE_BYTES);
    expect(NOT_AVAILABLE_BYTES).toBe('{"outcome":"DENIED","category":"not_available"}');
  });
  it("does not depend on a canary display name, a tenant id or a resource id carried by the decision", () => {
    const hostile = feedbackFor("tenant_mismatch", { attemptedAction: `${TENANT_B_RESOURCES[0]!.displayName} ${TENANT_B} doc-b-1`, issues: [{ path: "/documentId", code: "invalid" }] });
    expect(JSON.stringify(hostile)).toBe(NOT_AVAILABLE_BYTES);
  });
  it("is NOT the same as an outage, so the planner can tell 'no' from 'try later' without learning why", () => {
    expect(JSON.stringify(feedbackFor("dependency_failure"))).not.toBe(NOT_AVAILABLE_BYTES);
  });
  it("byteIdentical is strict: key order, a differing value, an extra key and an empty list all fail", () => {
    expect(byteIdentical([generic, generic])).toBe(true);
    expect(byteIdentical([generic, { category: "not_available", outcome: "DENIED" } as PlannerFeedback])).toBe(false);
    expect(byteIdentical([generic, { outcome: "DENIED", category: "try_later" }])).toBe(false);
    expect(byteIdentical([generic, { ...generic, issues: [] } as PlannerFeedback])).toBe(false);
    expect(byteIdentical([])).toBe(false);
    expect(byteIdentical([generic])).toBe(true);
  });
});

describe("ATK-XTENANT-01 / 02 oracles", () => {
  for (const id of ["ATK-XTENANT-01", "ATK-XTENANT-02"]) {
    const good = obs({ auditEvents: decisions("resource_not_available", "resource_not_available") });
    describe(id, () => {
      it("passes identical generic feedback, an idle executor and the same internal reason", () => expect(scenario(id).verify(good)).toEqual([]));
      it.each([
        ["the executor ran", { executorCalls: 1 }, "executor ran"], ["a missing answer", { feedback: [generic] }, "submission count mismatch"],
        ["feedback that differs", { feedback: [generic, { outcome: "DENIED", category: "try_later" }] }, "the planner can tell the cases apart: feedback is not byte-identical"],
        ["identical feedback that is not the generic answer", { feedback: [{ outcome: "DENIED", category: "try_later" }, { outcome: "DENIED", category: "try_later" }] }, "feedback is not exactly the generic not-available answer"],
        ["identical feedback with extra detail", { feedback: [{ ...generic, issues: [] }, { ...generic, issues: [] }] }, "feedback is not exactly the generic not-available answer"],
        ["the same keys in another order", { feedback: [{ category: "not_available", outcome: "DENIED" }, { category: "not_available", outcome: "DENIED" }] }, "feedback is not exactly the generic not-available answer"],
        ["another tenant's resource recorded as a mismatch", { auditEvents: decisions("tenant_mismatch", "resource_not_available") }, `audit reasons are ["tenant_mismatch","resource_not_available"], expected ["resource_not_available","resource_not_available"]`],
        ["no decision records", { auditEvents: [] }, `audit reasons are [], expected ["resource_not_available","resource_not_available"]`],
        ["a display name of the other tenant in the trail", { auditEvents: [...decisions("resource_not_available", "resource_not_available"), event({ actionId: FOREIGN[0]! })] }, "another tenant's display name reached this tenant's output"],
        ["a display name of the other tenant in the feedback", { feedback: [{ ...generic, note: FOREIGN[1] } as never, generic] }, "another tenant's display name reached this tenant's output"],
        ["a leak", { leakFindings: ["canary:$"] }, "planner output leaked"],
      ] as const)("reports: %s", (_name, over, message) => expect(scenario(id).verify({ ...good, ...over } as AttackObservation)).toContain(message));
      it("reports an observation that carries no foreign display names", () => {
        const { foreignDisplayNames: _f, ...bare } = good as AttackObservation & { foreignDisplayNames: string[] };
        void _f;
        expect(scenario(id).verify(bare)).toEqual(["no foreign display names were observed"]);
      });
    });
  }
  it("ignores the decision records' order only where the scenario fixes it: other-tenant first, nonexistent second", () => {
    expect(scenario("ATK-XTENANT-01").verify(obs({ auditEvents: decisions("resource_not_available", "resource_not_available") }))).toEqual([]);
  });
  it("only decisions count, not the PROPOSED records between them", () => {
    const proposed = event({ type: "AI_ACTION_PROPOSED", reason: null, outcome: null });
    expect(scenario("ATK-XTENANT-01").verify(obs({ auditEvents: [proposed, ...decisions("resource_not_available"), proposed, ...decisions("resource_not_available")] }))).toEqual([]);
  });
});

describe("ATK-XTENANT-03 cases (a tenant id in the envelope or the parameters)", () => {
  const cases = (scenario("ATK-XTENANT-03") as DenialScenario).cases(traits());
  it("puts the foreign tenant id in the envelope under four names, expecting a malformed envelope", () => {
    const envelope = cases.filter((item) => item.reason === "malformed_envelope");
    expect(envelope.map((item) => Object.keys(item.raw as object).filter((key) => !["action", "params"].includes(key))[0])).toEqual(["tenantId", "tenant", "tenant_id", "orgId"]);
    for (const item of envelope) expect(item).toMatchObject({ outcome: "INVALID_ACTION", raw: { action: "testMediumDraft" } });
    for (const item of envelope) expect(Object.values(item.raw as object)).toContain(TENANT_B);
  });
  it("puts it in the parameters under the same four names, expecting an unknown key at the root, audited under the action", () => {
    const params = cases.filter((item) => item.reason === "invalid_parameters");
    expect(params).toHaveLength(4);
    for (const item of params) expect(item).toMatchObject({ outcome: "INVALID_PARAMETERS", issues: [{ path: "", code: "unknown_key" }], auditedAction: "testMediumDraft" });
    expect(params.map((item) => Object.keys((item.raw as { params: object }).params).find((key) => !(key in validParamsFor("testMediumDraft"))))).toEqual(["tenantId", "tenant", "tenant_id", "orgId"]);
    for (const item of params) expect(Object.values((item.raw as { params: object }).params)).toContain(TENANT_B);
  });
  it("keeps the rest of the parameters valid, so only the tenant id can be the cause", () => {
    for (const item of cases.filter((entry) => entry.reason === "invalid_parameters")) {
      const { tenantId: _a, tenant: _b, tenant_id: _c, orgId: _d, ...rest } = (item.raw as { params: Record<string, unknown> }).params;
      void _a; void _b; void _c; void _d;
      expect(rest).toEqual(validParamsFor("testMediumDraft"));
    }
  });
  it("uses the denial oracle: it rejects empty evidence and an execution", () => {
    const empty = { feedback: [], executorCalls: 0, auditEvents: [], leakFindings: [] };
    expect(scenario("ATK-XTENANT-03").verify(empty)).toContain("submission count mismatch");
    expect(scenario("ATK-XTENANT-03").verify({ ...empty, executorCalls: 1 })).toContain("executor ran");
  });
});

describe("ATK-XTENANT-04 oracle (the host returns a resource of another tenant)", () => {
  const good = obs({ auditEvents: decisions("resource_not_available", "tenant_mismatch") });
  it("passes: the same bytes as a missing resource, recorded as a tenant mismatch", () => expect(scenario("ATK-XTENANT-04").verify(good)).toEqual([]));
  it.each([
    ["the mismatch was recorded as an ordinary missing resource", { auditEvents: decisions("resource_not_available", "resource_not_available") }, `audit reasons are ["resource_not_available","resource_not_available"], expected ["resource_not_available","tenant_mismatch"]`],
    ["the baseline was recorded as a mismatch", { auditEvents: decisions("tenant_mismatch", "tenant_mismatch") }, `audit reasons are ["tenant_mismatch","tenant_mismatch"], expected ["resource_not_available","tenant_mismatch"]`],
    ["the planner can tell the mismatch apart", { feedback: [generic, { outcome: "UNAUTHORIZED", category: "not_available" }] }, "the planner can tell the cases apart: feedback is not byte-identical"],
    ["the executor ran", { executorCalls: 1 }, "executor ran"],
    ["the foreign resource's display name surfaced", { feedback: [generic, { ...generic, displayName: FOREIGN[0] } as never] }, "another tenant's display name reached this tenant's output"],
  ] as const)("reports: %s", (_name, over, message) => expect(scenario("ATK-XTENANT-04").verify({ ...good, ...over } as AttackObservation)).toContain(message));
});

/** A scripted target that only RECORDS what a scenario does to the world: it decides nothing, so it is no gateway. */
function scriptedTarget() {
  const log: string[] = [];
  const target = {
    ...traits(), planner: { script: [] }, visibleOutput: undefined, executor: { calls: 0, grantsSeen: 0, receivedParams: [] }, audit: { events: [] }, foreignDisplayNames: FOREIGN,
    resourceProposal: (kind: string) => ({ kind }), foreignResource: () => "FOREIGN", setResourceAnswer: (answer: unknown) => { log.push(`answer:${JSON.stringify(answer)}`); },
    submit: async (call: { callId: string; raw: unknown }) => { log.push(`submit:${call.callId}:${(call.raw as { kind: string }).kind}`); return generic; },
  };
  return { target, log };
}

describe("how the scenarios drive the world (a scripted target that records, not a gateway)", () => {
  it("ATK-XTENANT-01 submits another tenant's resource, then a nonexistent one", async () => {
    const { target, log } = scriptedTarget();
    const observation = await scenario("ATK-XTENANT-01").run(target as never) as AttackObservation & { foreignDisplayNames: string[] };
    expect(log).toEqual(["submit:ATK-XTENANT-01-0:other-tenant", "submit:ATK-XTENANT-01-1:nonexistent"]);
    expect(observation.foreignDisplayNames).toEqual(FOREIGN);
  });
  it("ATK-XTENANT-02 submits a same-tenant unauthorized resource, then another tenant's", async () => {
    const { target, log } = scriptedTarget();
    await scenario("ATK-XTENANT-02").run(target as never);
    expect(log).toEqual(["submit:ATK-XTENANT-02-0:same-tenant-unauthorized", "submit:ATK-XTENANT-02-1:other-tenant"]);
  });
  it("ATK-XTENANT-04 makes the host answer null for the baseline and the foreign resource for the mismatch, each before its own proposal", async () => {
    const { target, log } = scriptedTarget();
    await scenario("ATK-XTENANT-04").run(target as never);
    expect(log).toEqual(["answer:null", "submit:ATK-XTENANT-04-0:nonexistent", 'answer:"FOREIGN"', "submit:ATK-XTENANT-04-1:other-tenant"]);
  });
});

const A_ALICE: WorldUser = { tenant: "A", user: ALICE };
const B_ALICE: WorldUser = { tenant: "B", user: ALICE };
const RESOURCE_CAPABILITIES = ["testMediumDraft", "testHighPublish", "testCriticalDelete"] as const;
const KINDS = ["other-tenant", "nonexistent", "same-tenant-unauthorized"] as const;

describe("the scenarios against the REAL gateway, through withGateway() (T073, REQUIRED: ATK-XTENANT-01..03)", () => {
  describe.each(RESOURCE_CAPABILITIES)("%s", (actionId) => {
    it("ATK-XTENANT-01 runScenario: another tenant's resource and a nonexistent one get the same bytes, recorded as resource_not_available, executor at zero", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const observation = await runScenario(scenario("ATK-XTENANT-01"), world.targetFor(actionId, A_ALICE));
      expect(scenario("ATK-XTENANT-01").verify(observation)).toEqual([]);
      expect(observation.feedback.map((item) => JSON.stringify(item))).toEqual([NOT_AVAILABLE_BYTES, NOT_AVAILABLE_BYTES]);
      expect(world.executorCalls()).toBe(0);
    });
    it("ATK-XTENANT-02 runScenario: a same-tenant resource the user may not use looks exactly like another tenant's", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const observation = await runScenario(scenario("ATK-XTENANT-02"), world.targetFor(actionId, A_ALICE));
      expect(scenario("ATK-XTENANT-02").verify(observation)).toEqual([]);
      expect(world.executorCalls()).toBe(0);
    });
    it("ATK-XTENANT-03 runScenario: a tenant id in the envelope or in the parameters is rejected, executor at zero", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const target = world.targetFor(actionId, A_ALICE);
      const observation = await runScenario(scenario("ATK-XTENANT-03"), target);
      expect((scenario("ATK-XTENANT-03") as DenialScenario).verify(observation, target)).toEqual([]);
      expect(observation.feedback).toHaveLength(8);
      expect(world.executorCalls()).toBe(0);
    });
  });

  it("all three kinds are externally indistinguishable: one submitted set, byte-identical feedback, and the same audit outcome, from either tenant", async () => {
    for (const who of [A_ALICE, B_ALICE]) {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const submitter = await world.submitterFor(who);
      const answers = [];
      for (const kind of KINDS) answers.push(JSON.stringify(await submitter.submit(world.resourceProposal("testMediumDraft", kind, who.tenant))));
      expect(new Set(answers).size, who.tenant).toBe(1);
      expect(answers[0]).toBe(NOT_AVAILABLE_BYTES);
      const decisions = world.events().filter((entry) => entry.type !== "AI_ACTION_PROPOSED");
      expect(decisions.map((entry) => [entry.type, entry.outcome, entry.reason])).toEqual(KINDS.map(() => ["AI_ACTION_DENIED", "DENIED", "resource_not_available"]));
      expect(world.executorCalls()).toBe(0);
    }
  });

  it("a resource that does exist for the user is allowed, so the three-way denial is not a world that denies everything", async () => {
    const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
    const alice = await world.submitterFor(A_ALICE);
    // The user's own document resolves: the HIGH capability gets past resolve and authorize and reaches the confirmation step instead of "not available".
    const answer = await alice.submit(world.proposal("testHighPublish"));
    expect(answer.outcome).toBe("REQUIRES_CONFIRMATION");
    expect(world.executorCalls()).toBe(0);
  });

  it("no foreign display name, resource id or tenant id reaches the planner or the audit events, for every kind and every resource capability", async () => {
    for (const actionId of RESOURCE_CAPABILITIES) for (const who of [A_ALICE, B_ALICE]) {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const target = world.targetFor(actionId, who);
      const foreign = world.foreignDisplayNames(who.tenant);
      const otherTenant = who.tenant === "A" ? TENANT_B : TENANT_A;
      expect(foreign.length).toBeGreaterThan(0);
      const answers = [];
      for (const kind of KINDS) answers.push(await target.submit({ callId: `${actionId}-${kind}`, raw: target.resourceProposal(kind) }));
      // the host returning the other tenant's resource (a buggy host) is recorded as a mismatch, and still shows the planner nothing
      world.setResourceAnswer(target.foreignResource());
      answers.push(await target.submit({ callId: `${actionId}-host`, raw: target.resourceProposal("other-tenant") }));
      const text = JSON.stringify([answers, world.events()]);
      for (const name of foreign) expect(text, `${actionId} ${who.tenant}: ${name}`).not.toContain(name);
      expect(JSON.stringify(answers)).not.toContain(otherTenant);
      expect(new Set(answers.map((item) => JSON.stringify(item))).size).toBe(1);
      expect(world.executorCalls()).toBe(0);
    }
  });

  it("a tenant id supplied in the envelope or the parameters has no effect: the same answer as the call without it, and no foreign data", async () => {
    const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
    const alice = await world.submitterFor(A_ALICE);
    const baseline = JSON.stringify(await alice.submit(world.resourceProposal("testMediumDraft", "other-tenant", "A", "base")));
    const claimed = JSON.stringify(await alice.submit({ callId: "claimed", raw: { action: "testMediumDraft", params: { ...validParamsFor("testMediumDraft"), documentId: "doc-b-1", tenantId: TENANT_B } } }));
    expect(baseline).toBe(NOT_AVAILABLE_BYTES);
    expect(claimed).toBe(JSON.stringify({ outcome: "INVALID_PARAMETERS", category: "invalid_input", issues: [{ path: "", code: "unknown_key" }] }));
    expect(world.executorCalls()).toBe(0);
    // the tenant the context carries is the only one in play: tenant B's own user sees tenant B's document, never tenant A's
    const aliceInB = await world.submitterFor(B_ALICE);
    expect(await aliceInB.submit(world.proposal("testHighPublish"))).toMatchObject({ outcome: "REQUIRES_CONFIRMATION" });
    expect(JSON.stringify(world.events().filter((entry) => entry.tenantId === TENANT_A))).not.toContain(TENANT_B);
  });
});

describe("the remaining scenarios against the end-to-end chain (OPTIONAL in M1)", () => {
  it.todo("ATK-XTENANT-04 runScenario: a foreign resource returned by the host is a tenant_mismatch, indistinguishable to the planner (OPTIONAL; the control is already proven in test-world.gateway.test.ts)");
  it.todo("ATK-XTENANT-05..10 (OPTIONAL as one catalogue run): store isolation (cross-tenant-store.test.ts, conformance), same callId in two tenants (rate-replay.gateway.test.ts), reviewer queries (integration/audit-postgres.test.ts P3) and display-name canaries (above) are already proven; confirmations (07) need the confirmation service (T096) and rate counters (08) are the limits batch (T108)");
});
