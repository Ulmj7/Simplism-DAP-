/**
 * @dap/contracts: confirmation.ts
 *
 * ConfirmationRequest and the trusted decision path (FR-027..FR-033).
 *
 * Two separate doors, deliberately:
 *   - proposals (AI layer) can only CAUSE a confirmation request to exist;
 *   - decisions (ConfirmationService.decide) are a different entry point that needs an
 *     authenticated user session and that the AI layer has no dependency on.
 *
 * Constitution: II, XIII, XV
 */
import type { ConsequenceSummary } from "./action-definition";
import type {
  ActionId,
  ConfirmationId,
  IsoInstant,
  JsonValue,
  RequestId,
  ResourceRef,
  RiskLevel,
  Sha256Hex,
  TenantId,
  UserId,
} from "./core";
import type { AuthorizationContext } from "./security-context";

export type ConfirmationStatus = "pending" | "accepted" | "rejected" | "invalidated";

/** Server-side record. The model never sees any field of this. */
export interface ConfirmationRequest {
  /** Random handle (crypto-grade UUID). Delivered only to the user's own session. */
  readonly id: ConfirmationId;
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly requestId: RequestId;
  readonly actionId: ActionId;
  readonly definitionVersion: number;
  readonly definitionHash: Sha256Hex;
  /** NORMALIZED parameters, executed exactly as stored. The client never resends parameters. */
  readonly params: JsonValue;
  /** SHA-256 over canonical JSON of {actionId, version, params, resource, tenant, user}. */
  readonly paramsDigest: Sha256Hex;
  readonly resource: ResourceRef | null;
  readonly risk: RiskLevel;
  /** Built from validated parameters and the TRUSTED resolved resource only (FR-029). */
  readonly consequence: ConsequenceSummary;
  readonly status: ConfirmationStatus;
  readonly executionStatus: "none" | "succeeded" | "failed";
  readonly createdAt: IsoInstant;
  /** created from the DATABASE clock plus TTL. Default 300 s, max 900 s (research D10). */
  readonly expiresAt: IsoInstant;
  readonly decidedAt: IsoInstant | null;
}

/** What a trusted UI needs to render a confirmation. */
export interface ConfirmationView {
  readonly id: ConfirmationId;
  readonly actionId: ActionId;
  readonly risk: RiskLevel;
  readonly consequence: ConsequenceSummary;
  readonly expiresAt: IsoInstant;
}

export type ConfirmationDecision = "accept" | "reject";

/** Shown to the HUMAN (not the model), so it may be a little more specific. */
export type ConfirmationDecisionResult =
  | { readonly status: "executed" }
  | { readonly status: "executed_with_failure" } // at-most-once: user must start over
  | { readonly status: "rejected" }
  | {
      readonly status: "not_valid";
      readonly category: "not_found" | "expired" | "already_used" | "no_longer_allowed";
    };

/**
 * The ONLY way to accept or reject. Requires a minted AuthorizationContext, so it cannot be
 * called with identity taken from model output. On accept (in order): load inside tenant scope;
 * check same user, pending, not expired, definition hash and params digest unchanged;
 * RE-RUN permission and resource authorization (all confirmable capabilities, not only CRITICAL);
 * consume atomically (exactly one concurrent accept wins); durable audit; mint grant;
 * execute the STORED parameters.
 */
export interface ConfirmationService {
  listPending(ctx: AuthorizationContext): Promise<readonly ConfirmationView[]>;
  decide(
    ctx: AuthorizationContext,
    input: { readonly confirmationId: string; readonly decision: ConfirmationDecision },
  ): Promise<ConfirmationDecisionResult>;
}

/**
 * Host-implemented. Pushes a pending confirmation to the user's own session (for example over
 * the same authenticated connection that renders guidance). The handle is NEVER returned to
 * the planner. If delivery fails the request still exists and appears in listPending().
 */
export interface ConfirmationChannel {
  deliver(ctx: AuthorizationContext, view: ConfirmationView): Promise<void>;
}
