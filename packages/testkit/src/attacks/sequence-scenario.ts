import { isDeepStrictEqual } from "node:util";
import type { AttackCategory, AttackObservation, AttackScenario, AuditEvent, CapabilityTraits, Outcome, PlannerFeedback, ProposalCall, ReasonCode } from "@dap/contracts";
import { OUTCOMES } from "@dap/contracts";
import type { InMemoryAuditSink } from "../audit-capture.js";
import { LeakScanner } from "../leak-scanner.js";
import { VALID_PARAMS } from "../test-capabilities/index.js";
import { snapshotData } from "../snapshot.js";

/**
 * Multi-actor attack sequences for replay and rate abuse. A scenario is DATA (rounds of submissions
 * with expectations) plus an independent oracle; it makes no policy decision and simulates no
 * gateway. `run` needs a real harness (SequenceTarget) that binds each Actor to a real Gateway
 * instance and a minted context; without one it fails closed and the oracle reports violations.
 */
export type LimiterFault = "throws" | "hangs" | "wrong_type" | "full_store";

export interface Actor {
  readonly tenant: "A" | "B";
  readonly user: string;
  readonly session: string;
  readonly turn: string;
  /** Which Gateway instance (replica) over the SAME shared state the submission goes through. */
  readonly instance: 1 | 2;
  /** Runner-supplied chain depth for the turn. */
  readonly depth: number;
}
export const actor = (over: Partial<Actor> = {}): Actor => ({ tenant: "A", user: "alice", session: "session-1", turn: "turn-1", instance: 1, depth: 0, ...over });

export interface Submission { readonly actor: Actor; readonly call: ProposalCall }
export interface DenialExpectation { readonly outcome: Outcome; readonly reason: ReasonCode; readonly min: number; readonly max: number }
export interface Round {
  /** Moves the authoritative (database) clock before this round. */
  readonly advanceSecondsBefore?: number;
  /** Injects or clears a limiter fault before this round. */
  readonly fault?: LimiterFault | "none";
  readonly mode?: "sequential" | "parallel";
  readonly submissions: readonly Submission[];
  /** Submissions that pass the limits under test; `as` is what the planner then sees. */
  readonly proceeds: { readonly min: number; readonly max: number; readonly as: "ALLOWED" | "REQUIRES_CONFIRMATION" };
  readonly denials: readonly DenialExpectation[];
}

export interface SequenceTarget extends CapabilityTraits {
  readonly executor: { readonly calls: number };
  readonly audit: InMemoryAuditSink;
  readonly visibleOutput: unknown;
  submitAs(actor: Actor, call: ProposalCall): Promise<PlannerFeedback>;
  advanceSeconds(seconds: number): Promise<void>;
  injectLimiterFault?(fault: LimiterFault | null): Promise<void>;
  /** Calls made to the SHARED store so far (the local per-turn pre-check makes none). */
  readonly sharedStoreCalls?: number;
}
export interface SequenceObservation extends AttackObservation { readonly sharedStoreCalls?: number }

export interface SequenceScenario extends AttackScenario {
  readonly rounds: (traits: CapabilityTraits) => readonly Round[];
  /** Upper bound on shared-store calls for the whole scenario, when the scenario proves bounded cost. */
  readonly sharedStoreCallBudget?: (traits: CapabilityTraits) => number;
  readonly verify: (observation: AttackObservation, traits?: CapabilityTraits) => readonly string[];
}

const DEFAULT_TRAITS: CapabilityTraits = { actionId: "testSafeEcho", risk: "SAFE", changesState: false, targetsResource: false, requiresConfirmation: false };
const tryLater = new Set<string>(["denial_throttle", "dependency_failure", "audit_unavailable", "state_unavailable", "internal_error"]);
const isRateReason = (reason: string): boolean => reason.startsWith("rate_limited_") || reason === "denial_throttle";

/** Independently derived planner category (never the gateway's own projection). */
export function expectedCategory(outcome: Outcome, reason: ReasonCode): PlannerFeedback["category"] {
  if (outcome === "INVALID_PARAMETERS") return "invalid_input";
  return tryLater.has(reason) || reason.startsWith("rate_limited_") ? "try_later" : "not_available";
}
export function expectedAuditType(outcome: Outcome, reason: ReasonCode): "AI_RATE_LIMITED" | "AI_POLICY_VIOLATION" | "AI_ACTION_DENIED" {
  if (isRateReason(reason)) return "AI_RATE_LIMITED";
  return outcome === "FORBIDDEN_POLICY" ? "AI_POLICY_VIOLATION" : "AI_ACTION_DENIED";
}
const proceedFeedback = (as: "ALLOWED" | "REQUIRES_CONFIRMATION"): PlannerFeedback => as === "ALLOWED" ? { outcome: "ALLOWED", category: "ok" } : { outcome: "REQUIRES_CONFIRMATION", category: "needs_user_confirmation" };

