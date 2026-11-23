/**
 * @dap/security: gateway/decision-auditor.ts
 *
 * T090 / FR-038..FR-040. The runner's audit and telemetry: `AI_ACTION_PROPOSED` once per proposal as soon as it is known, and exactly
 * one decision event for every decision the runner returns, so that each proposal leaves a PROPOSED event and one decision event tied
 * by request id (ATK-AUDIT-04):
 *
 *   FORBIDDEN_POLICY                        AI_POLICY_VIOLATION
 *   rate_limited_* and denial_throttle      AI_RATE_LIMITED
 *   any other denial                        AI_ACTION_DENIED
 *   REQUIRES_CONFIRMATION                   AI_CONFIRMATION_REQUIRED
 *   ALLOWED                                 nothing here: the audit stage wrote AI_ACTION_ALLOWED and execute AI_ACTION_EXECUTED
 *
 * Every field comes from trusted facts: the minted context, the run metadata, the registered definition (once resolved), the validated
 * parameters through the capability's allowlist (once validated) and the resolved resource (once authorized). Before a name is resolved
 * the only name recorded is the intake stage's escaped, bounded attempted name. A proposal whose context is not minted cannot be
 * attributed to a tenant and so leaves no record.
 *
 * Nothing here can change a decision: it never throws, a failed write is counted (`auditWriteFailed`), and a record that cannot be
 * made is counted the same way. Telemetry sees every decision, with closed-vocabulary labels.
 */
import type { ActionRegistry, AuditEventType, PolicyDecision, ReasonCode } from "@dap/contracts";
import { isMintedContext } from "@dap/contracts/mint";
import type { AuditWriter } from "../audit/audit-writer.js";
import type { AuditEventInput } from "../audit/event-builder.js";
import type { AuditEventFactory } from "../audit/event-factory.js";
import { projectParams } from "../audit/projection.js";
import type { DecisionAuditor, PipelineRecord } from "./pipeline.js";
import { provenDefinition } from "./stages/registered.js";
import { safeTelemetry, type GatewayTelemetry, type RateLimitScope } from "./telemetry.js";

const RATE_SCOPES: Readonly<Partial<Record<ReasonCode, RateLimitScope>>> = Object.freeze({
  rate_limited_turn: "turn", rate_limited_user: "user", rate_limited_tenant: "tenant", rate_limited_capability: "capability", rate_limited_risk: "risk", denial_throttle: "throttle",
});
const record = (value: unknown): Readonly<Record<string, unknown>> | undefined => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined);

export function createDecisionAuditor({ registry, events, writer, telemetry, registeredActionIds }: {
  readonly registry: ActionRegistry;
  readonly events: AuditEventFactory;
  readonly writer: AuditWriter;
  readonly telemetry?: Partial<GatewayTelemetry>;
  /** The only action ids telemetry may name (anything else is labelled `unknown`). */
  readonly registeredActionIds?: ReadonlySet<string>;
}): DecisionAuditor {
  const get = registry.get.bind(registry);
  const count = safeTelemetry(telemetry, registeredActionIds);

  /** What the facts so far say about the action: the registered definition once resolved, else only an attempted name. */
  function describe(request: PipelineRecord, attempted: string | undefined, withParams: boolean): Pick<AuditEventInput, "action" | "risk" | "paramsView" | "resource"> {
    const resolve = record(request.facts.resolve);
    const definition = resolve === undefined ? undefined : provenDefinition(get, resolve);
    if (resolve !== undefined && definition !== undefined && typeof resolve.id === "string" && typeof resolve.version === "number" && typeof resolve.risk === "string") {
      const validate = record(request.facts.validate);
      const authorize = record(request.facts.authorize);
      const target = record(authorize?.resource);
      return {
        action: { kind: "registered", id: resolve.id, version: resolve.version }, risk: resolve.risk as never,
        ...(withParams && validate !== undefined ? { paramsView: projectParams(validate.params, definition.auditParams) } : {}),
        ...(withParams && target !== undefined && typeof target.type === "string" && typeof target.id === "string" ? { resource: { type: target.type, id: target.id } } : {}),
      };
    }
    const intake = record(request.facts.intake);
    const name = attempted ?? (typeof intake?.action === "string" ? intake.action : undefined);
    return name === undefined ? {} : { action: { kind: "attempted", name } };
  }

  async function write(kind: "proposed" | "decision", input: Omit<AuditEventInput, "id" | "occurredAt">): Promise<void> {
    try {
      const event = await events.make(input);
      if (kind === "proposed") await writer.recordProposed(event);
      else await writer.recordDecision(event);
    } catch { count.auditWriteFailed(kind); }
  }

  return Object.freeze({
    proposed: Object.freeze(async (request: PipelineRecord, attempted: string | undefined): Promise<void> => {
      try {
        const ctx = request.context;
        if (!isMintedContext(ctx)) return;
        const name = attempted ?? (typeof record(request.facts.intake)?.action === "string" ? (request.facts.intake as { action: string }).action : undefined);
        await write("proposed", { type: "AI_ACTION_PROPOSED", requestId: request.requestId, decisionId: request.decisionId, context: ctx, run: request.run, ...(name === undefined ? {} : { action: { kind: "attempted" as const, name } }) });
      } catch { count.auditWriteFailed("proposed"); }
    }),

    decided: Object.freeze(async (request: PipelineRecord, decision: PolicyDecision): Promise<void> => {
      try {
        const outcome = decision.outcome;
        const named = record(decision) as { attemptedAction?: unknown; reason?: unknown; risk?: unknown; actionId?: unknown } | undefined;
        const attempted = typeof named?.attemptedAction === "string" ? named.attemptedAction : undefined;
        if (outcome === "ALLOWED") {
          count.decision({ outcome, reason: "allowed", risk: decision.risk, action: decision.actionId });
          return;
        }
        const ctx = request.context;
        if (outcome === "REQUIRES_CONFIRMATION") {
          count.decision({ outcome, reason: "confirmation_required", risk: decision.risk, action: decision.actionId });
          if (!isMintedContext(ctx)) return;
          const about = describe(request, undefined, true);
          await write("decision", { type: "AI_CONFIRMATION_REQUIRED", requestId: request.requestId, decisionId: request.decisionId, context: ctx, run: request.run, ...about, outcome, reason: "confirmation_required", confirmation: { id: decision.confirmationId, state: "pending" } });
          return;
        }
        const reason = decision.reason;
        const resolved = describe(request, attempted, false);
        count.decision({ outcome, reason, risk: (resolved.risk ?? null) as never, action: resolved.action?.kind === "registered" ? resolved.action.id : null });
        const scope = RATE_SCOPES[reason];
        if (scope !== undefined) count.rateLimited(scope);
        if (!isMintedContext(ctx)) return;
        const type: AuditEventType = outcome === "FORBIDDEN_POLICY" ? "AI_POLICY_VIOLATION" : scope !== undefined ? "AI_RATE_LIMITED" : "AI_ACTION_DENIED";
        // A rate-limit record carries no parameters and no resource; everything else carries what has been validated and authorized so far.
        const about = describe(request, attempted, type !== "AI_RATE_LIMITED");
        await write("decision", { type, requestId: request.requestId, decisionId: request.decisionId, context: ctx, run: request.run, ...about, outcome, reason });
      } catch { count.auditWriteFailed("decision"); }
    }),
  });
}
