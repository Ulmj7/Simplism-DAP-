import type { ActionRegistry, ExecutorTable } from "@dap/contracts";
import type { Limiter } from "../../limits/limiter.js";
import { isMintedContext } from "@dap/contracts/mint";
import type { AuditWriter } from "../../audit/audit-writer.js";
import type { AuditEventFactory } from "../../audit/event-factory.js";
import { projectParams } from "../../audit/projection.js";
import { denyDecision } from "../decision.js";
import type { HookOptions } from "../hook-wrapper.js";
import type { PolicyStage } from "../pipeline.js";
import { createAllowedCheckpoint, readAllowFacts } from "./allow-facts.js";
import { createLimitGate } from "./limit-gate.js";
import { provenDefinition } from "./registered.js";

/**
 * Stage 8, audit (T089, FR-040, research D13): the durable `AI_ACTION_ALLOWED` record, written BEFORE every execution, SAFE included.
 *
 * The event is built from the same trusted facts the later execute stage works from (resolve, validate, authorize, risk,
 * confirmation), with the parameters projected through the capability's allowlist. It is committed with `recordAllowedDurably`:
 * if that does not succeed (the sink throws, hangs, answers the wrong shape, or the clock cannot date the event) the proposal is
 * `DENIED` with `audit_unavailable`, and nothing is executed. On success it publishes
 * `facts.audit = { eventId, actionId, version, risk, paramsDigest, confirmationId }`: the binding it actually wrote, which the execute
 * stage re-checks against every other fact. Facts that are missing or disagree are a `dependency_failure`.
 *
 * Before anything is written, this stage claims ONE execution slot of the turn (`Limiter.claimExecution`, `executionsPerTurn`: bounded execution,
 * Constitution XV). It is the first thing done once the facts are proven consistent, so only a proposal that has passed authorization, risk and
 * confirmation spends a slot; proposals rejected by those earlier stages never do. A refusal is the limiter's own verdict through the same gate as the other limits (the
 * rate-limit reason, one AI_RATE_LIMITED event from the decision auditor, counted toward the denial throttle as the limiter says); a limiter that
 * is down is a `dependency_failure`. Either way nothing is written and nothing runs. The slot is never given back: a later failure of the audit
 * write or of the executor does not refund it, and a retry is a new proposal that needs a new slot.
 */
export function createAuditStage({ registry, events, writer, limiter, executors }: {
  readonly registry: ActionRegistry; readonly events: AuditEventFactory; readonly writer: AuditWriter;
  readonly executors: ExecutorTable;
  readonly limiter: Pick<Limiter, "claimExecution" | "recordDenial">;
}, options: HookOptions = {}): PolicyStage {
  const get = registry.get.bind(registry);
  const executorFor = executors.executorFor.bind(executors);
  const claimExecution = limiter.claimExecution.bind(limiter);
  const limitGate = createLimitGate(limiter, options);
  return async (request) => {
    const ids = { decisionId: request.decisionId, requestId: request.requestId, stage: "audit" } as const;
    const name = typeof (request.facts.resolve as { id?: unknown } | undefined)?.id === "string" ? (request.facts.resolve as { id: string }).id : undefined;
    const stop = (reason: "dependency_failure" | "audit_unavailable") => ({ kind: "stop" as const, decision: denyDecision({ ...ids, outcome: "DENIED", reason, ...(name === undefined ? {} : { attemptedAction: name }) }) });
    const ctx = request.context;
    const allow = readAllowFacts(request.facts);
    if (!isMintedContext(ctx) || allow === undefined) return stop("dependency_failure");
    const definition = provenDefinition(get, request.facts.resolve as Readonly<Record<string, unknown>>);
    if (definition === undefined) return stop("dependency_failure");
    if (typeof definition.executorId !== "string" || !definition.executorId) return stop("dependency_failure");
    const executor = executorFor(definition.executorId as never);
    if (executor === undefined || typeof executor.execute !== "function") return stop("dependency_failure");
    // One read of the allowlist, before any await.
    const rules = definition.auditParams;
    // The execution slot, claimed before the allow-event can exist. The limiter's verdict (or its failure) is the decision; nothing below runs.
    const limited = await limitGate(request, "audit", () => claimExecution({ scope: ctx, aiSessionId: request.run.aiSessionId, turnId: request.run.turnId }));
    if (limited !== null) return limited;
    let event;
    try {
      event = await events.make({
        type: "AI_ACTION_ALLOWED", requestId: request.requestId, decisionId: request.decisionId, context: ctx, run: request.run,
        action: { kind: "registered", id: allow.actionId, version: allow.version }, risk: allow.risk, outcome: "ALLOWED", reason: "allowed",
        paramsView: projectParams(allow.params, rules),
        ...(allow.confirmationId === null ? {} : { confirmation: { id: allow.confirmationId, state: "accepted" as const } }),
        ...(allow.resource === null ? {} : { resource: { type: allow.resource.type, id: allow.resource.id } }),
      });
    } catch { return stop("audit_unavailable"); }
    const committed = await writer.recordAllowedDurably(event, request.budget);
    if (!committed.ok) return stop("audit_unavailable");
    const data = { eventId: event.id, actionId: allow.actionId, version: allow.version, risk: allow.risk, paramsDigest: allow.paramsDigest, confirmationId: allow.confirmationId };
    request.reportAllowed?.(createAllowedCheckpoint(request, request.facts, data));
    return { kind: "continue", data };
  };
}
