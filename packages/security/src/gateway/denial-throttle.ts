import type { PolicyDecision } from "@dap/contracts";
import { isMintedContext } from "@dap/contracts/mint";
import type { Limiter } from "../limits/limiter.js";
import type { PipelineInput } from "./pipeline.js";

/**
 * Limiter-decided denials are recorded by the limit gate itself, and only when the limiter says they count
 * (local rejections, active blocks and faults cost no shared round trip). Everything else is a final denial
 * made by another stage and counts here, once, after the decision is final. Audit infrastructure
 * failures are also excluded: an outage is not user abuse.
 */
const skipDenialCount = (reason: string): boolean => reason.startsWith("rate_limited_") || reason === "denial_throttle" || reason === "dependency_failure" || reason === "audit_unavailable";

/** A recording fault never replaces the final denial; the limiter already bounds its own call and never throws. */
export async function recordFinalDenial(limiter: Pick<Limiter, "recordDenial">, input: PipelineInput, decision: PolicyDecision): Promise<void> {
  try {
    if (decision.outcome === "ALLOWED" || decision.outcome === "REQUIRES_CONFIRMATION" || skipDenialCount(decision.reason)) return;
    if (!isMintedContext(input.context)) return;
    const aiSessionId: unknown = (input.run as { aiSessionId?: unknown } | null)?.aiSessionId;
    await limiter.recordDenial({ scope: input.context, aiSessionId: aiSessionId as string });
  } catch { /* Counting is best effort once the denial stands. */ }
}
