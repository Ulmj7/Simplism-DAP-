import type { CapabilityTraits, LimitConfig } from "@dap/contracts";
import { DEFAULT_LIMIT_CONFIG } from "@dap/security";
import { actor, exactly, proceedsAs, sequenceScenario, submission, validRaw, type DenialExpectation, type LimiterFault, type Round, type SequenceScenario, type Submission } from "./sequence-scenario.js";

const positive = (traits: CapabilityTraits): boolean => traits.risk !== "FORBIDDEN";
const highRisk = (traits: CapabilityTraits): boolean => traits.risk === "HIGH" || traits.risk === "CRITICAL";
const NEVER_REGISTERED = { action: "deleteEverything", params: {} };
/** A fresh AI session and turn per proposal, so only the limit under test can intervene. */
const fresh = (index: number, raw: unknown, over: Parameters<typeof actor>[0] = {}): Submission => submission(`call-${index}`, raw, { session: `session-${index}`, turn: `turn-${index}`, ...over });
const none = { min: 0, max: 0, as: "ALLOWED" } as const;
const FAULTS: readonly LimiterFault[] = ["throws", "hangs", "wrong_type", "full_store"];

/**
 * ATK-RATE-01..08 and ATK-XTENANT-08 as data plus an independent oracle. Limits come from the
 * (validated) configuration the harness runs with. Run each scenario in fresh state. Needs a
 * SequenceTarget harness; rate denials are audited as AI_RATE_LIMITED.
 */