/** The valid proposal for the capability under test (the positive path the limits must not block). */
export function validRaw(traits: CapabilityTraits): unknown {
  return { action: traits.actionId, params: Reflect.get(VALID_PARAMS, traits.actionId) ?? {} };
}
/** What a passing proposal looks like for this capability. */
export function proceedsAs(traits: CapabilityTraits): "ALLOWED" | "REQUIRES_CONFIRMATION" {
  return traits.requiresConfirmation || traits.risk === "HIGH" || traits.risk === "CRITICAL" ? "REQUIRES_CONFIRMATION" : "ALLOWED";
}
export function submission(callId: string, raw: unknown, over: Partial<Actor> = {}): Submission { return { actor: actor(over), call: { callId, raw } }; }
export const exactly = (reason: ReasonCode, count: number, outcome: Outcome = "DENIED"): DenialExpectation => ({ outcome, reason, min: count, max: count });

export interface SequenceOptions {
  readonly id: string;
  readonly category: AttackCategory;
  readonly title: string;
  readonly appliesTo?: (traits: CapabilityTraits) => boolean;
  readonly rounds: (traits: CapabilityTraits) => readonly Round[];
  readonly sharedStoreCallBudget?: (traits: CapabilityTraits) => number;
}

function failureFeedback(): PlannerFeedback { return { outcome: "DENIED", category: "not_available" }; }

/** Drives the rounds through the harness, recording feedback itself and reading the recording ports. */
async function runSequence(rounds: readonly Round[], target: SequenceTarget): Promise<SequenceObservation> {
  const scanner = new LeakScanner();
  const findings = new Set<string>();
  const feedback: PlannerFeedback[] = [];
  let failed = false;
  const submit = async (item: Submission): Promise<void> => {
    try {
      const captured = snapshotData(await target.submitAs(item.actor, item.call));
      for (const finding of scanner.scan(captured)) findings.add(`${finding.kind}:${finding.path}`);
      if (captured === null || typeof captured !== "object" || !OUTCOMES.some((outcome) => outcome === captured.outcome)) throw new TypeError("Invalid feedback");
      feedback.push(captured);
    } catch { failed = true; feedback.push(failureFeedback()); }
  };
  try {
    for (const round of rounds) {
      if (round.fault !== undefined) {
        if (!target.injectLimiterFault) throw new TypeError("Harness cannot inject limiter faults");
        await target.injectLimiterFault(round.fault === "none" ? null : round.fault);
      }
      if (round.advanceSecondsBefore) await target.advanceSeconds(round.advanceSecondsBefore);
      if (round.mode === "parallel") await Promise.all(round.submissions.map(submit));
      else for (const item of round.submissions) await submit(item);
    }
  } catch { failed = true; }
  try { for (const finding of scanner.scan(snapshotData(target.visibleOutput))) findings.add(`${finding.kind}:${finding.path}`); }
  catch { failed = true; findings.add("scan-error:$"); }
  let executorCalls = Number.MAX_SAFE_INTEGER;
  let auditEvents: readonly AuditEvent[] = [];
  try { executorCalls = target.executor.calls; auditEvents = snapshotData(target.audit.events); } catch { failed = true; findings.add("runner-error:$"); }
  if (failed) feedback.unshift(failureFeedback());
  const calls = target.sharedStoreCalls;
  return snapshotData({ feedback, executorCalls, auditEvents, leakFindings: [...findings], ...(typeof calls === "number" ? { sharedStoreCalls: calls } : {}) });
}

export function sequenceScenario(options: SequenceOptions): SequenceScenario {
  const { id, rounds, sharedStoreCallBudget } = options;
  return {
    id, category: options.category, title: options.title, rounds,
    ...(sharedStoreCallBudget ? { sharedStoreCallBudget } : {}),
    appliesTo: options.appliesTo ?? (() => true),
    async run(traits) {
      const target = traits as SequenceTarget;
      if (typeof target.submitAs !== "function" || typeof target.advanceSeconds !== "function") {
        // No sequence harness: record a fail-closed observation so the oracle cannot pass vacuously.
        return { feedback: [failureFeedback()], executorCalls: Number.MAX_SAFE_INTEGER, auditEvents: [], leakFindings: ["runner-error:$"] };
      }
      return runSequence(rounds(target), target);
    },
    verify(observation: AttackObservation, traits: CapabilityTraits = DEFAULT_TRAITS) {
      return verifySequence(rounds(traits), observation as SequenceObservation, sharedStoreCallBudget?.(traits));
    },
  };
}

