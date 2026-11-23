import { describe, expect, it } from "vitest";
import type { AuditEvent, CapabilityTraits, PlannerFeedback } from "@dap/contracts";
import { InMemoryAuditSink } from "../audit-capture.js";
import { ALICE, ctx, TENANT_A } from "../world.js";
import { actor, expectedAuditType, expectedCategory, exactly, proceedsAs, sequenceScenario, submission, validRaw, verifySequence, type Round, type SequenceObservation, type SequenceTarget } from "./sequence-scenario.js";

// Synthetic evidence tests the ORACLE in isolation; each case breaks exactly one invariant. No gateway is simulated.
// A proposal carries no outcome or reason yet (the audit branch makes both nullable); the oracle only reads decision events' reasons.
const ev = (id: string, type: AuditEvent["type"], requestId: string, reason: AuditEvent["reason"] | null, outcome: AuditEvent["outcome"] | null = reason ? "DENIED" : null): AuditEvent => ({
  id, occurredAt: ctx(TENANT_A, ALICE).authenticatedAt, type, requestId: requestId as AuditEvent["requestId"], decisionId: `d-${id}`, tenantId: TENANT_A, userId: ALICE,
  aiSessionId: "s", turnId: "t", model: "scripted", actionId: "testSafeEcho", definitionVersion: 1, paramsView: {}, risk: "SAFE", outcome: outcome as AuditEvent["outcome"], reason: reason as AuditEvent["reason"],
  confirmationId: null, confirmationState: null, executionResult: null, resource: null,
});
const ok: PlannerFeedback = { outcome: "ALLOWED", category: "ok" };
const confirm: PlannerFeedback = { outcome: "REQUIRES_CONFIRMATION", category: "needs_user_confirmation" };
const notAvailable: PlannerFeedback = { outcome: "DENIED", category: "not_available" };
const tryLater: PlannerFeedback = { outcome: "DENIED", category: "try_later" };
const subs = (count: number) => Array.from({ length: count }, (_, index) => submission(`c${index}`, {}));
const obs = (feedback: PlannerFeedback[], auditEvents: readonly AuditEvent[], executorCalls: number, extra: Partial<SequenceObservation> = {}): SequenceObservation => ({ feedback, executorCalls, auditEvents, leakFindings: [], ...extra });
const proposed = (count: number) => Array.from({ length: count }, (_, index) => ev(`p${index}`, "AI_ACTION_PROPOSED", `r${index}`, null));

/** 3 submissions: 1..2 proceed, 1..2 replays. */
const replayRound: Round = { submissions: subs(3), proceeds: { min: 1, max: 2, as: "ALLOWED" }, denials: [{ outcome: "DENIED", reason: "replayed_request", min: 1, max: 2 }] };
const goodReplay = (): SequenceObservation => obs([ok, notAvailable, notAvailable], [...proposed(3), ev("d1", "AI_ACTION_DENIED", "r1", "replayed_request"), ev("d2", "AI_ACTION_DENIED", "r2", "replayed_request")], 1);
/** 1 submission denied by the per-user rate limit. */
const rateRound: Round = { submissions: subs(1), proceeds: { min: 0, max: 0, as: "ALLOWED" }, denials: [exactly("rate_limited_user", 1)] };
const goodRate = (): SequenceObservation => obs([tryLater], [...proposed(1), ev("d0", "AI_RATE_LIMITED", "r0", "rate_limited_user")], 0);

