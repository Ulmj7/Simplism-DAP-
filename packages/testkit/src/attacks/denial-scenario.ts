import { isDeepStrictEqual } from "node:util";
import type { AttackCategory, AttackObservation, AttackScenario, CapabilityTraits, FeedbackIssue, Outcome, ProposalCall, ReasonCode } from "@dap/contracts";
import type { ScenarioTarget } from "../scenario-runner.js";

/** Inputs are regenerated for each run so hostile getters and Proxies are never reused. */
export interface DenialCase {
  readonly raw: unknown;
  readonly outcome: Outcome;
  readonly reason: ReasonCode;
  readonly issues?: readonly FeedbackIssue[];
  readonly auditedAction?: string;
}
export interface DenialScenario extends AttackScenario {
  readonly cases: (target: CapabilityTraits) => readonly DenialCase[];
  /** Pass the same traits used by run(); the default is the documented testSafeEcho fixture. */
  readonly verify: (observation: AttackObservation, target?: CapabilityTraits) => readonly string[];
}

/**
 * Only submits to the supplied real gateway; this helper makes no policy decisions.
 * Batch fixtures need fresh state and real limiter thresholds above cases(target).length,
 * including the denial throttle. Use runScenario with fixture-value canaries for visibleOutput.
 */
export function denialScenario(id: string, category: AttackCategory, title: string,
  cases: DenialScenario["cases"]): DenialScenario {
  return {
    id, category, title, cases, appliesTo: () => true,
    async run(traits) {
      const target = traits as ScenarioTarget;
      const inputs = cases(target);
      const feedback = [];
      for (const [index, item] of inputs.entries()) {
        const call: ProposalCall = { callId: `${id}-${index}`, raw: item.raw };
        feedback.push(await target.submit(call));
      }
      return { feedback, executorCalls: target.executor.calls, auditEvents: target.audit.events, leakFindings: [] };
    },
    verify(observation: AttackObservation, target = { actionId: "testSafeEcho", risk: "SAFE" as const, changesState: false, targetsResource: false, requiresConfirmation: false }) {
      const violations: string[] = [];
      const expected = cases(target);
      if (expected.length === 0) violations.push("empty attack fixture");
      if (observation.executorCalls !== 0) violations.push("executor ran");
      if (observation.leakFindings.length !== 0) violations.push("planner output leaked");
      if (observation.feedback.length !== expected.length) violations.push("submission count mismatch");
      for (const [index, item] of expected.entries()) {
        const feedback = observation.feedback[index];
        const wanted = { outcome: item.outcome, category: item.outcome === "INVALID_PARAMETERS" ? "invalid_input" : "not_available", ...(item.issues ? { issues: item.issues } : {}) };
        // Pattern scanning alone misses ordinary parameter values and model-authored keys.
        if (!isDeepStrictEqual(feedback, wanted)) violations.push(`decision mismatch at ${index}`);
      }
      const proposed = observation.auditEvents.filter((event) => event.type === "AI_ACTION_PROPOSED");
      if (proposed.length !== expected.length || new Set(proposed.map((event) => event.requestId)).size !== expected.length) violations.push("proposed event count/linkage mismatch");
      if (new Set(observation.auditEvents.map((event) => event.id)).size !== observation.auditEvents.length) violations.push("duplicate audit event id");
      for (const [index, event] of proposed.entries()) {
        const item = expected[index];
        if (!item) continue; // The count violation above already records surplus evidence.
        const decisions = observation.auditEvents.filter((entry) => entry.requestId === event.requestId && entry.type !== "AI_ACTION_PROPOSED");
        if (decisions.length !== 1 || decisions[0]?.outcome !== item.outcome || decisions[0]?.reason !== item.reason || decisions[0]?.type !== (item.outcome === "FORBIDDEN_POLICY" ? "AI_POLICY_VIOLATION" : "AI_ACTION_DENIED")) violations.push(`audit mismatch at ${index}`);
        const decision = decisions[0];
        if (item.auditedAction !== undefined && (event.actionId !== item.auditedAction || decision?.actionId !== item.auditedAction)) violations.push(`audit action mismatch at ${index}`);
        if (decision && ["actionId", "tenantId", "userId", "decisionId", "aiSessionId", "turnId"].some((field) => Reflect.get(decision, field) !== Reflect.get(event, field))) violations.push(`audit identity mismatch at ${index}`);
      }
      if (observation.auditEvents.length !== expected.length * 2) violations.push("unexpected audit events");
      return violations;
    },
  };
}