export function createRateAbuseScenarios(limits: LimitConfig = DEFAULT_LIMIT_CONFIG): readonly SequenceScenario[] {
  const valid = (traits: CapabilityTraits): unknown => validRaw(traits);
  /** Admitted proposals before a per-capability or per-risk limit denies the next one. */
  const capabilityAdmits = (traits: CapabilityTraits): { admits: number; reason: "rate_limited_capability" | "rate_limited_risk" } =>
    highRisk(traits) && limits.highRiskPerUserPerHour.limit < limits.perUserPerCapabilityPerMinute.limit
      ? { admits: limits.highRiskPerUserPerHour.limit, reason: "rate_limited_risk" }
      : { admits: limits.perUserPerCapabilityPerMinute.limit, reason: "rate_limited_capability" };
  const throttleDenials: readonly DenialExpectation[] = [
    // The throttle may trip on the crossing denial or the one after it.
    { outcome: "INVALID_ACTION", reason: "unknown_action", min: limits.denialThrottle.denials, max: limits.denialThrottle.denials + 1 },
    { outcome: "DENIED", reason: "denial_throttle", min: 0, max: 1 },
  ];
  const throttleSetup = (extra: Partial<Parameters<typeof actor>[0]> = {}): Round => ({
    submissions: Array.from({ length: limits.denialThrottle.denials + 1 }, (_, index) => submission(`deny-${index}`, NEVER_REGISTERED, { session: "session-1", turn: `turn-${index}`, ...extra })),
    proceeds: none, denials: throttleDenials,
  });
  const blocked = (traits: CapabilityTraits, over: Parameters<typeof actor>[0] = {}): Round => ({ submissions: [submission("after-throttle", valid(traits), { session: "session-1", turn: "turn-after", ...over })], proceeds: none, denials: [exactly("denial_throttle", 1)] });
  const proceeds = (traits: CapabilityTraits, ...submissions: Submission[]): Round => ({ submissions, proceeds: { min: submissions.length, max: submissions.length, as: proceedsAs(traits) }, denials: [] });

  return [
    sequenceScenario({ id: "ATK-RATE-01", category: "rate-abuse", title: "10,000 proposals in one turn execute at most the per-turn cap with bounded shared-store round trips", appliesTo: positive,
      // 4 shared calls per admitted proposal, a few more per capability/execution/denial record.
      sharedStoreCallBudget: () => limits.proposalsPerTurn * 12,
      rounds: (traits) => [{
        submissions: Array.from({ length: 10_000 }, (_, index) => submission(`flood-${index}`, valid(traits), { session: "session-1", turn: "turn-1" })),
        proceeds: { min: 1, max: proceedsAs(traits) === "ALLOWED" ? limits.executionsPerTurn : Math.min(limits.proposalsPerTurn, limits.highRiskPerUserPerHour.limit), as: proceedsAs(traits) },
        denials: [
          { outcome: "DENIED", reason: "rate_limited_turn", min: 1, max: 10_000 },
          { outcome: "DENIED", reason: "denial_throttle", min: 0, max: 10_000 },
          { outcome: "DENIED", reason: "rate_limited_capability", min: 0, max: 10_000 },
          { outcome: "DENIED", reason: "rate_limited_risk", min: 0, max: 10_000 },
        ],
      }] }),
    sequenceScenario({ id: "ATK-RATE-02", category: "rate-abuse", title: "per-user per-window limit exceeded: denied and audited; other users, tenants and the next window unaffected",
      rounds: (traits) => [
        // Never-registered actions pass stage 2 and are denied later, isolating the per-user limit.
        { submissions: Array.from({ length: limits.perUserPerMinute.limit + 1 }, (_, index) => fresh(index, NEVER_REGISTERED)), proceeds: none,
          denials: [exactly("unknown_action", limits.perUserPerMinute.limit, "INVALID_ACTION"), exactly("rate_limited_user", 1)] },
        ...(positive(traits) ? [
          proceeds(traits, fresh(1000, valid(traits), { user: "bob" })),
          proceeds(traits, fresh(1001, valid(traits), { tenant: "B" })),
          { ...proceeds(traits, fresh(1002, valid(traits))), advanceSecondsBefore: limits.perUserPerMinute.windowSeconds },
        ] : []),
      ] }),
    sequenceScenario({ id: "ATK-RATE-03", category: "rate-abuse", title: "per-user per-capability limit exceeded: denied; another capability user is unaffected",
      rounds: (traits) => {
        const { admits, reason } = capabilityAdmits(traits);
        return [
          { submissions: Array.from({ length: admits + 1 }, (_, index) => fresh(index, valid(traits))), proceeds: { min: admits, max: admits, as: proceedsAs(traits) }, denials: [exactly(reason, 1)] },
          proceeds(traits, fresh(1000, valid(traits), { user: "bob" })),
        ];
      }, appliesTo: positive }),
    sequenceScenario({ id: "ATK-RATE-04", category: "rate-abuse", title: "HIGH and CRITICAL attempts per hour: the next is denied; the window rolls over", appliesTo: highRisk,
      rounds: (traits) => [
        { submissions: Array.from({ length: limits.highRiskPerUserPerHour.limit + 1 }, (_, index) => fresh(index, valid(traits))),
          proceeds: { min: limits.highRiskPerUserPerHour.limit, max: limits.highRiskPerUserPerHour.limit, as: "REQUIRES_CONFIRMATION" }, denials: [exactly("rate_limited_risk", 1)] },
        { ...proceeds(traits, fresh(1000, valid(traits), { user: "bob" })) },
        { ...proceeds(traits, fresh(1001, valid(traits))), advanceSecondsBefore: limits.highRiskPerUserPerHour.windowSeconds },
      ] }),
    sequenceScenario({ id: "ATK-RATE-05", category: "rate-abuse", title: "repeated denials block the AI session for the configured period, and only that session", appliesTo: positive,
      rounds: (traits) => [
        throttleSetup(),
        blocked(traits),
        proceeds(traits, submission("other-session", valid(traits), { session: "session-2", turn: "turn-1" })),
        { ...proceeds(traits, submission("after-block", valid(traits), { session: "session-1", turn: "turn-final" })), advanceSecondsBefore: limits.denialThrottle.blockSeconds },
      ] }),
    sequenceScenario({ id: "ATK-RATE-06", category: "rate-abuse", title: "limiter unavailable (throws, hangs, wrong type, full store): every proposal is denied; recovery proceeds", appliesTo: positive,
      rounds: (traits) => [
        ...FAULTS.map((fault, index): Round => ({ fault, submissions: [fresh(index, valid(traits))], proceeds: none, denials: [exactly("dependency_failure", 1)] })),
        { fault: "none", ...proceeds(traits, fresh(1000, valid(traits))) },
      ] }),
    sequenceScenario({ id: "ATK-RATE-07", category: "rate-abuse", title: "chain depth above the maximum is denied", appliesTo: positive,
      rounds: (traits) => [
        proceeds(traits, fresh(0, valid(traits), { depth: limits.maxChainDepth })),
        { submissions: [fresh(1, valid(traits), { depth: limits.maxChainDepth + 1 })], proceeds: none, denials: [exactly("rate_limited_turn", 1)] },
      ] }),
    sequenceScenario({ id: "ATK-RATE-08", category: "rate-abuse", title: "turn wall-clock budget exceeded is denied", appliesTo: positive,
      rounds: (traits) => [
        proceeds(traits, submission("call-1", valid(traits), { session: "session-1", turn: "turn-1" })),
        { advanceSecondsBefore: Math.floor(limits.turnBudgetMs / 1000) + 1, submissions: [submission("call-2", valid(traits), { session: "session-1", turn: "turn-1" })], proceeds: none, denials: [exactly("rate_limited_turn", 1)] },
      ] }),
    sequenceScenario({ id: "ATK-XTENANT-08", category: "cross-tenant", title: "rate counters and denial throttles: tenant A's activity never affects tenant B", appliesTo: positive,
      rounds: (traits) => [
        throttleSetup({ tenant: "A" }),
        blocked(traits, { tenant: "A" }),
        proceeds(traits, submission("b-call", valid(traits), { tenant: "B", session: "session-1", turn: "turn-after" })),
        { submissions: Array.from({ length: limits.perUserPerMinute.limit }, (_, index) => fresh(3000 + index, NEVER_REGISTERED, { tenant: "A", user: "carol" })), proceeds: none, denials: [exactly("unknown_action", limits.perUserPerMinute.limit, "INVALID_ACTION")] },
        proceeds(traits, fresh(2000, valid(traits), { tenant: "B", user: "carol" })),
      ] }),
  ];
}
export const rateAbuseScenarios = createRateAbuseScenarios();