describe("sequence oracle: derived expectations", () => {
  it.each([
    ["DENIED", "replayed_request", "not_available"], ["DENIED", "rate_limited_user", "try_later"], ["DENIED", "rate_limited_turn", "try_later"],
    ["DENIED", "denial_throttle", "try_later"], ["DENIED", "dependency_failure", "try_later"], ["DENIED", "internal_error", "try_later"], ["DENIED", "state_unavailable", "try_later"],
    ["INVALID_ACTION", "malformed_envelope", "not_available"], ["INVALID_PARAMETERS", "invalid_parameters", "invalid_input"], ["FORBIDDEN_POLICY", "reserved_forbidden_action", "not_available"],
  ] as const)("%s/%s is shown to the planner as %s", (outcome, reason, category) => expect(expectedCategory(outcome, reason)).toBe(category));
  it.each([
    ["DENIED", "rate_limited_user", "AI_RATE_LIMITED"], ["DENIED", "rate_limited_risk", "AI_RATE_LIMITED"], ["DENIED", "denial_throttle", "AI_RATE_LIMITED"],
    ["FORBIDDEN_POLICY", "reserved_forbidden_action", "AI_POLICY_VIOLATION"], ["UNAUTHORIZED", "permission_missing", "AI_ACTION_DENIED"],
    ["DENIED", "replayed_request", "AI_ACTION_DENIED"], ["INVALID_ACTION", "unknown_action", "AI_ACTION_DENIED"],
  ] as const)("%s/%s is audited as %s", (outcome, reason, type) => expect(expectedAuditType(outcome, reason)).toBe(type));
  it("a capability needs confirmation when it says so or is HIGH/CRITICAL", () => {
    const traits = (over: Partial<CapabilityTraits>): CapabilityTraits => ({ actionId: "testSafeEcho", risk: "SAFE", changesState: false, targetsResource: false, requiresConfirmation: false, ...over });
    expect(proceedsAs(traits({}))).toBe("ALLOWED");
    expect(proceedsAs(traits({ risk: "MEDIUM" }))).toBe("ALLOWED");
    expect(proceedsAs(traits({ requiresConfirmation: true }))).toBe("REQUIRES_CONFIRMATION");
    expect(proceedsAs(traits({ risk: "HIGH" }))).toBe("REQUIRES_CONFIRMATION");
    expect(proceedsAs(traits({ risk: "CRITICAL" }))).toBe("REQUIRES_CONFIRMATION");
    expect(validRaw(traits({ actionId: "unregistered" }))).toEqual({ action: "unregistered", params: {} });
  });
});

