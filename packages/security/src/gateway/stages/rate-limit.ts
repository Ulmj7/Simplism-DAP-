import type { PipelineStage } from "@dap/contracts";
import type { Limiter } from "../../limits/limiter.js";
import type { HookOptions } from "../hook-wrapper.js";
import type { PolicyStage } from "../pipeline.js";
import { createLimitGate } from "./limit-gate.js";

export function createRateLimitStage(limiter: Pick<Limiter, "checkProposal" | "recordDenial">, options: HookOptions = {}, stage: PipelineStage = "rate_limit"): PolicyStage {
  const check = limiter.checkProposal.bind(limiter);
  const gate = createLimitGate(limiter, options);
  return async (request) => await gate(request, stage, () => check({
    scope: request.context!, userId: request.context!.userId, aiSessionId: request.run.aiSessionId,
    turnId: request.run.turnId, chainDepth: request.run.depth, turnStartedAt: request.run.turnStartedAt,
  })) ?? { kind: "continue", data: {} };
}
