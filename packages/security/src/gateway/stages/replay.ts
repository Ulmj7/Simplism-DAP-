import type { ReplayGuard } from "@dap/contracts";
import { isMintedContext } from "@dap/contracts/mint";
import { nativeTimer, underDeadline } from "../deadline.js";
import { denyDecision } from "../decision.js";
import type { HookOptions } from "../hook-wrapper.js";
import type { PolicyStage } from "../pipeline.js";

const callIdGrammar = /^[\x21-\x7e]{1,256}$/;
export function createReplayStage({ replay, retainSeconds }: { readonly replay: ReplayGuard; readonly retainSeconds: number }, { hookTimeoutMs = 2000, timer = nativeTimer }: HookOptions = {}): PolicyStage {
  if (!Number.isSafeInteger(retainSeconds) || retainSeconds < 1 || retainSeconds > 31536000) throw new TypeError("Invalid replay retention");
  const claim = replay.claim.bind(replay);
  return async (request) => {
    const stop = (reason: "dependency_failure" | "replayed_request") => ({ kind: "stop" as const, decision: denyDecision({ decisionId: request.decisionId, requestId: request.requestId, stage: "replay", reason }) });
    try {
      if (!isMintedContext(request.context)) return stop("dependency_failure");
      const intake = request.facts.intake;
      const callId = intake && typeof intake === "object" && !Array.isArray(intake) ? Reflect.get(intake, "callId") : undefined;
      const session = request.run.aiSessionId;
      if (typeof callId !== "string" || !callIdGrammar.test(callId) || typeof session !== "string" || !callIdGrammar.test(session)) return stop("dependency_failure");
      const left = Math.min(hookTimeoutMs, Math.floor(request.budget.remainingMs()));
      if (!(left >= 1)) return stop("dependency_failure");
      const result = await underDeadline(() => claim(request.context!, `${encodeURIComponent(session)}:${encodeURIComponent(callId)}`, retainSeconds), (answer) => {
        if (answer !== "claimed" && answer !== "duplicate") throw new TypeError("Invalid replay answer");
        return answer;
      }, () => null, left, timer);
      return result === "claimed" ? { kind: "continue", data: { claimed: true } } : stop(result === "duplicate" ? "replayed_request" : "dependency_failure");
    } catch { return stop("dependency_failure"); }
  };
}