describe("sequence oracle: every invariant is checked on its own", () => {
  it("accepts exact evidence", () => {
    expect(verifySequence([replayRound], goodReplay())).toEqual([]);
    expect(verifySequence([rateRound], goodRate())).toEqual([]);
  });
  it("rejects an extra execution even inside a loose declared range, and invalid measurements", () => {
    expect(verifySequence([replayRound], { ...goodReplay(), executorCalls: 2 })).not.toEqual([]);
    for (const value of [NaN, Infinity, -1, 0.5]) {
      expect(verifySequence([rateRound], { ...goodRate(), executorCalls: value })).not.toEqual([]);
      expect(verifySequence([rateRound], { ...goodRate(), sharedStoreCalls: value }, 10)).not.toEqual([]);
    }
  });
  it("rejects arbitrary echoed feedback fields and denial events assigned to the wrong outcome/request", () => {
    expect(verifySequence([rateRound], { ...goodRate(), feedback: [{ ...tryLater, extra: "planner-value" } as never] })).not.toEqual([]);
    expect(verifySequence([rateRound], { ...goodRate(), auditEvents: goodRate().auditEvents.map((event) => event.type === "AI_RATE_LIMITED" ? { ...event, outcome: "ALLOWED" } : event) })).not.toEqual([]);
    expect(verifySequence([replayRound], { ...goodReplay(), auditEvents: goodReplay().auditEvents.map((event) => event.id === "d2" ? { ...event, requestId: "r1" as never } : event) })).not.toEqual([]);
  });
  it("an empty fixture is a violation", () => {
    expect(verifySequence([], obs([], [], 0))).toContain("empty attack fixture");
  });
  it("planner leaks are reported", () => {
    expect(verifySequence([replayRound], { ...goodReplay(), leakFindings: ["canary:$"] })).toEqual(["planner output leaked"]);
  });
  it("a wrong submission count stops evaluation", () => {
    expect(verifySequence([replayRound], obs([ok], proposed(1), 1))).toEqual(["submission count mismatch"]);
  });
  it("proceeds below and above the declared range", () => {
    const wide: Round = { ...replayRound, proceeds: { min: 2, max: 2, as: "ALLOWED" }, denials: [{ outcome: "DENIED", reason: "replayed_request", min: 0, max: 3 }] };
    expect(verifySequence([wide], goodReplay())).toContain("round 0: 1 proceeded, expected 2..2");
    const three = obs([ok, ok, ok], proposed(3), 3);
    expect(verifySequence([{ ...wide, denials: [{ outcome: "DENIED", reason: "replayed_request", min: 0, max: 3 }] }], three)).toContain("round 0: 3 proceeded, expected 2..2");
  });
  it("feedback outside every declared class is unexpected", () => {
    const bad = obs([ok, { outcome: "INVALID_ACTION", category: "not_available" }, notAvailable], goodReplay().auditEvents, 1);
    expect(verifySequence([replayRound], bad)).toContain("round 0: unexpected planner feedback");
    expect(verifySequence([replayRound], goodReplay())).not.toContain("round 0: unexpected planner feedback");
  });
  it("a denial count below or above the declared range", () => {
    const loose: Round = { ...replayRound, proceeds: { min: 0, max: 3, as: "ALLOWED" }, denials: [{ outcome: "DENIED", reason: "replayed_request", min: 2, max: 2 }] };
    expect(verifySequence([loose], obs([ok, ok, notAvailable], [...proposed(3), ev("d", "AI_ACTION_DENIED", "r2", "replayed_request")], 2))).toContain("round 0: denial count outside 2..2");
    expect(verifySequence([loose], obs([ok, notAvailable, notAvailable], [...proposed(3), ev("d1", "AI_ACTION_DENIED", "r1", "replayed_request"), ev("d2", "AI_ACTION_DENIED", "r2", "replayed_request")], 1))).not.toContain("round 0: denial count outside 2..2");
    const tight: Round = { ...replayRound, proceeds: { min: 0, max: 3, as: "ALLOWED" }, denials: [{ outcome: "DENIED", reason: "replayed_request", min: 0, max: 1 }] };
    expect(verifySequence([tight], goodReplay())).toContain("round 0: denial count outside 0..1");
  });
  it("executions are bounded by what the passing proposals imply", () => {
    expect(verifySequence([replayRound], { ...goodReplay(), executorCalls: 0 })).toContain("executor ran 0 times, expected 1..2");
    expect(verifySequence([replayRound], { ...goodReplay(), executorCalls: 3 })).toContain("executor ran 3 times, expected 1..2");
    const gated: Round = { submissions: subs(1), proceeds: { min: 1, max: 1, as: "REQUIRES_CONFIRMATION" }, denials: [] };
    expect(verifySequence([gated], obs([confirm], proposed(1), 0))).toEqual([]);
    expect(verifySequence([gated], obs([confirm], proposed(1), 1))).toContain("executor ran 1 times, expected 0..0");
    expect(verifySequence([gated], obs([ok], proposed(1), 1))).toContain("round 0: 0 proceeded, expected 1..1");
  });
  it("proposal events: one per submission, unique ids, unique request ids", () => {
    expect(verifySequence([replayRound], { ...goodReplay(), auditEvents: goodReplay().auditEvents.slice(1) })).toContain("proposed event count mismatch");
    const duplicateId = [...goodReplay().auditEvents, ev("p0", "AI_ACTION_DENIED", "r1", "replayed_request")];
    expect(verifySequence([replayRound], { ...goodReplay(), auditEvents: duplicateId })).toContain("duplicate audit event id");
    const sameRequest = goodReplay().auditEvents.map((event) => event.id === "p2" ? { ...event, requestId: "r1" as AuditEvent["requestId"] } : event);
    expect(verifySequence([replayRound], { ...goodReplay(), auditEvents: sameRequest })).toContain("proposed request ids repeat");
  });
  it("a decision must belong to a proposed request", () => {
    const orphan = [...goodReplay().auditEvents, ev("d9", "AI_ACTION_DENIED", "unknown-request", "replayed_request")];
    expect(verifySequence([replayRound], { ...goodReplay(), auditEvents: orphan })).toContain("decision without a proposed request");
  });
  it("rate denials have exactly one AI_RATE_LIMITED event; duplicate decisions are refused", () => {
    const deniedOnly = obs([tryLater], [...proposed(1), ev("d0", "AI_ACTION_DENIED", "r0", "rate_limited_user")], 0);
    const violations = verifySequence([rateRound], deniedOnly);
    expect(violations).toContain("rate denial not audited as AI_RATE_LIMITED");
    expect(violations).toContain("audit AI_RATE_LIMITED/rate_limited_user: 0, expected 1..1");
    const both = obs([tryLater], [...proposed(1), ev("d0", "AI_ACTION_DENIED", "r0", "rate_limited_user"), ev("d1", "AI_RATE_LIMITED", "r0", "rate_limited_user")], 0);
    expect(verifySequence([rateRound], both)).toContain("multiple decisions for one request");
  });
  it("audited reasons are counted within range and never unexpected", () => {
    const twice = obs([tryLater], [...proposed(1), ev("d0", "AI_RATE_LIMITED", "r0", "rate_limited_user"), ev("d1", "AI_RATE_LIMITED", "r0", "rate_limited_user")], 0);
    expect(verifySequence([rateRound], twice)).toContain("audit AI_RATE_LIMITED/rate_limited_user: 2, expected 1..1");
    const none = obs([tryLater], proposed(1), 0);
    expect(verifySequence([rateRound], none)).toContain("audit AI_RATE_LIMITED/rate_limited_user: 0, expected 1..1");
    const wrong = obs([tryLater], [...proposed(1), ev("d0", "AI_RATE_LIMITED", "r0", "rate_limited_user"), ev("d1", "AI_ACTION_DENIED", "r0", "internal_error")], 0);
    expect(verifySequence([rateRound], wrong)).toContain("unexpected audit reason internal_error");
    const wrongType = obs([notAvailable], [...proposed(1), ev("d0", "AI_ACTION_DENIED", "r0", "replayed_request")], 0);
    expect(verifySequence([{ ...rateRound, denials: [exactly("replayed_request", 1)] }], wrongType)).toEqual([]);
    expect(verifySequence([{ ...rateRound, denials: [exactly("replayed_request", 1)] }], obs([notAvailable], [...proposed(1), ev("d0", "AI_POLICY_VIOLATION", "r0", "replayed_request")], 0))).toContain("audit AI_ACTION_DENIED/replayed_request: 0, expected 1..1");
  });
  it("a budget needs a measurement and an upper bound", () => {
    expect(verifySequence([rateRound], goodRate(), 10)).toContain("shared store calls not measured");
    expect(verifySequence([rateRound], { ...goodRate(), sharedStoreCalls: 10 }, 10)).toEqual([]);
    expect(verifySequence([rateRound], { ...goodRate(), sharedStoreCalls: 11 }, 10)).toContain("shared store calls 11 exceed 10");
    expect(verifySequence([rateRound], goodRate())).toEqual([]);
  });
});

