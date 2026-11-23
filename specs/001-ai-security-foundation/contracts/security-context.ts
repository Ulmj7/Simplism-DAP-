/**
 * @dap/contracts: security-context.ts
 *
 * AuthorizationContext and the ports the HOST APPLICATION implements. This feature builds
 * no authentication or authorization system; it asks the host for trusted facts and
 * fails closed when the host cannot answer (FR-021..FR-025).
 *
 * Rules for every port in this file (enforced by the Gateway's hook wrapper):
 *  - every call has a timeout (default 2000 ms);
 *  - a throw, a timeout, or an answer of the wrong shape is treated as DENY;
 *  - for boolean answers, only the literal `true` means allow.
 *
 * Constitution: I, II, IX, X, XVI
 */
import type {
  IsoInstant,
  PageId,
  PermissionId,
  PlannerRunMeta,
  ResolvedResource,
  ResourceRef,
  SessionId,
  TenantId,
  UserId,
} from "./core";

declare const __authContext: unique symbol;

/**
 * Trusted, immutable identity for one authenticated session. Produced ONLY by the security
 * module's SecurityContextFactory (via the restricted `@dap/contracts/mint` subpath).
 * The Gateway rejects any object it cannot recognize as minted, so a plain data literal
 * with the same fields is useless.
 *
 * Deliberately contains NO permissions or roles: those are checked live through
 * PermissionChecker so a stale or forged copy can never grant access.
 */
export interface AuthorizationContext {
  readonly [__authContext]: true;
  readonly userId: UserId;
  readonly tenantId: TenantId;
  readonly sessionId: SessionId;
  readonly authenticatedAt: IsoInstant;
  readonly validUntil: IsoInstant;
}

/** Raw, UNBRANDED data returned by the host's authentication. Validated strictly before minting. */
export interface AuthenticatedPrincipal {
  readonly userId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly authenticatedAt: string;
  readonly validUntil: string;
}

/**
 * Host-implemented. Resolves who the caller is from transport evidence (for example the
 * session cookie of an HTTP request). Returns null when not authenticated.
 * Identity can come from nowhere else: never from a proposal, model output, or browser claim.
 */
export interface AuthenticationPort<TEvidence = unknown> {
  authenticate(evidence: TEvidence): Promise<AuthenticatedPrincipal | null>;
}

/** Security-module-implemented. Validates the principal, then mints the context. */
export interface SecurityContextFactory<TEvidence = unknown> {
  /** Returns null (not an error) for unauthenticated, expired, or malformed principals. */
  establish(evidence: TEvidence): Promise<AuthorizationContext | null>;
}

/** Host-implemented. Live permission check for the END USER's own authority (FR-024). */
export interface PermissionChecker {
  has(ctx: AuthorizationContext, permission: PermissionId): Promise<boolean>;
}

/**
 * Host-implemented. Resolves a resource the user may use. Returns null for ALL of:
 * not found, not permitted, belongs to another tenant. The Gateway never learns which
 * (FR-025). The returned tenant MUST equal ctx.tenantId or the Gateway denies.
 */
export interface ResourceAuthorizer {
  resolve(
    ctx: AuthorizationContext,
    ref: ResourceRef,
    permission: PermissionId,
  ): Promise<ResolvedResource | null>;
}

/**
 * Host-implemented. Current page as reported by the (untrusted) browser session state.
 * Used ONLY to narrow what is allowed, never to grant.
 */
export interface PageContextProvider {
  currentPage(ctx: AuthorizationContext, run: PlannerRunMeta): Promise<PageId | null>;
}
