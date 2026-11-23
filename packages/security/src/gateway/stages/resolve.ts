import { RISK_LEVELS } from "@dap/contracts";
import type { ActionId, ActionRegistry, RiskLevel, TenantActionPolicyStore } from "@dap/contracts";
import { assertAllowlistValid } from "../../registry/enablement.js";
import { denyDecision } from "../decision.js";
import { wrapHook, type HookOptions } from "../hook-wrapper.js";
import type { PolicyStage } from "../pipeline.js";

interface Captured { readonly id: ActionId; readonly version: number; readonly risk: RiskLevel; readonly definitionHash: string }
/** One read per field; undefined for anything that is not a well-formed registered action. */
function capture(entry: object): Captured | undefined {
  const definition: unknown = Reflect.get(entry, "definition");
  const definitionHash: unknown = Reflect.get(entry, "definitionHash");
  if (!definition || typeof definition !== "object") return undefined;
  const id: unknown = Reflect.get(definition, "id");
  const version: unknown = Reflect.get(definition, "version");
  const risk: unknown = Reflect.get(definition, "risk");
  if (typeof id !== "string" || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return undefined;
  if (typeof risk !== "string" || !(RISK_LEVELS as readonly string[]).includes(risk)) return undefined;
  if (typeof definitionHash !== "string" || !/^[a-f0-9]{64}$/.test(definitionHash)) return undefined;
  return { id: id as ActionId, version, risk: risk as RiskLevel, definitionHash };
}

export function createResolveStage({ registry, globalAllowlist, tenantPolicy }: {
  readonly registry: ActionRegistry;
  readonly globalAllowlist: ReadonlySet<ActionId>;
  readonly tenantPolicy: TenantActionPolicyStore;
}, options: HookOptions = {}): PolicyStage {
  const allowlist = new Set(globalAllowlist);
  // Same R1/R7 startup validation as the enablement policy; the live reads below keep their richer denial reasons.
  assertAllowlistValid(registry, allowlist);
  const get = registry.get.bind(registry);
  const reserved = registry.isReservedForbidden.bind(registry);
  const disabled = wrapHook(tenantPolicy.isDisabled.bind(tenantPolicy), "tenantPolicy", options);
  return async (request) => {
    const envelope = request.facts.intake;
    const name = envelope && typeof envelope === "object" && !Array.isArray(envelope) ? (envelope as Readonly<Record<string, unknown>>).action : undefined;
    const stop = (outcome: "DENIED" | "FORBIDDEN_POLICY" | "INVALID_ACTION", reason: "unknown_action" | "reserved_forbidden_action" | "action_not_enabled" | "tenant_action_disabled" | "dependency_failure") => ({ kind: "stop" as const, decision: denyDecision({ decisionId: request.decisionId, requestId: request.requestId, stage: "resolve", outcome, reason, ...(typeof name === "string" ? { attemptedAction: name } : {}) }) });
    if (typeof name !== "string" || !request.context) return stop("DENIED", "dependency_failure");
    if (reserved(name)) return stop("FORBIDDEN_POLICY", "reserved_forbidden_action");
    // The entry is host-supplied: read it and each field exactly once, before any await, and prove it is the
    // action that was asked for. The published facts then cannot mix two readings of a mutable registry.
    const entry: unknown = get(name);
    if (entry === undefined || entry === null) return stop("INVALID_ACTION", "unknown_action");
    const found = typeof entry === "object" ? capture(entry) : undefined;
    if (!found || found.id !== name) return stop("DENIED", "dependency_failure");
    const { id, version, risk, definitionHash } = found;
    if (risk === "FORBIDDEN") return stop("FORBIDDEN_POLICY", "reserved_forbidden_action");
    if (!allowlist.has(id)) return stop("DENIED", "action_not_enabled");
    const answer = await disabled(Object.freeze({ tenantId: request.context.tenantId }), id);
    if (!answer.ok) return stop("DENIED", answer.reason === "denied" ? "tenant_action_disabled" : "dependency_failure");
    return { kind: "continue", data: { id, version, risk, definitionHash } };
  };
}
