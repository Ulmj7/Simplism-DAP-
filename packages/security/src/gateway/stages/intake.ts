import type { JsonValue } from "@dap/contracts";
import { parseEnvelope } from "../../validation/envelope.js";
import type { StrictJsonOptions } from "../../validation/strict-json.js";
import { denyDecision } from "../decision.js";
import type { PolicyStage } from "../pipeline.js";

/** The runner's own id: printable ASCII without spaces, so it is safe in a replay claim key and in logs. */
const TRUSTED_CALL_ID = /^[\x21-\x7e]{1,256}$/;

/**
 * Stage 1, intake (T067, FR-014): the only stage that reads the proposal. `raw` is copied exactly once through
 * strict intake and judged as an envelope `{action, params}`; the result is published as
 * `facts.intake = { callId, action, params }`, the detached, deeply frozen data every later stage works from.
 *
 * Raw JSON text is the preferred input: only text lets intake reject duplicate keys. An already-parsed value is
 * still accepted, and any getter or Proxy in it is honoured exactly once, at this boundary, before it is copied.
 *
 * Denials are fail-closed and planner-safe: the planner learns only the outcome. A planner-authored action name is
 * kept for audit as `attemptedAction`, escaped and bounded by `parseEnvelope`, and is never echoed back.
 * `callId` belongs to the trusted runner, not to the model: a missing or malformed one is a dependency defect
 * (`DENIED` / `dependency_failure`), not a planner fault, and it never reaches a replay key.
 */
export function createIntakeStage(options: StrictJsonOptions = {}): PolicyStage {
  // Own the caps: later changes to the caller's object cannot widen them.
  const caps: StrictJsonOptions = Object.freeze({ ...options });
  return (request) => {
    const stop = (outcome: "DENIED" | "INVALID_ACTION" | "INVALID_PARAMETERS", reason: "dependency_failure" | "malformed_envelope" | "payload_too_large" | "invalid_parameters", attemptedAction?: string) =>
      ({ kind: "stop" as const, decision: denyDecision({ decisionId: request.decisionId, requestId: request.requestId, stage: "intake", outcome, reason, ...(attemptedAction === undefined ? {} : { attemptedAction }) }) });
    let callId: unknown;
    let raw: unknown;
    try {
      const proposal = request.readProposal();
      callId = proposal.callId;
      raw = proposal.raw;
    } catch { return stop("INVALID_ACTION", "malformed_envelope"); }
    if (typeof callId !== "string" || !TRUSTED_CALL_ID.test(callId)) return stop("DENIED", "dependency_failure");
    const envelope = parseEnvelope(raw, caps);
    if (!envelope.ok) return stop(envelope.outcome, envelope.reason as "malformed_envelope" | "payload_too_large" | "invalid_parameters", envelope.attemptedAction);
    return { kind: "continue", data: { callId, action: envelope.action, params: envelope.params as JsonValue } };
  };
}
