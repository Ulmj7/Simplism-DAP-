import { z } from "zod";
import { isMintedContext } from "@dap/contracts/mint";
import type { PipelineStage } from "@dap/contracts";
import type { Limiter } from "../../limits/limiter.js";
import { deferLimitDenial } from "./limit-recording.js";
export { withDeferredLimitDenials } from "./limit-recording.js";
import { snapshotAnswer } from "../answer-snapshot.js";
import { nativeTimer, underDeadline } from "../deadline.js";
import { denyDecision } from "../decision.js";
import type { HookOptions } from "../hook-wrapper.js";
import type { PipelineRecord, StageResult } from "../pipeline.js";

const verdictSchema = z.discriminatedUnion("allowed", [
  z.strictObject({ allowed: z.literal(true) }),
  z.strictObject({ allowed: z.literal(false), outcome: z.literal("DENIED"),
    reason: z.enum(["rate_limited_turn", "rate_limited_tenant", "rate_limited_user", "rate_limited_capability", "rate_limited_risk", "denial_throttle", "dependency_failure"]),
    limit: z.enum(["chain_depth", "turn_budget", "turn_proposals", "turn_executions", "tenant", "user", "capability", "risk", "denial_throttle", "dependency_failure"]),
    retryAfterSeconds: z.number().int().nonnegative().nullable(), countsTowardThrottle: z.boolean() }),
]);

/** The final limiter denial is made here, not by the generic pipeline or planner-facing runner. */
export function createLimitGate(limiter: Pick<Limiter, "recordDenial">, { hookTimeoutMs = 2000, timer = nativeTimer }: HookOptions = {}) {
  const recordDenial = limiter.recordDenial.bind(limiter);
  return async (request: PipelineRecord, stage: PipelineStage, check: () => unknown): Promise<StageResult | null> => {
    const denial = (reason: "dependency_failure" | "rate_limited_turn" | "rate_limited_tenant" | "rate_limited_user" | "rate_limited_capability" | "rate_limited_risk" | "denial_throttle"): StageResult => ({ kind: "stop", decision: denyDecision({ decisionId: request.decisionId, requestId: request.requestId, stage, reason }) });
    const left = (): number => {
      try { return Math.floor(request.budget.remainingMs()); } catch { return 0; }
    };
    const checkTimeout = left();
    if (!isMintedContext(request.context) || !(checkTimeout >= 1)) return denial("dependency_failure");
    const verdict = await underDeadline(check, (answer) => verdictSchema.parse(snapshotAnswer(answer)), () => null, checkTimeout, timer);
    if (verdict === null) return denial("dependency_failure");
    if (verdict.allowed) return null;
    const result = denial(verdict.reason);
    // Local rejections, active blocks and faults deliberately make no shared throttle round trip.
    const recordTimeout = 2 * hookTimeoutMs;
    if (verdict.countsTowardThrottle) {
      const record = async (): Promise<void> => {
        await underDeadline(() => recordDenial({ scope: request.context!, aiSessionId: request.run.aiSessionId }), () => undefined, () => undefined, recordTimeout, timer);
      };
      if (!deferLimitDenial({ stage, reason: verdict.reason, record })) await record();
    }
    return result;
  };
}
