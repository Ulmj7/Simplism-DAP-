/**
 * @dap/contracts: gateway.ts
 *
 * Action proposal, PolicyDecision, planner-visible feedback, and the Policy Gateway.
 *
 *   AI Planner -> Action Proposal -> Schema Validation -> Policy Gateway -> Authorization
 *      -> Confirmation if required -> Action Executor
 *
 * The AI layer sees ONLY `ProposalSubmitter` and `PlannerFeedback`. It never receives the
 * registry's executors, the AuthorizationContext, the state store, or ConfirmationService.
 *
 * Types only. The runtime signatures (toPlannerFeedback, createPolicyGateway) belong to
 * @dap/security, not here.
 *
 * Spec: FR-011..FR-017, FR-043, FR-044 | Constitution: I, II, III, XV
 */
import type { ActionRegistry } from "./action-definition.js";
import type { AuditSink } from "./audit.js";
import type { ConfirmationChannel } from "./confirmation.js";
import type {
  ActionId,
  ConfirmationId,
  Outcome,
  PipelineStage,
  PlannerRunMeta,
  ReasonCode,
  RequestId,
  RiskLevel,
  Sha256Hex,
} from "./core.js";
import type { ExecutorTable } from "./execution.js";
import type {
  AuthorizationContext,
  PageContextProvider,
  PermissionChecker,
  ResourceAuthorizer,
} from "./security-context.js";
import type { Clock, IdGenerator, RateLimitRule, SecurityStateStore } from "./state-ports.js";

// ---------------------------------------------------------------------------
// Input (UNTRUSTED)
// ---------------------------------------------------------------------------

/**
 * One model tool call. `callId` is assigned by the trusted runner (for example the provider's
 * tool-call id combined with the run), is NOT part of anything the model can set, and is the
 * replay-protection key (research D11). `raw` is the only model-derived data.
 */
export interface ProposalCall {
  readonly callId: string;
  /**
   * Expected shape { action: string, params: object }. Parsed strictly by the Gateway intake.
   * PREFER the provider's raw JSON text, passed through untouched: only raw text lets intake
   * reject duplicate keys (an already-parsed object has lost them). An already-parsed value is
   * accepted, but is deep-copied once into plain data before any check (PARAMS-12).
   */
  readonly raw: unknown;
}

// ---------------------------------------------------------------------------
// Internal decision (never returned to the planner as is)
// ---------------------------------------------------------------------------
export interface FeedbackIssue {
  /** JSON-pointer path into the parameters, e.g. "/projectId". Never contains values. */
  readonly path: string;
  readonly code:
    | "required"
    | "type"
    | "unknown_key"
    | "too_long"
    | "too_many"
    | "out_of_range"
    | "format"
    | "invalid";
}

interface DecisionBase {
  readonly decisionId: string;
  readonly requestId: RequestId;
}

export type PolicyDecision =
  | (DecisionBase & {
      readonly outcome: "ALLOWED";
      readonly actionId: ActionId;
      readonly risk: RiskLevel;
      readonly paramsDigest: Sha256Hex;
    })
  | (DecisionBase & {
      readonly outcome: "REQUIRES_CONFIRMATION";
      readonly actionId: ActionId;
      readonly risk: RiskLevel;
      /** Delivered to the user's session via ConfirmationChannel; never placed in PlannerFeedback. */
      readonly confirmationId: ConfirmationId;
    })
  | (DecisionBase & {
      readonly outcome: Exclude<Outcome, "ALLOWED" | "REQUIRES_CONFIRMATION">;
      readonly reason: ReasonCode;
      readonly stage: PipelineStage;
      /** Name as received (truncated), for audit only. */
      readonly attemptedAction?: string;
      readonly issues?: readonly FeedbackIssue[];
    });

// ---------------------------------------------------------------------------
// Output to the planner (the ONLY thing the model learns)
// ---------------------------------------------------------------------------
export type PlannerCategory =
  | "ok"
  | "not_available"
  | "invalid_input"
  | "needs_user_confirmation"
  | "try_later";

/**
 * Contains the outcome type and a closed-set category, plus, for INVALID_PARAMETERS only,
 * field paths with generic codes. MUST NOT contain: internal reasons, stack traces, secrets,
 * policy or permission names, confirmation ids or tokens, parameter values, or any hint that
 * an inaccessible resource exists (FR-015, SC-009). Mapping table: research D14.
 * An authorized execution that fails remains ALLOWED, with category try_later (T091).
 */
export interface PlannerFeedback {
  readonly outcome: Outcome;
  readonly category: PlannerCategory;
  readonly issues?: readonly FeedbackIssue[];
}

// ---------------------------------------------------------------------------
// The seam the AI layer uses
// ---------------------------------------------------------------------------
/**
 * Bound to ONE authenticated session and ONE run by the composition root. The AI layer cannot
 * choose, see, or alter the context it is bound to.
 */
export interface ProposalSubmitter {
  submit(call: ProposalCall): Promise<PlannerFeedback>;
}

export interface PolicyGateway {
  /** Called by the composition root, never by AI-layer code. */
  forSession(ctx: AuthorizationContext, run: PlannerRunMeta): ProposalSubmitter;
}

// ---------------------------------------------------------------------------
// Configuration (all values configurable; defaults in research D12)
// ---------------------------------------------------------------------------
export interface LimitConfig {
  readonly proposalsPerTurn: number;
  readonly executionsPerTurn: number;
  readonly maxChainDepth: number;
  readonly turnBudgetMs: number;
  readonly perUserPerMinute: RateLimitRule;
  readonly perTenantPerMinute: RateLimitRule;
  readonly perUserPerCapabilityPerMinute: RateLimitRule;
  readonly highRiskPerUserPerHour: RateLimitRule;
  readonly denialThrottle: { readonly denials: number; readonly windowSeconds: number; readonly blockSeconds: number };
}

export interface GatewayConfig {
  readonly limits: LimitConfig;
  readonly maxPayloadBytes: number; // default 16384
  readonly maxJsonDepth: number; // default 8
  readonly replayRetentionSeconds: number; // default 86400
  readonly confirmationDefaultTtlSeconds: number; // default 300; capped at 900
  readonly hookTimeoutMs: number; // default 2000
  /** Overall deadline for ONE proposal, enforced by the pipeline runner across all stages; default 10000. */
  readonly proposalBudgetMs?: number;
}

export interface GatewayDependencies {
  readonly registry: ActionRegistry;
  /** Held privately by the Gateway; never exposed to any other module. */
  readonly executors: ExecutorTable;
  /** Static, trusted, empty by default (default deny; FR-006). */
  readonly globalAllowlist: ReadonlySet<ActionId>;
  readonly hooks: {
    readonly permissions: PermissionChecker;
    readonly resources: ResourceAuthorizer;
    readonly pages: PageContextProvider;
  };
  readonly state: SecurityStateStore;
  readonly audit: AuditSink;
  readonly confirmationChannel: ConfirmationChannel;
  readonly config: GatewayConfig;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}
