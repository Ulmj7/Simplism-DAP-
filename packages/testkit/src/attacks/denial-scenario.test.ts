import { describe, expect, it } from "vitest";
import type { AttackObservation, AuditEvent, CapabilityTraits, PlannerFeedback, ProposalCall } from "@dap/contracts";
import { createPolicyGateway } from "@dap/security";
import { dependencies, context, run } from "../../../security/src/gateway/fixtures.test-support.js";
import { InMemoryAuditSink } from "../audit-capture.js";
import { RecordingExecutor } from "../recording-executor.js";
import { runScenario } from "../scenario-runner.js";
import { denialScenario } from "./denial-scenario.js";
import { unknownActionScenarios, lookalikeNames } from "./unknown-action.js";
import { malformedParameterScenarios } from "./malformed-parameters.js";
import { promptInjectionScenarios } from "./prompt-injection.js";
import { ALICE, ctx, TENANT_A } from "../world.js";

const traits: CapabilityTraits = { actionId: "testSafeEcho", risk: "SAFE", changesState: false, targetsResource: false, requiresConfirmation: false };
// Synthetic evidence tests the verifier, never a substitute gateway.
function evidence(feedback: PlannerFeedback = { outcome: "INVALID_ACTION", category: "not_available" }): AttackObservation {
  const proposed: AuditEvent = {
    id: "proposed-0", occurredAt: ctx(TENANT_A, ALICE).authenticatedAt,
    type: "AI_ACTION_PROPOSED", requestId: "request-0" as AuditEvent["requestId"], decisionId: "decision-0",
    tenantId: TENANT_A, userId: ALICE, aiSessionId: "session-0", turnId: "turn-0", model: "scripted",
    actionId: "deleteEverything", definitionVersion: null, paramsView: {}, risk: null,
    outcome: "INVALID_ACTION", reason: "unknown_action", confirmationId: null, confirmationState: null,
    executionResult: null, resource: null,
  };
  return { feedback: [feedback], executorCalls: 0, auditEvents: [proposed, { ...proposed, id: "denied-0", type: "AI_ACTION_DENIED" }], leakFindings: [] };
}
const unknown = unknownActionScenarios[0]!;