/** A recording harness double: it answers from a script and logs what the scenario driver asked of it. */
class Harness implements SequenceTarget {
  readonly actionId = "testSafeEcho"; readonly risk = "SAFE" as const; readonly changesState = false; readonly targetsResource = false; readonly requiresConfirmation = false;
  readonly executor = { calls: 0 }; readonly audit = new InMemoryAuditSink(); visibleOutput: unknown = null;
  readonly log: string[] = []; sharedStoreCalls: number = 7;
  pending: Array<(value: PlannerFeedback) => void> = []; mode: "answer" | "hold" | "throw" | "garbage" = "answer";
  injectLimiterFault?: (fault: string | null) => Promise<void> = async (fault) => { this.log.push(`fault:${String(fault)}`); };
  async submitAs(who: ReturnType<typeof actor>, call: { callId: string }): Promise<PlannerFeedback> {
    this.log.push(`submit:${who.tenant}/${who.instance}/${call.callId}`);
    if (this.mode === "throw") throw new Error("gateway down");
    if (this.mode === "garbage") return null as unknown as PlannerFeedback;
    if (this.mode === "hold") return new Promise((resolve) => { this.pending.push(resolve); });
    return { outcome: "ALLOWED", category: "ok" };
  }
  async advanceSeconds(seconds: number): Promise<void> { this.log.push(`advance:${seconds}`); }
}
const rounds = (): readonly Round[] => [
  { fault: "throws", advanceSecondsBefore: 5, submissions: [submission("a", {}), submission("b", {}, { tenant: "B", instance: 2 })], proceeds: { min: 0, max: 2, as: "ALLOWED" }, denials: [] },
  { fault: "none", submissions: [submission("c", {})], proceeds: { min: 0, max: 1, as: "ALLOWED" }, denials: [] },
];
const scenario = sequenceScenario({ id: "ATK-TEST-01", category: "replay", title: "driver", rounds });

