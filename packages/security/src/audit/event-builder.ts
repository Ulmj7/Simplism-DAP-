/**
 * @dap/security: audit/event-builder.ts
 *
 * T086 / FR-038, FR-039, FR-041, research D13. The only way to make an `AuditEvent`: every field comes from a TRUSTED
 * source and nothing the model wrote reaches the record except through the two sanitizers.
 *
 *   tenantId, userId            the MINTED context (a look-alike is refused)
 *   aiSessionId, turnId, model  the trusted run metadata
 *   id, occurredAt              the system (a UUID and an ISO instant)
 *   actionId / version          the REGISTERED definition, or, for an action that never resolved, the attempted name:
 *                               scrubbed, escaped to printable ASCII, at most 64 characters (the one sanitized model-authored field)
 *   paramsView                  the allowlisted projection, scrubbed again here
 *   resource                    the resolved resource, scrubbed
 *
 * There is no free-text field. Each of the nine event types has a fixed shape (outcome and reason, which of risk, confirmation and
 * execution result it must, may or must not carry), so an event of one type cannot be dressed as another. A misuse is a programmer
 * error and throws a TypeError that names the field, never a value. Built events are deep-frozen and registered, so the audit
 * writer can refuse an event that did not come from here.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AUDIT_EVENT_TYPES, REASON_CODES, RISK_LEVELS } from "@dap/contracts";
import type { AuditEvent, AuditEventType, AuthorizationContext, ConfirmationId, IsoInstant, JsonValue, Outcome, PlannerRunMeta, ReasonCode, RequestId, ResourceRef, RiskLevel } from "@dap/contracts";
import { isMintedContext } from "@dap/contracts/mint";
import { isValidActionId } from "../registry/reserved-names.js";
import { ATTEMPTED_ACTION_MAX, auditableName } from "../validation/envelope.js";
import { scrubJson, scrubText } from "./scrubber.js";

type ConfirmationState = NonNullable<AuditEvent["confirmationState"]>;
export interface AuditEventInput {
  readonly type: AuditEventType;
  readonly id: string;
  readonly occurredAt: string;
  readonly requestId: string;
  readonly decisionId: string;
  /** Must be a minted context. */
  readonly context: AuthorizationContext;
  /** The trusted runner's metadata. */
  readonly run: Pick<PlannerRunMeta, "aiSessionId" | "turnId" | "model">;
  /** The registered action once resolved, else the name as attempted. Absent when no name could be read. */
  readonly action?: { readonly kind: "registered"; readonly id: string; readonly version: number } | { readonly kind: "attempted"; readonly name: string };
  /** An allowlisted projection (see projection.ts). Defaults to none. */
  readonly paramsView?: unknown;
  readonly risk?: RiskLevel;
  readonly outcome?: Outcome;
  readonly reason?: ReasonCode;
  readonly confirmation?: { readonly id: string; readonly state: ConfirmationState };
  readonly executionResult?: "success" | "failure";
  readonly resource?: ResourceRef;
}

const DENIAL_OUTCOMES: readonly Outcome[] = ["DENIED", "INVALID_ACTION", "INVALID_PARAMETERS", "UNAUTHORIZED", "FORBIDDEN_POLICY"];
const NOT_A_DENIAL_REASON: ReadonlySet<string> = new Set(["allowed", "confirmation_required"]);
const RATE_REASONS: ReadonlySet<string> = new Set(REASON_CODES.filter((code) => code.startsWith("rate_limited_") || code === "denial_throttle"));

