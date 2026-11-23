/**
 * @dap/contracts/src/mint/context-registry.ts — the trusted AuthorizationContext registry (T022).
 *
 * Owns the module-private WeakSet of minted contexts. Reachable ONLY through `@dap/contracts/mint`
 * (or by relative path from inside the same package). Nothing is exported that reaches the set,
 * so no external module can add, remove, or clear an entry. A structurally identical plain literal
 * is never recognized.
 */
import type { AuthorizationContext, AuthenticatedPrincipal } from "../security-context.js";

// Module-private registry of minted contexts.
const mintedContexts = new WeakSet<AuthorizationContext>();

/**
 * Mint an AuthorizationContext from a strictly-validated principal. The returned object is
 * FROZEN (runtime mutation of tenantId/userId/sessionId would defeat tenant isolation) and is
 * recognized ONLY by identity via `isMintedContext`; a structurally identical literal is not.
 */
export function mintContext(principal: AuthenticatedPrincipal): AuthorizationContext {
  const ctx = {
    userId: principal.userId,
    tenantId: principal.tenantId,
    sessionId: principal.sessionId,
    authenticatedAt: principal.authenticatedAt,
    validUntil: principal.validUntil,
  };
  Object.freeze(ctx);
  mintedContexts.add(ctx as AuthorizationContext);
  return ctx as AuthorizationContext;
}

/**
 * Type guard. True ONLY for an object minted by `mintContext`. A plain literal with the same
 * fields, a spread copy, or any other object returns false.
 */
export function isMintedContext(ctx: unknown): ctx is AuthorizationContext {
  return typeof ctx === "object" && ctx !== null && mintedContexts.has(ctx as AuthorizationContext);
}
