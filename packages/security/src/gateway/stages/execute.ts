import type { ActionExecutor, ActionId, ActionRegistry, AuthorizationContext, ExecutionCall, ExecutionGrant, ExecutorTable, RequestId, ResolvedResource, ResourceRef, Sha256Hex } from "@dap/contracts";
import { isMintedContext, mintExecutionGrant } from "@dap/contracts/mint";
import type { GrantBinding } from "@dap/contracts/mint";
import type { AuditWriter } from "../../audit/audit-writer.js";
import type { AuditEventFactory } from "../../audit/event-factory.js";
import { projectParams } from "../../audit/projection.js";
import { underDeadline, nativeTimer, type HookTimer } from "../deadline.js";
import { allowedDecision, denyDecision } from "../decision.js";
import type { ExecutionStatus, PolicyStage } from "../pipeline.js";
import { safeTelemetry, type GatewayTelemetry } from "../telemetry.js";
import { createExecutionCheckpoint, readAuditedFacts } from "./allow-facts.js";
import { provenDefinition } from "./registered.js";

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** What a returned `affected` may be to name the resource in the record: exactly `{ type, id }` of text. Anything else is ignored. */
function affectedRef(value: unknown): ResourceRef | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  const type: unknown = Reflect.get(value, "type");
  const id: unknown = Reflect.get(value, "id");
  return keys.length === 2 && isText(type) && isText(id) ? { type, id } : undefined;
}

/**
 * Stage 9, execute (T089, FR-011, FR-017): the only stage that builds `ALLOWED`, and the only one that can run an executor.
 *
 * Before anything runs it re-proves that everything agrees (see `readAuditedFacts`): the action intake read is the action resolve found
 * and the allow-event recorded; the version, risk, parameter digest and confirmation id of resolve, validate, the risk and
 * confirmation stages and the recorded allow-event are one and the same. Any disagreement, a missing fact, an unminted context, or
 * an executor the table does not hold is `DENIED` with `dependency_failure`, with the executor at zero calls and no grant minted.
 *
 * Then, and only then (the durable allow-event exists), it mints a single-use grant bound to
 * `(requestId, actionId, paramsDigest, tenantId, userId)` and calls the executor with ONLY: the grant, the user's own minted context,
 * the validated frozen parameters, the resolved resource, and the ids. Nothing from the raw proposal reaches it.
 *
 * The executor's outcome is `success` or `failure`; a throw, a rejection, a timeout (the remaining proposal budget), a malformed
 * answer or a guard refusal are all `failure`. Its error text and failure code are never surfaced or recorded: the record says only
 * `success` or `failure`. The result is recorded as `AI_ACTION_EXECUTED`; a failure to record it is counted and changes nothing. The
 * decision is `ALLOWED` either way (built from resolve and the recorded digest), and the status tells the planner door whether to say
 * "ok" or "try later".
 */