describe("denial oracle adversarial regressions", () => {
  it("driver forwards every raw proposal and records actual feedback from the real gateway", async () => {
    const { deps } = dependencies();
    const submitter = createPolicyGateway(deps).proposals.forSession(context(), run);
    const submitted: ProposalCall[] = [];
    const returned: PlannerFeedback[] = [];
    const scenario = unknownActionScenarios[1]!;
    const observation = await runScenario(scenario, {
      ...traits, planner: { script: [] }, executor: new RecordingExecutor({ id: "unused", result: { status: "success" } }),
      audit: new InMemoryAuditSink(), visibleOutput: null,
      async submit(call) {
        submitted.push(call);
        const feedback = await submitter.submit(call);
        returned.push(feedback);
        return feedback;
      },
    });
    expect(submitted).toEqual(scenario.cases(traits).map((item, index) => ({ callId: `ATK-UNKNOWN-02-${index}`, raw: item.raw })));
    expect(observation.feedback).toEqual(returned);
    // This tests transport only; catalogue policy/audit/executor assertions remain explicitly todo.
  });

  it.each([
    { hidden: "ordinary parameter value" }, { permission: "perm.private" },
    { issues: [{ path: "/ordinary-value", code: "invalid" }] },
  ])("rejects feedback with unapproved data %j even without a scanner pattern match", (extra) => {
    expect(unknown.verify(evidence({ outcome: "INVALID_ACTION", category: "not_available", ...extra } as PlannerFeedback))).not.toEqual([]);
  });

  it.each(["actionId", "tenantId", "userId", "decisionId", "aiSessionId", "turnId"] as const)("rejects a decision whose %s differs from its proposal", (field) => {
    const obs = evidence();
    expect(unknown.verify({ ...obs, auditEvents: [obs.auditEvents[0]!, { ...obs.auditEvents[1]!, [field]: "wrong" }] })).not.toEqual([]);
  });

  it("rejects a consistently wrong audited action, not just disagreement within the pair", () => {
    const obs = evidence();
    expect(unknown.verify({ ...obs, auditEvents: obs.auditEvents.map((event) => ({ ...event, actionId: "anotherAction" })) })).not.toEqual([]);
  });

  it("rejects reused event IDs", () => {
    const obs = evidence();
    expect(unknown.verify({ ...obs, auditEvents: [obs.auditEvents[0]!, { ...obs.auditEvents[1]!, id: obs.auditEvents[0]!.id }] })).not.toEqual([]);
  });

  it("reports surplus proposed rows without throwing", () => {
    const obs = evidence();
    const surplus = { ...obs, auditEvents: [...obs.auditEvents, ...obs.auditEvents.map((event) => ({ ...event, id: `extra-${event.id}`, requestId: "extra" as AuditEvent["requestId"] }))] };
    expect(() => unknown.verify(surplus)).not.toThrow();
    expect(unknown.verify(surplus)).not.toEqual([]);
  });

  it("rejects an empty fixture instead of certifying no submissions", () => {
    const empty = denialScenario("empty", "unknown-action", "empty", () => []);
    expect(empty.verify({ feedback: [], executorCalls: 0, auditEvents: [], leakFindings: [] })).not.toEqual([]);
  });

  it("requires the stated required-field issue and rejects value/key echo within issues", () => {
    const scenario = malformedParameterScenarios[0]!;
    const base = evidence({ outcome: "INVALID_PARAMETERS", category: "invalid_input" });
    const obs = { ...base, auditEvents: base.auditEvents.map((event) => ({ ...event, actionId: traits.actionId, outcome: "INVALID_PARAMETERS" as const, reason: "invalid_parameters" as const })) };
    expect(scenario.verify(obs)).not.toEqual([]);
    const valid = { ...obs, feedback: [{ outcome: "INVALID_PARAMETERS", category: "invalid_input", issues: [{ path: "/message", code: "required" }] }] } as const;
    expect(scenario.verify(valid)).toEqual([]);
    for (const issues of [[{ path: "/message", code: "invalid" }], [{ path: "/echoed-value", code: "required" }], [{ path: "/message", code: "required", value: "echoed-value" }]]) {
      expect(scenario.verify({ ...obs, feedback: [{ outcome: "INVALID_PARAMETERS", category: "invalid_input", issues }] as PlannerFeedback[] })).not.toEqual([]);
    }
  });

  it.each(["abc", "foo", "testSafeEcho"])("every look-alike of %s is distinct, including an actual case-only change", (id) => {
    const names = lookalikeNames(id);
    expect(names).not.toContain(id);
    expect(names.some((name) => name !== id && name.toLowerCase() === id.toLowerCase() && /^[a-z][A-Za-z0-9]{2,63}$/.test(name))).toBe(true);
  });

  it("malformed and injection fixtures attack the supplied capability, rather than a hardcoded unknown id", () => {
    const custom = { ...traits, actionId: "customEcho" };
    for (const scenario of [...malformedParameterScenarios, ...promptInjectionScenarios.filter((item) => ["ATK-INJECT-02", "ATK-INJECT-06"].includes(item.id))]) {
      for (const item of scenario.cases(custom)) {
        const raw = typeof item.raw === "string" ? item.raw : JSON.stringify(item.raw);
        expect(raw).toContain(custom.actionId);
        expect(raw).not.toContain('"action":"testSafeEcho"');
      }
    }
  });

  it("verifies against the actual supplied capability traits", () => {
    const scenario = malformedParameterScenarios[0]!;
    const custom = { ...traits, actionId: "customEcho" };
    const base = evidence({ outcome: "INVALID_PARAMETERS", category: "invalid_input", issues: [{ path: "/message", code: "required" }] });
    const obs = { ...base, auditEvents: base.auditEvents.map((event) => ({ ...event, actionId: custom.actionId, outcome: "INVALID_PARAMETERS" as const, reason: "invalid_parameters" as const })) };
    expect(scenario.verify(obs, custom)).toEqual([]);
    expect(scenario.verify(obs, traits)).not.toEqual([]);
  });

  it("regenerates hostile getter/Proxy fixtures with invalid-first, valid-second readings", () => {
    const scenario = malformedParameterScenarios[11]!;
    for (let run = 0; run < 2; run++) {
      for (const item of scenario.cases(traits)) {
        const params = (item.raw as { params: { message: unknown } }).params;
        expect(params.message).toBe(7);
        expect(params.message).toBe("ok");
      }
    }
  });

  it("pins case counts and expected outcomes/reasons independently of the scenario factory", () => {
    const expected = [
      [unknownActionScenarios[0]!, 1, "INVALID_ACTION", "unknown_action"],
      [unknownActionScenarios[1]!, 9, "FORBIDDEN_POLICY", "reserved_forbidden_action"],
      [unknownActionScenarios[4]!, 1, "DENIED", "action_not_enabled"],
      [unknownActionScenarios[5]!, 1, "DENIED", "tenant_action_disabled"],
      ...[1, 3, 1, 1, 4].map((count, index) => [malformedParameterScenarios[index]!, count, "INVALID_PARAMETERS", "invalid_parameters"] as const),
      ...[2, 6, 1].map((count, index) => [malformedParameterScenarios[index + 5]!, count, "INVALID_ACTION", "malformed_envelope"] as const),
      [malformedParameterScenarios[8]!, 1, "INVALID_ACTION", "payload_too_large"],
      ...[3, 10, 2].map((count, index) => [malformedParameterScenarios[index + 9]!, count, "INVALID_PARAMETERS", "invalid_parameters"] as const),
      [malformedParameterScenarios[12]!, 3, "INVALID_ACTION", "malformed_envelope"],
      [promptInjectionScenarios[1]!, 47, "UNAUTHORIZED", "permission_missing"],
      [promptInjectionScenarios[2]!, 46, "INVALID_ACTION", "malformed_envelope"],
      [promptInjectionScenarios[3]!, 230, "INVALID_ACTION", "malformed_envelope"],
    ] as const;
    for (const [scenario, count, outcome, reason] of expected) {
      const inputs = scenario.cases(traits);
      expect(inputs, scenario.id).toHaveLength(count);
      expect(inputs.map((item) => [item.outcome, item.reason]), scenario.id).toEqual(Array.from({ length: count }, () => [outcome, reason]));
    }
    expect(unknownActionScenarios[2]!.cases(traits).map((item) => item.reason)).toEqual(["unknown_action", ...Array<string>(6).fill("malformed_envelope")]);
    expect(unknownActionScenarios[3]!.cases(traits).map((item) => item.reason)).toEqual(["malformed_envelope", "unknown_action", "unknown_action", "unknown_action"]);
    expect(promptInjectionScenarios[0]!.cases(traits).map((item) => [item.outcome, item.reason])).toEqual(Array.from({ length: 46 }, (_, index) => index % 5 === 0 ? ["INVALID_ACTION", "unknown_action"] : ["FORBIDDEN_POLICY", "reserved_forbidden_action"]));
  });
});
