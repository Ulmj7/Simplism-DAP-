import type { Clock } from "@dap/contracts";
import { isMintedContext } from "@dap/contracts/mint";
import { denyDecision } from "../decision.js";
import { wrapHook, type HookOptions } from "../hook-wrapper.js";
import type { PolicyStage } from "../pipeline.js";

/**
 * Is a minted session usable at `now` (epoch ms)? Judged on every use, because time passes between stages: an
 * authenticatedAt in the future, or a validUntil not after it, is as unusable as an expired one (fail closed).
 */
export function sessionVerdict(ctx: { readonly authenticatedAt: string; readonly validUntil: string }, now: number): "ok" | "unauthenticated" | "session_expired" {
  if (!Number.isFinite(now)) return "unauthenticated";
  const validUntil = Date.parse(ctx.validUntil);
  const authenticatedAt = Date.parse(ctx.authenticatedAt);
  if (!Number.isFinite(validUntil) || !Number.isFinite(authenticatedAt) || authenticatedAt > now || validUntil <= authenticatedAt) return "unauthenticated";
  return validUntil <= now ? "session_expired" : "ok";
}

export function createContextStage(clock: Clock, options: HookOptions = {}): PolicyStage {
  const currentTime = wrapHook(clock.now.bind(clock), "instant", options);
  return async (request) => {
    const stop = (outcome: "DENIED" | "UNAUTHORIZED", reason: "unauthenticated" | "session_expired" | "dependency_failure") => ({ kind: "stop" as const, decision: denyDecision({ decisionId: request.decisionId, requestId: request.requestId, stage: "context", outcome, reason }) });
    const ctx = request.context;
    if (!isMintedContext(ctx)) return stop("UNAUTHORIZED", "unauthenticated");
    const answer = await currentTime();
    if (!answer.ok) return stop("DENIED", "dependency_failure");
    const now = Date.parse(answer.value);
    // Expiry is decided here, so this stage must not rely on the hook's schema alone to rule out NaN.
    if (!Number.isFinite(now)) return stop("DENIED", "dependency_failure");
    const verdict = sessionVerdict(ctx, now);
    if (verdict !== "ok") return stop("UNAUTHORIZED", verdict);
    return { kind: "continue", data: {} };
  };
}
