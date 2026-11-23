/**
 * @dap/contracts: state-ports.ts
 *
 * Shared security state (FR-026, FR-034..FR-036, FR-043). PostgreSQL adapter for production and an
 * in-memory adapter for tests, BOTH validated by the same conformance suite.
 *
 * Every operation takes a TenantScope derived from the AuthorizationContext; there is no
 * method that accepts a bare tenant id from a caller-chosen source, and no cross-tenant read.
 * Expiry and windows use the DATABASE clock so replicas with skewed clocks agree.
 *
 * Constitution: XI, XIII, XV, XVI
 */
import type {
  ActionId,
  ConfirmationId,
  IsoInstant,
  TenantId,
  UserId,
} from "./core";
import type { ConfirmationRequest } from "./confirmation";

export interface Clock {
  /** Process clock. NOT authoritative for expiry; the store's own clock is. */
  now(): IsoInstant;
}

export interface IdGenerator {
  newDecisionId(): string;
  /** crypto-grade random UUID */
  newConfirmationId(): ConfirmationId;
}

export interface TenantScope {
  readonly tenantId: TenantId;
}

// --- Replay -----------------------------------------------------------------
export interface ReplayGuard {
  /**
   * Atomic insert-if-absent keyed by (tenant, key). "duplicate" means already processed.
   * Same key in different tenants is independent. Retention in seconds (default 24 h).
   */
  claim(scope: TenantScope, key: string, retainSeconds: number): Promise<"claimed" | "duplicate">;
}

// --- Rate limiting ----------------------------------------------------------
export interface RateLimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Atomically counts one hit in the bucket's current window. */
  hit(scope: TenantScope, bucketKey: string, rule: RateLimitRule): Promise<RateLimitResult>;
  /** True while the key is in a throttle period (denial throttle). */
  isBlocked(scope: TenantScope, bucketKey: string): Promise<boolean>;
  block(scope: TenantScope, bucketKey: string, seconds: number): Promise<void>;
}

// --- Confirmations ----------------------------------------------------------
export type NewConfirmation = Omit<
  ConfirmationRequest,
  "createdAt" | "expiresAt" | "decidedAt" | "status" | "executionStatus"
> & { readonly ttlSeconds: number };

export interface ConfirmationStore {
  create(scope: TenantScope, record: NewConfirmation): Promise<void>;
  get(scope: TenantScope, id: ConfirmationId): Promise<ConfirmationRequest | null>;
  listPending(scope: TenantScope, userId: UserId): Promise<readonly ConfirmationRequest[]>;
  /**
   * Single atomic conditional transition pending -> accepted, true only if: still pending,
   * not expired by the store clock, and owned by `userId`. Of N concurrent callers, exactly one
   * receives true (SC-005).
   */
  tryAccept(scope: TenantScope, id: ConfirmationId, userId: UserId): Promise<boolean>;
  tryReject(scope: TenantScope, id: ConfirmationId, userId: UserId): Promise<boolean>;
  invalidate(scope: TenantScope, id: ConfirmationId): Promise<void>;
  recordExecution(scope: TenantScope, id: ConfirmationId, status: "succeeded" | "failed"): Promise<void>;
}

// --- Tenant narrowing -------------------------------------------------------
export interface TenantActionPolicyStore {
  /** Read on EVERY proposal; no caching in this feature (research D16). Can only disable. */
  isDisabled(scope: TenantScope, actionId: ActionId): Promise<boolean>;
}

/** Bundle injected into the Gateway. `ping` drives the readiness probe (fail closed). */
export interface SecurityStateStore {
  readonly replay: ReplayGuard;
  readonly rateLimiter: RateLimiter;
  readonly confirmations: ConfirmationStore;
  readonly tenantPolicy: TenantActionPolicyStore;
  ping(): Promise<boolean>;
}
