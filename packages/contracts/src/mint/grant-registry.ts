/**
 * @dap/contracts/src/mint/grant-registry.ts — the trusted grant registry (T022, hardened).
 *
 * Lives in the RESTRICTED mint tree so it is reachable ONLY through `@dap/contracts/mint`
 * (or by relative path from inside the same package, e.g. execution-runtime.ts). It NEVER
 * exports a mutable record: callers get only narrow operations — `registerGrant` (returns the
 * frozen grant object) and `consumeIfBound` (boolean, single-use, all-five-fields). No external
 * module can reach a record, so it cannot re-arm a used grant (`record.consumed = false`).
 *
 * B-hardened: at mint time the five primitive binding fields are COPIED into a private frozen
 * snapshot and never stored by reference to the caller's object, so later mutation of the
 * caller's binding cannot change what the grant is bound to.
 *
 * C-hardened: `consumeIfBound` reads every decision-relevant field of `expected` exactly once
 * into local primitives (this is where a hostile getter would fire, before any state change),
 * then checks minted + not-consumed + five-field match and sets `consumed` in one synchronous
 * block. `defineExecutor` uses the SAME `authorizeAndConsume` core, so both paths are
 * reentrancy-safe.
 */
import type { ActionId, RequestId, Sha256Hex, TenantId, UserId } from "../core.js";

/**
 * The full grant binding: (requestId, actionId, paramsDigest, tenantId, userId), single-use.
 * `tenantId` is validated as a UUID by the caller (@dap/security), not here.
 */
export interface GrantBinding {
  readonly requestId: RequestId;
  readonly actionId: ActionId;
  readonly paramsDigest: Sha256Hex;
  readonly tenantId: TenantId;
  readonly userId: UserId;
}

/**
 * The private per-grant record: a FROZEN snapshot of the five binding fields taken at mint time,
 * plus the mutable single-use flag. Stored only in the module-private WeakMap; never returned.
 */
interface GrantRecord {
  readonly requestId: RequestId;
  readonly actionId: ActionId;
  readonly paramsDigest: Sha256Hex;
  readonly tenantId: TenantId;
  readonly userId: UserId;
  consumed: boolean;
}

// The single source of truth for grant identity + consumption. Module-private: nothing here
// exports this map or a record. Only registerGrant / consumeIfBound / authorizeAndConsume touch it.
const grantRegistry = new WeakMap<object, GrantRecord>();

/** Mint a grant bound to the 5-tuple. The returned grant object is FROZEN. */
export function registerGrant(binding: GrantBinding): object {
  // Copy the five primitive fields into a frozen snapshot (never keep the caller's object).
  const snapshot = {
    requestId: binding.requestId,
    actionId: binding.actionId,
    paramsDigest: binding.paramsDigest,
    tenantId: binding.tenantId,
    userId: binding.userId,
  };
  Object.freeze(snapshot);
  const grant: object = {
    requestId: snapshot.requestId,
    actionId: snapshot.actionId,
    paramsDigest: snapshot.paramsDigest,
  };
  Object.freeze(grant);
  grantRegistry.set(grant, { ...snapshot, consumed: false });
  return grant;
}

/**
 * Verify and consume a grant atomically (single-use). Returns true exactly once, and only if
 * the grant was minted here, is not yet consumed, and its stored binding matches `expected` on
 * ALL FIVE fields. Any failure returns false and does NOT consume the grant.
 *
 * Reentrancy-safe: `expected`'s fields are read into locals first (a hostile getter fires there),
 * then the decision is made and the flag set in one synchronous block.
 */
export function consumeIfBound(grant: unknown, expected: GrantBinding): boolean {
  // 1. Read every decision-relevant field of `expected` exactly once into plain locals.
  const requestId = expected.requestId;
  const actionId = expected.actionId;
  const paramsDigest = expected.paramsDigest;
  const tenantId = expected.tenantId;
  const userId = expected.userId;
  // 2. One synchronous block: check + consume against the locals (no `expected.*` reads here).
  return authorizeAndConsume(grant, { requestId, actionId, paramsDigest, tenantId, userId });
}

/** The five fields the guard decides on, already resolved to plain primitives. */
export interface ResolvedFields {
  readonly requestId: RequestId;
  readonly actionId: ActionId;
  readonly paramsDigest: Sha256Hex;
  readonly tenantId: TenantId;
  readonly userId: UserId;
}

/**
 * The ONE shared guard core. `fields` MUST already be read into plain primitives by the caller
 * (hostile getters fire during that read). Synchronous: checks minted + not-consumed + all five
 * fields, then sets consumed. Returns true exactly once per grant.
 */
export function authorizeAndConsume(grant: unknown, fields: ResolvedFields): boolean {
  const record =
    typeof grant === "object" && grant !== null
      ? grantRegistry.get(grant)
      : undefined;
  if (!record) return false; // not minted here (forged / plain literal / foreign object)
  if (record.consumed) return false; // single-use
  if (
    record.requestId !== fields.requestId ||
    record.actionId !== fields.actionId ||
    record.paramsDigest !== fields.paramsDigest ||
    record.tenantId !== fields.tenantId ||
    record.userId !== fields.userId
  ) {
    return false; // single-field mismatch
  }
  record.consumed = true;
  return true;
}