export function createExecuteStage({ registry, executors, events, writer, telemetry, mint = mintExecutionGrant }: {
  readonly registry: ActionRegistry;
  readonly executors: ExecutorTable;
  readonly events: AuditEventFactory;
  readonly writer: AuditWriter;
  readonly telemetry?: Partial<GatewayTelemetry>;
  /** Test seam: counts and observes grant minting. Production uses the real mint. */
  readonly mint?: (binding: GrantBinding) => ExecutionGrant;
}, { timer = nativeTimer }: { readonly timer?: HookTimer } = {}): PolicyStage {
  const get = registry.get.bind(registry);
  const executorFor = executors.executorFor.bind(executors);
  const count = safeTelemetry(telemetry);
  return async (request) => {
    const ids = { decisionId: request.decisionId, requestId: request.requestId, stage: "execute" } as const;
    const name = typeof (request.facts.resolve as { id?: unknown } | undefined)?.id === "string" ? (request.facts.resolve as { id: string }).id : undefined;
    const fault = () => ({ kind: "stop" as const, decision: denyDecision({ ...ids, outcome: "DENIED", reason: "dependency_failure", ...(name === undefined ? {} : { attemptedAction: name }) }) });
    const ctx = request.context;
    const budget: unknown = request.budget?.remainingMs;
    const facts = readAuditedFacts(request.facts);
    if (!isMintedContext(ctx) || facts === undefined || typeof budget !== "function") return fault();
    const definition = provenDefinition(get, request.facts.resolve as Readonly<Record<string, unknown>>);
    if (definition === undefined) return fault();
    // Reads, once and before any await: which executor, and what the capability audits.
    const executorId: unknown = definition.executorId;
    const rules = definition.auditParams;
    const executor: unknown = isText(executorId) ? executorFor(executorId as never) : undefined;
    const run: unknown = executor !== null && typeof executor === "object" ? Reflect.get(executor, "execute") : undefined;
    if (typeof run !== "function") return fault();
    const left = Math.floor((budget as () => number)());
    if (!(left >= 1)) return fault();

    // The allow-event is durable (stage 8): only now may a grant exist.
    const binding: GrantBinding = Object.freeze({ requestId: request.requestId as RequestId, actionId: facts.actionId as ActionId, paramsDigest: facts.paramsDigest as Sha256Hex, tenantId: ctx.tenantId, userId: ctx.userId });
    const grant = mint(binding);
    const resource: ResolvedResource | null = facts.resource === null ? null : Object.freeze({ ref: Object.freeze({ type: facts.resource.type, id: facts.resource.id }), tenantId: ctx.tenantId, displayName: facts.resource.displayName });
    const call: ExecutionCall<unknown> = Object.freeze({ grant, security: ctx as AuthorizationContext, params: facts.params as never, resource, requestId: request.requestId as RequestId, actionId: facts.actionId as ActionId, paramsDigest: facts.paramsDigest as Sha256Hex });

    let affected: ResourceRef | undefined;
    let metadata: object | undefined;
    const status = await underDeadline<ExecutionStatus>(
      () => Reflect.apply(run as ActionExecutor["execute"], executor, [call]),
      (raw) => {
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Invalid executor result");
        // ExecutionResult.value is opaque application data, not JSON or audit input.
        const reported: unknown = Reflect.get(raw, "status");
        if (reported !== "success" && reported !== "failure") throw new TypeError("Invalid executor result");
        metadata = raw;
        return reported;
      },
      () => "failure",
      left, timer,
    );

    request.reportExecution?.(createExecutionCheckpoint(request, status));
    // Outcome is settled and checkpointed before optional metadata can throw or consume time.
    if (status === "success" && metadata !== undefined) {
      try { affected = affectedRef(Reflect.get(metadata, "affected")); } catch { /* Optional metadata never changes the execution outcome. */ }
    }

    // Record the result. Whatever happens here, the executor has already run: nothing below can change the outcome.
    try {
      const recorded = affected ?? (facts.resource === null ? undefined : { type: facts.resource.type, id: facts.resource.id });
      const event = await events.make({
        type: "AI_ACTION_EXECUTED", requestId: request.requestId, decisionId: request.decisionId, context: ctx, run: request.run,
        action: { kind: "registered", id: facts.actionId, version: facts.version }, risk: facts.risk, outcome: "ALLOWED", reason: "allowed",
        paramsView: projectParams(facts.params, rules), executionResult: status,
        ...(facts.confirmationId === null ? {} : { confirmation: { id: facts.confirmationId, state: "accepted" as const } }),
        ...(recorded === undefined ? {} : { resource: recorded }),
      });
      await writer.recordExecuted(event, undefined);
    } catch { count.auditWriteFailed("executed"); }
    return { kind: "stop", decision: allowedDecision({ decisionId: request.decisionId, requestId: request.requestId, actionId: facts.actionId as ActionId, risk: facts.risk, paramsDigest: facts.paramsDigest as Sha256Hex }), executionStatus: status };
  };
}
