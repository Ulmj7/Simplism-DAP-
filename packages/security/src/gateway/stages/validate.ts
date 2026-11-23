import type { ActionRegistry } from "@dap/contracts";
import { validateParams } from "../../validation/params.js";
import type { StrictJsonOptions } from "../../validation/strict-json.js";
import { denyDecision } from "../decision.js";
import { provenDefinition } from "./registered.js";
import type { PolicyStage } from "../pipeline.js";

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;

/**
 * Stage 5, validate (T067, FR-018, FR-020): checks the parameters intake published against the strict schema of
 * the action resolve published, for the minted tenant and user, and publishes
 * `facts.validate = { params, paramsDigest, resource }`: the only parameters any later stage may authorize,
 * digest, confirm, audit or execute.
 *
 * The definition is looked up again and must be the very action, version and definition hash that resolve
 * authorized; anything else is a dependency failure, never a validation against a different definition. A
 * rejected parameter set is `INVALID_PARAMETERS` carrying only structural issues (a path and a generic code). A
 * defective definition makes `validateParams` throw, which the runner turns into an internal error.
 */
export function createValidateStage(registry: ActionRegistry, options: StrictJsonOptions = {}): PolicyStage {
  const get = registry.get.bind(registry);
  const caps: StrictJsonOptions = Object.freeze({ ...options });
  return (request) => {
    const ids = { decisionId: request.decisionId, requestId: request.requestId, stage: "validate" } as const;
    const failed = () => ({ kind: "stop" as const, decision: denyDecision({ ...ids, outcome: "DENIED", reason: "dependency_failure" }) });
    const intake = record(request.facts.intake);
    const resolved = record(request.facts.resolve);
    const context = request.context;
    if (!intake || !resolved || !context || intake.action !== resolved.id || record(intake.params) === undefined) return failed();
    const definition = provenDefinition(get, resolved);
    if (!definition) return failed();
    const checked = validateParams(definition, intake.params, { tenantId: context.tenantId, userId: context.userId }, caps);
    if (!checked.ok) return { kind: "stop", decision: denyDecision({ ...ids, outcome: "INVALID_PARAMETERS", reason: "invalid_parameters", attemptedAction: resolved.id as string, issues: checked.issues }) };
    return { kind: "continue", data: { params: checked.normalized, paramsDigest: checked.paramsDigest, resource: checked.resource === null ? null : { type: checked.resource.type, id: checked.resource.id } } };
  };
}