/** What each event type must, may and must not carry. */
interface Shape {
  readonly outcomes: readonly Outcome[] | null; // null: no outcome yet
  readonly reason: (reason: ReasonCode) => boolean;
  readonly action: "registered" | "any";
  readonly risk: "required" | "optional" | "none";
  readonly confirmation: "none" | "optional" | "pending" | "accepted" | "rejected";
  readonly execution: "required" | "none";
  readonly paramsView: "none" | "any";
  readonly resource: "optional" | "none";
}
const SHAPES: Readonly<Record<AuditEventType, Shape>> = Object.freeze({
  AI_ACTION_PROPOSED: { outcomes: null, reason: () => false, action: "any", risk: "none", confirmation: "none", execution: "none", paramsView: "none", resource: "none" },
  AI_ACTION_ALLOWED: { outcomes: ["ALLOWED"], reason: (r) => r === "allowed", action: "registered", risk: "required", confirmation: "optional", execution: "none", paramsView: "any", resource: "optional" },
  AI_ACTION_EXECUTED: { outcomes: ["ALLOWED"], reason: (r) => r === "allowed", action: "registered", risk: "required", confirmation: "optional", execution: "required", paramsView: "any", resource: "optional" },
  AI_ACTION_DENIED: { outcomes: DENIAL_OUTCOMES, reason: (r) => !NOT_A_DENIAL_REASON.has(r), action: "any", risk: "optional", confirmation: "optional", execution: "none", paramsView: "any", resource: "optional" },
  AI_POLICY_VIOLATION: { outcomes: ["FORBIDDEN_POLICY", "DENIED", "UNAUTHORIZED"], reason: (r) => !NOT_A_DENIAL_REASON.has(r), action: "any", risk: "optional", confirmation: "none", execution: "none", paramsView: "any", resource: "optional" },
  AI_RATE_LIMITED: { outcomes: ["DENIED"], reason: (r) => RATE_REASONS.has(r), action: "any", risk: "optional", confirmation: "none", execution: "none", paramsView: "none", resource: "none" },
  AI_CONFIRMATION_REQUIRED: { outcomes: ["REQUIRES_CONFIRMATION"], reason: (r) => r === "confirmation_required", action: "registered", risk: "required", confirmation: "pending", execution: "none", paramsView: "any", resource: "optional" },
  AI_CONFIRMATION_ACCEPTED: { outcomes: ["ALLOWED"], reason: (r) => r === "allowed", action: "registered", risk: "required", confirmation: "accepted", execution: "none", paramsView: "any", resource: "optional" },
  AI_CONFIRMATION_REJECTED: { outcomes: ["DENIED"], reason: (r) => r === "confirmation_rejected", action: "registered", risk: "required", confirmation: "rejected", execution: "none", paramsView: "any", resource: "optional" },
});

/** Printable text of a bounded length: identifiers that end up in rows and log lines. */
const identifier = z.string().max(256).regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u);
const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const reject = (field: string): never => { throw new TypeError(`Invalid audit event: ${field}`); };
function need<T>(schema: z.ZodType<T>, value: unknown, field: string): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : reject(field);
}

const BUILT = new WeakSet<object>();
/** True only for an event made by `buildAuditEvent`: the writer refuses anything else. */
export function isBuiltAuditEvent(value: unknown): value is AuditEvent {
  return typeof value === "object" && value !== null && BUILT.has(value);
}

/** An attempted name, escaped, scrubbed and bounded. A name that is already in that form is kept as it is (the intake stage prepares it). */
const ALREADY_SAFE = new RegExp(`^[\\x20-\\x7e]{0,${ATTEMPTED_ACTION_MAX}}$`);
function attemptedName(name: unknown): string {
  if (typeof name !== "string") return reject("action");
  return ALREADY_SAFE.test(name) ? scrubText(name) : auditableName(name);
}