/** Recomputes every expectation from the declared rounds; trusts nothing but the recorded evidence. */
export function verifySequence(rounds: readonly Round[], observation: SequenceObservation, budget?: number): string[] {
  const violations: string[] = [];
  if (!Number.isSafeInteger(observation.executorCalls) || observation.executorCalls < 0) violations.push("invalid executor count");
  if (rounds.length === 0) violations.push("empty attack fixture");
  const total = rounds.reduce((sum, round) => sum + round.submissions.length, 0);
  if (observation.leakFindings.length !== 0) violations.push("planner output leaked");
  if (observation.feedback.length !== total) { violations.push("submission count mismatch"); return violations; }

  let offset = 0;
  let minExecutions = 0; let maxExecutions = 0; let actualAllows = 0;
  const expectedReasons = new Map<string, { type: string; outcome: Outcome; min: number; max: number }>();
  for (const [index, round] of rounds.entries()) {
    const slice = observation.feedback.slice(offset, offset + round.submissions.length);
    offset += round.submissions.length;
    actualAllows += slice.filter((item) => isDeepStrictEqual(item, proceedFeedback("ALLOWED"))).length;
    const passed = slice.filter((item) => isDeepStrictEqual(item, proceedFeedback(round.proceeds.as))).length;
    if (passed < round.proceeds.min || passed > round.proceeds.max) violations.push(`round ${index}: ${passed} proceeded, expected ${round.proceeds.min}..${round.proceeds.max}`);
    if (round.proceeds.as === "ALLOWED") { minExecutions += round.proceeds.min; maxExecutions += round.proceeds.max; }
    const classes = round.denials.map((item) => ({ outcome: item.outcome, category: expectedCategory(item.outcome, item.reason) }));
    for (const expectation of round.denials) {
      const entry = expectedReasons.get(expectation.reason) ?? { type: expectedAuditType(expectation.outcome, expectation.reason), outcome: expectation.outcome, min: 0, max: 0 };
      expectedReasons.set(expectation.reason, { ...entry, min: entry.min + expectation.min, max: entry.max + expectation.max });
    }
    // Reasons are proven through the audit trail; planner feedback only carries outcome and category.
    const unexpected = slice.filter((item) => !isDeepStrictEqual(item, proceedFeedback(round.proceeds.as)) && !classes.some((wanted) => isDeepStrictEqual(item, wanted))).length;
    if (unexpected > 0) violations.push(`round ${index}: unexpected planner feedback`);
    const denialMin = round.denials.reduce((sum, item) => sum + item.min, 0);
    const denialMax = round.denials.reduce((sum, item) => sum + item.max, 0);
    if (slice.length - passed < denialMin || slice.length - passed > denialMax) violations.push(`round ${index}: denial count outside ${denialMin}..${denialMax}`);
  }
  if (observation.executorCalls !== actualAllows) violations.push("executor count differs from observed ALLOWED feedback");
  if (observation.executorCalls < minExecutions || observation.executorCalls > maxExecutions) violations.push(`executor ran ${observation.executorCalls} times, expected ${minExecutions}..${maxExecutions}`);

  const proposed = observation.auditEvents.filter((event) => event.type === "AI_ACTION_PROPOSED");
  if (proposed.length !== total) violations.push("proposed event count mismatch");
  if (new Set(observation.auditEvents.map((event) => event.id)).size !== observation.auditEvents.length) violations.push("duplicate audit event id");
  const requests = new Set(proposed.map((event) => event.requestId));
  if (requests.size !== proposed.length) violations.push("proposed request ids repeat");
  const decisionTypes = new Set(["AI_ACTION_DENIED", "AI_RATE_LIMITED", "AI_POLICY_VIOLATION"]);
  const decisions = observation.auditEvents.filter((event) => decisionTypes.has(event.type));
  if (new Set(decisions.map((event) => event.requestId)).size !== decisions.length) violations.push("multiple decisions for one request");
  const actualDenials = observation.feedback.filter((item) => item.outcome !== "ALLOWED" && item.outcome !== "REQUIRES_CONFIRMATION").length;
  if (decisions.length !== actualDenials) violations.push("denial audit count differs from observed feedback");
  for (const event of decisions) {
    if (!requests.has(event.requestId)) violations.push("decision without a proposed request");
    if (isRateReason(event.reason ?? "") && event.type !== "AI_RATE_LIMITED") violations.push("rate denial not audited as AI_RATE_LIMITED");
  }
  for (const [reason, expectation] of expectedReasons) {
    const count = decisions.filter((event) => event.reason === reason && event.type === expectation.type && event.outcome === expectation.outcome).length;
    if (count < expectation.min || count > expectation.max) violations.push(`audit ${expectation.type}/${reason}: ${count}, expected ${expectation.min}..${expectation.max}`);
  }
  const allowedReasons = new Set(expectedReasons.keys());
  for (const event of decisions) if (!allowedReasons.has(event.reason ?? "")) violations.push(`unexpected audit reason ${String(event.reason)}`);

  if (budget !== undefined) {
    if (typeof observation.sharedStoreCalls !== "number") violations.push("shared store calls not measured");
    else if (!Number.isSafeInteger(observation.sharedStoreCalls) || observation.sharedStoreCalls < 0) violations.push("invalid shared store count");
    else if (observation.sharedStoreCalls > budget) violations.push(`shared store calls ${observation.sharedStoreCalls} exceed ${budget}`);
  }
  return violations;
}
