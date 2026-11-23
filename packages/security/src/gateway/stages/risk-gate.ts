import type { ActionRegistry, IdGenerator, RiskLevel } from "@dap/contracts";
import { isMintedContext } from "@dap/contracts/mint";
import { confirmationDecision, denyDecision } from "../decision.js";
import type { PolicyStage } from "../pipeline.js";
import { readNoConfirmationNeeded, readPreRiskFacts } from "./allow-facts.js";
import { provenDefinition } from "./registered.js";

/** Longest justification a MEDIUM opt-out may carry; registration and runtime use the same bound. */
const MAX_JUSTIFICATION = 1000;

const validJustification = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0 && value.length <= MAX_JUSTIFICATION;

/**
 * A confirmation handle from the host's id generator, or undefined if it threw. Whatever it answers is checked by the decision builder (a
 * well-formed uuid or nothing); an answer that is a promise is consumed here so that its rejection is never unhandled.
 */
function handle(ids: Pick<IdGenerator, "newConfirmationId">): unknown {
  try {
    const answer: unknown = ids.newConfirmationId();
    if (answer !== null && typeof answer === "object" && "then" in answer) void Promise.resolve(answer).catch(() => undefined);
    return answer;
  } catch { return undefined; }
}

/**
 * Stage 7, the deterministic risk decision (T104a). From the risk class and the confirmation policy of the registered definition alone:
 *
 *   SAFE, LOW                          continue (unless the capability's own policy requires confirmation)
 *   MEDIUM                             continue only when the capability opted out WITH a recorded, bounded justification; otherwise REQUIRES_CONFIRMATION
 *   HIGH, CRITICAL                     REQUIRES_CONFIRMATION, whatever the policy says
 *   FORBIDDEN                          DENIED (FORBIDDEN_POLICY)
 *
 * On a continue it publishes `facts.risk = {risk, confirmation: "not_required"}`; nothing else continues, so the audit and execute stages only
 * ever see a class that needed no confirmation. It creates no confirmation record, has no confirmation service or store, and never returns
 * ALLOWED (that belongs to execute alone). A REQUIRES_CONFIRMATION decision carries a handle from the id generator that names no record yet:
 * the planner feedback built from it has no id or token, and the confirmation service (T104) will own what the handle stands for.
 *
 * NO CONFIRMATION RECORD EXISTS until that optional confirmation service is built. The handle is reserved, not stored: the `pending` state that
 * the AI_CONFIRMATION_REQUIRED audit event records for it is the decision's state, not a stored confirmation, and nothing can accept or reject it
 * (the service's `decide` answers `not_found`). Reviewers must not read that audit record as evidence of a stored confirmation.
 *
 * The class and the policy come from the proven definition snapshot (each read once), and must agree with what resolve published; nothing from the
 * proposal is read. Any missing, malformed or inconsistent fact is a `dependency_failure`.
 */
export function createRiskGateStage({ registry, ids }: { readonly registry: ActionRegistry; readonly ids: Pick<IdGenerator, "newConfirmationId"> }): PolicyStage {
  const get = registry.get.bind(registry);
  return (request) => {
    const base = { decisionId: request.decisionId, requestId: request.requestId } as const;
    const failed = { kind: "stop" as const, decision: denyDecision({ ...base, stage: "risk", outcome: "DENIED", reason: "dependency_failure" }) };
    try {
      if (!isMintedContext(request.context)) return failed;
      const pre = readPreRiskFacts(request.facts);
      if (pre === undefined) return failed;
      const definition = provenDefinition(get, request.facts.resolve as Readonly<Record<string, unknown>>);
      // The snapshot's class must be exactly the (validated) class resolve published: this also rejects a missing definition or an unknown class.
      const risk = definition?.risk;
      if (risk !== pre.risk) return failed;
      if (risk === "FORBIDDEN") return { kind: "stop" as const, decision: denyDecision({ ...base, stage: "risk", outcome: "FORBIDDEN_POLICY", reason: "reserved_forbidden_action" }) };
      const policy = definition?.confirmation;
      if (policy?.kind !== "required" && policy?.kind !== "not-required") return failed;
      const needsConfirmation =
        risk === "HIGH" || risk === "CRITICAL" || policy.kind === "required" ||
        (risk === "MEDIUM" && !validJustification(policy.justification));
      if (!needsConfirmation) return Object.freeze({ kind: "continue" as const, data: Object.freeze({ risk, confirmation: "not_required" }) });
      // A handle that is not a uuid (or none) makes the builder throw, which is a dependency failure below.
      return { kind: "stop" as const, decision: confirmationDecision({ ...base, actionId: pre.actionId, risk: risk as Exclude<RiskLevel, "FORBIDDEN">, confirmationId: handle(ids) } as never) };
    } catch { return failed; }
  };
}

/**
 * The confirmation position of the pipeline while no confirmation mechanism exists: it only records that none was needed
 * (`facts.confirmation = {state: "not_required", confirmationId: null}`), and only after the risk stage said so for the class resolve found.
 * A risk fact that says anything else (for example an accepted confirmation, which nothing can yet have produced) is a `dependency_failure`.
 * The confirmation service (T104, T105) replaces this stage.
 */
export function createNoConfirmationStage(): PolicyStage {
  return (request) => {
    try {
      if (readNoConfirmationNeeded(request.facts)) return Object.freeze({ kind: "continue" as const, data: Object.freeze({ state: "not_required", confirmationId: null }) });
    } catch { /* fall through to the denial */ }
    return { kind: "stop" as const, decision: denyDecision({ decisionId: request.decisionId, requestId: request.requestId, stage: "confirmation", outcome: "DENIED", reason: "dependency_failure" }) };
  };
}