export function buildAuditEvent(input: AuditEventInput): AuditEvent {
  // Every input field is read exactly once.
  const { type, id, occurredAt, requestId, decisionId, context, run, action, risk, outcome, reason, confirmation, executionResult, resource } = input;
  const paramsViewInput: unknown = input.paramsView;
  if (!(AUDIT_EVENT_TYPES as readonly string[]).includes(type as string)) reject("type");
  const shape = SHAPES[type];
  if (!isMintedContext(context)) reject("context");
  const tenantId = context.tenantId;
  const userId = context.userId;
  const [aiSessionId, turnId, model] = [need(identifier, run?.aiSessionId, "aiSessionId"), need(identifier, run?.turnId, "turnId"), need(identifier, run?.model, "model")];

  let actionId: string | null = null;
  let definitionVersion: number | null = null;
  if (action !== undefined) {
    const kind = action.kind;
    if (kind === "registered") {
      const { id, version } = action;
      if (!isValidActionId(id) || !Number.isSafeInteger(version) || version < 1) reject("action");
      actionId = id;
      definitionVersion = version;
    } else if (kind === "attempted") actionId = attemptedName(action.name) || null;
    else reject("action");
  }
  if (shape.action === "registered" && definitionVersion === null) reject("action");

  const view: JsonValue = paramsViewInput === undefined ? Object.freeze({}) : scrubJson(paramsViewInput);
  if (view === null || typeof view !== "object" || Array.isArray(view)) reject("paramsView");
  if (shape.paramsView === "none" && Object.keys(view as object).length > 0) reject("paramsView");

  if (risk !== undefined && !(RISK_LEVELS as readonly string[]).includes(risk)) reject("risk");
  if (shape.risk === "none" && risk !== undefined) reject("risk");
  if (shape.risk === "required" && risk === undefined) reject("risk");
  if (risk !== undefined && definitionVersion === null) reject("risk"); // only a resolved action has a risk

  if (shape.outcomes === null) { if (outcome !== undefined || reason !== undefined) reject("outcome"); }
  else {
    // Every shape lists a subset of the known outcomes, so membership in the shape also proves the outcome is known.
    if (outcome === undefined || !shape.outcomes.includes(outcome)) reject("outcome");
    if (reason === undefined || !(REASON_CODES as readonly string[]).includes(reason) || !shape.reason(reason)) reject("reason");
  }

  let confirmationId: ConfirmationId | null = null;
  let confirmationState: ConfirmationState | null = null;
  if (confirmation !== undefined) {
    if (shape.confirmation === "none") reject("confirmation");
    confirmationId = need(uuid, confirmation.id, "confirmation") as ConfirmationId;
    confirmationState = need(z.enum(["pending", "accepted", "rejected", "invalidated"]), confirmation.state, "confirmation");
    if (["pending", "accepted", "rejected"].includes(shape.confirmation) && confirmationState !== shape.confirmation) reject("confirmation");
  } else if (["pending", "accepted", "rejected"].includes(shape.confirmation)) reject("confirmation");

  if (shape.execution === "required" && executionResult === undefined) reject("executionResult");
  if (shape.execution === "none" && executionResult !== undefined) reject("executionResult");
  if (executionResult !== undefined && executionResult !== "success" && executionResult !== "failure") reject("executionResult");

  let resolved: ResourceRef | null = null;
  if (resource !== undefined) {
    if (shape.resource === "none") reject("resource");
    resolved = Object.freeze({ type: scrubText(need(identifier, resource.type, "resource")), id: scrubText(need(identifier, resource.id, "resource")) });
  }

  const event: AuditEvent = Object.freeze({
    id: need(uuid, id, "id"),
    occurredAt: need(instant, occurredAt, "occurredAt") as IsoInstant,
    type,
    requestId: need(identifier, requestId, "requestId") as RequestId,
    decisionId: need(identifier, decisionId, "decisionId"),
    tenantId, userId, aiSessionId, turnId, model,
    actionId, definitionVersion,
    paramsView: view as AuditEvent["paramsView"],
    risk: risk ?? null,
    outcome: outcome ?? null,
    reason: reason ?? null,
    confirmationId, confirmationState,
    executionResult: executionResult ?? null,
    resource: resolved,
  });
  BUILT.add(event);
  return event;
}

/** The composition root's builder: ids from a generator and the time from a clock, so no caller can pick either. */
export function createAuditEventBuilder({ now, newId = randomUUID }: { readonly now: () => string; readonly newId?: () => string }): { build(input: Omit<AuditEventInput, "id" | "occurredAt">): AuditEvent } {
  return Object.freeze({ build: (input: Omit<AuditEventInput, "id" | "occurredAt">) => buildAuditEvent({ ...input, id: newId(), occurredAt: now() }) });
}
