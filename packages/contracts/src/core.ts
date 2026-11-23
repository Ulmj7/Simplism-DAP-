/**
 * @dap/contracts: core.ts
 *
 * Shared primitives for every package. Contract only: no behavior other than constants.
 * Allowed importers: every package (this is the bottom of the dependency graph).
 *
 * Spec: FR-007, FR-014 | Constitution: I, III, VIII, XVI
 */

// ---------------------------------------------------------------------------
// Branded identifiers. Compile-time only. Runtime trust is established by minting
// (see security-context.ts, execution.ts), never by these brands alone.
// ---------------------------------------------------------------------------
declare const __brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type TenantId = Brand<string, "TenantId">;
export type UserId = Brand<string, "UserId">;
export type SessionId = Brand<string, "SessionId">;
export type ActionId = Brand<string, "ActionId">;
export type PermissionId = Brand<string, "PermissionId">;
export type PageId = Brand<string, "PageId">;
export type ExecutorId = Brand<string, "ExecutorId">;
export type RequestId = Brand<string, "RequestId">;
export type ConfirmationId = Brand<string, "ConfirmationId">;
export type IsoInstant = Brand<string, "IsoInstant">;
export type Sha256Hex = Brand<string, "Sha256Hex">;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

// ---------------------------------------------------------------------------
// Risk classification (FR-007). Assigned only in the registry; nothing in a
// proposal can set, change, or downgrade it.
// ---------------------------------------------------------------------------
export const RISK_LEVELS = ["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL", "FORBIDDEN"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Ordering used by policy rules. FORBIDDEN is highest so "at least X" checks include it. */
export const RISK_RANK: Readonly<Record<RiskLevel, number>> = {
  SAFE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
  FORBIDDEN: 5,
};

// ---------------------------------------------------------------------------
// Gateway outcome types (FR-014). Exactly these seven.
// ---------------------------------------------------------------------------
export const OUTCOMES = [
  "ALLOWED",
  "DENIED",
  "REQUIRES_CONFIRMATION",
  "INVALID_ACTION",
  "INVALID_PARAMETERS",
  "UNAUTHORIZED",
  "FORBIDDEN_POLICY",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * Internal reason codes. Recorded in the audit trail. NEVER returned to the planner
 * as is (see PlannerFeedback in gateway.ts and research D14).
 */
export const REASON_CODES = [
  "allowed",
  // intake / resolve
  "malformed_envelope",
  "payload_too_large",
  "unknown_action",
  "reserved_forbidden_action",
  "action_not_enabled",
  "tenant_action_disabled",
  // validation
  "invalid_parameters",
  // context / authorization
  "unauthenticated",
  "session_expired",
  "permission_missing",
  "context_not_allowed",
  "resource_not_available", // not found, not permitted, and other-tenant: indistinguishable (FR-025)
  "tenant_mismatch",
  // abuse controls
  "rate_limited_turn",
  "rate_limited_user",
  "rate_limited_tenant",
  "rate_limited_capability",
  "rate_limited_risk",
  "denial_throttle",
  "replayed_request",
  // confirmation
  "confirmation_required",
  "confirmation_unknown",
  "confirmation_expired",
  "confirmation_consumed",
  "confirmation_rejected",
  "confirmation_mismatch",
  "definition_changed",
  // fail-closed infrastructure
  "dependency_failure",
  "audit_unavailable",
  "state_unavailable",
  "internal_error",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const PIPELINE_STAGES = [
  "context",
  "intake",
  "rate_limit",
  "replay",
  "resolve",
  "validate",
  "authorize",
  "risk",
  "confirmation",
  "audit",
  "execute",
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------
export interface ResourceRef {
  readonly type: string;
  readonly id: string;
}

/** Returned by the host's ResourceAuthorizer. Display name is TRUSTED (from host data). */
export interface ResolvedResource {
  readonly ref: ResourceRef;
  readonly tenantId: TenantId;
  readonly displayName: string;
}

/**
 * Metadata about one model-driven run. Supplied by the trusted runner (our code),
 * never taken from model output. (spec: FR-038 model/session fields, FR-043 per-turn caps)
 */
export interface PlannerRunMeta {
  readonly aiSessionId: string;
  readonly turnId: string;
  readonly model: string;
  /** Number of dependent steps so far in this turn. */
  readonly depth: number;
  readonly turnStartedAt: IsoInstant;
}