describe("sequence driver", () => {
  it("orders faults, clock moves and submissions, and reports the recording ports", async () => {
    const harness = new Harness();
    const observation = await scenario.run(harness) as SequenceObservation;
    expect(harness.log).toEqual(["fault:throws", "advance:5", "submit:A/1/a", "submit:B/2/b", "fault:null", "submit:A/1/c"]);
    expect(observation.feedback).toEqual([ok, ok, ok]);
    expect(observation.executorCalls).toBe(0);
    expect(observation.leakFindings).toEqual([]);
    expect(observation.sharedStoreCalls).toBe(7);
  });
  it("omits the shared-store count when the harness does not measure it", async () => {
    const harness = new Harness(); harness.sharedStoreCalls = undefined as never;
    expect(Object.keys(await scenario.run(harness))).not.toContain("sharedStoreCalls");
  });
  it("submits a parallel round together, before any answer arrives", async () => {
    const harness = new Harness(); harness.mode = "hold";
    const parallel = sequenceScenario({ id: "ATK-TEST-02", category: "replay", title: "parallel", rounds: () => [{ mode: "parallel", submissions: subs(5), proceeds: { min: 0, max: 5, as: "ALLOWED" }, denials: [] }] });
    const running = parallel.run(harness);
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(harness.pending).toHaveLength(5);
    for (const resolve of harness.pending) resolve(ok);
    expect((await running).feedback).toHaveLength(5);
  });
  it("submits a sequential round one at a time", async () => {
    const harness = new Harness(); harness.mode = "hold";
    const running = sequenceScenario({ id: "ATK-TEST-03", category: "replay", title: "seq", rounds: () => [{ submissions: subs(3), proceeds: { min: 0, max: 3, as: "ALLOWED" }, denials: [] }] }).run(harness);
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(harness.pending).toHaveLength(1);
    harness.mode = "answer"; harness.pending[0]!(ok);
    expect((await running).feedback).toHaveLength(3);
  });
  it("a failing gateway, unreadable feedback, a missing fault injector or leaked output all fail closed", async () => {
    for (const mode of ["throw", "garbage"] as const) {
      const harness = new Harness(); harness.mode = mode;
      const observation = await scenario.run(harness);
      // One recorded failure per submission plus the run-level marker.
      expect(observation.feedback).toEqual([notAvailable, notAvailable, notAvailable, notAvailable]);
      expect(scenario.verify(observation)).not.toEqual([]);
    }
    const noInjector = new Harness(); noInjector.injectLimiterFault = undefined as never;
    const missing = await scenario.run(noInjector);
    expect(missing.feedback[0]).toEqual(notAvailable);
    expect(noInjector.log).toEqual([]);
    const leaky = new Harness(); leaky.visibleOutput = "replayed_request";
    expect((await scenario.run(leaky)).leakFindings).not.toEqual([]);
    const unreadable = new Harness(); unreadable.visibleOutput = new Proxy({}, { get: () => { throw new Error("x"); }, ownKeys: () => { throw new Error("x"); } });
    const broken = await scenario.run(unreadable);
    expect(broken.leakFindings).toContain("scan-error:$");
    expect(broken.feedback[0]).toEqual(notAvailable);
  });
  it("an unreadable executor or audit port is a failed run", async () => {
    const harness = new Harness();
    Object.defineProperty(harness.executor, "calls", { get() { throw new Error("x"); } });
    const observation = await scenario.run(harness);
    expect(observation.leakFindings).toContain("runner-error:$");
    expect(observation.executorCalls).toBe(Number.MAX_SAFE_INTEGER);
    expect(observation.feedback[0]).toEqual(notAvailable);
  });
  it("without a sequence harness the run records an unmistakable fail-closed observation", async () => {
    const observation = await scenario.run({ actionId: "testSafeEcho", risk: "SAFE", changesState: false, targetsResource: false, requiresConfirmation: false });
    expect(observation).toEqual({ feedback: [notAvailable], executorCalls: Number.MAX_SAFE_INTEGER, auditEvents: [], leakFindings: ["runner-error:$"] });
    const half = await scenario.run({ actionId: "testSafeEcho", risk: "SAFE", changesState: false, targetsResource: false, requiresConfirmation: false, submitAs: async () => ok } as never);
    expect(half.leakFindings).toEqual(["runner-error:$"]);
    expect(half.executorCalls).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("verify defaults to a SAFE echo capability and uses the traits it is given", () => {
    const flexible = sequenceScenario({ id: "ATK-TEST-04", category: "replay", title: "traits", rounds: (traits) => [{ submissions: subs(1), proceeds: { min: 1, max: 1, as: proceedsAs(traits) }, denials: [] }] });
    expect(flexible.verify(obs([ok], proposed(1), 1))).toEqual([]);
    const high: CapabilityTraits = { actionId: "testHighPublish", risk: "HIGH", changesState: true, targetsResource: true, requiresConfirmation: true };
    expect(flexible.verify(obs([confirm], proposed(1), 0), high)).toEqual([]);
    expect(flexible.verify(obs([ok], proposed(1), 1), high)).not.toEqual([]);
    expect(flexible.appliesTo(high)).toBe(true);
  });
});
