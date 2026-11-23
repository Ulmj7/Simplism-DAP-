import { expect } from "vitest";
import type { AttackScenario, AuditEvent, CapabilityTraits, PlannerFeedback } from "@dap/contracts";
import { ALL_TEST_CAPABILITIES, ALICE, ctx, TENANT_A, expectedAuditType, expectedCategory, type Round, type SequenceObservation, type SequenceScenario } from "@dap/testkit";

export const traitsOf = (definition: (typeof ALL_TEST_CAPABILITIES)[number]): CapabilityTraits => ({
  actionId: definition.id, risk: definition.risk, changesState: definition.changesState,
  targetsResource: definition.resource !== undefined, requiresConfirmation: definition.confirmation.kind === "required",
});
export const allTraits: readonly CapabilityTraits[] = ALL_TEST_CAPABILITIES.map(traitsOf);
export const applicable = (scenario: AttackScenario): readonly CapabilityTraits[] => allTraits.filter((traits) => scenario.appliesTo(traits));

const event = (index: number, type: AuditEvent["type"], requestId: string, outcome: AuditEvent["outcome"], reason: AuditEvent["reason"]): AuditEvent => ({
  id: `event-${index}`, occurredAt: ctx(TENANT_A, ALICE).authenticatedAt, type, requestId: requestId as AuditEvent["requestId"], decisionId: `decision-${index}`,
  tenantId: TENANT_A, userId: ALICE, aiSessionId: "session-1", turnId: "turn-1", model: "scripted", actionId: "testSafeEcho", definitionVersion: 1,
  paramsView: {}, risk: "SAFE", outcome, reason, confirmationId: null, confirmationState: null, executionResult: null, resource: null,
});

/** Synthetic, minimal evidence that satisfies the declared rounds; it tests the ORACLE, never a gateway. */
export function perfectObservation(rounds: readonly Round[], sharedStoreCalls?: number): SequenceObservation {
  const feedback: PlannerFeedback[] = []; const auditEvents: AuditEvent[] = [];
  let executorCalls = 0; let next = 0;
  for (const round of rounds) {
    const total = round.submissions.length;
    const mins = round.denials.map((item) => item.min);
    let proceeds = round.proceeds.min;
    const counts = [...mins];
    let spare = total - proceeds - mins.reduce((sum, value) => sum + value, 0);
    for (const [index, item] of round.denials.entries()) { const room = Math.min(spare, item.max - item.min); counts[index] = item.min + room; spare -= room; }
    if (spare > 0) proceeds += spare;
    expect(spare <= 0 || proceeds <= round.proceeds.max).toBe(true);
    if (round.proceeds.as === "ALLOWED") executorCalls += proceeds;
    const events: Array<{ outcome: PlannerFeedback["outcome"]; category: PlannerFeedback["category"]; reason?: AuditEvent["reason"] }> = [];
    for (let index = 0; index < proceeds; index++) events.push(round.proceeds.as === "ALLOWED" ? { outcome: "ALLOWED", category: "ok" } : { outcome: "REQUIRES_CONFIRMATION", category: "needs_user_confirmation" });
    for (const [index, item] of round.denials.entries()) for (let count = 0; count < counts[index]!; count++) events.push({ outcome: item.outcome, category: expectedCategory(item.outcome, item.reason), reason: item.reason });
    for (const item of events) {
      const requestId = `request-${next}`;
      auditEvents.push(event(next++, "AI_ACTION_PROPOSED", requestId, null, null));
      feedback.push({ outcome: item.outcome, category: item.category });
      if (item.reason) auditEvents.push(event(next++, expectedAuditType(item.outcome, item.reason), requestId, item.outcome, item.reason));
    }
  }
  return { feedback, executorCalls, auditEvents, leakFindings: [], ...(sharedStoreCalls === undefined ? {} : { sharedStoreCalls }) };
}

export function expectPerfect(scenario: SequenceScenario, traits: CapabilityTraits): SequenceObservation {
  const budget = scenario.sharedStoreCallBudget?.(traits);
  const observation = perfectObservation(scenario.rounds(traits), budget === undefined ? undefined : 0);
  expect(scenario.verify(observation, traits)).toEqual([]);
  return observation;
}
