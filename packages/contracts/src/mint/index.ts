/**
 * @dap/contracts/mint — the trusted minting runtime (research D5).
 *
 * The ONLY way to produce a recognized `AuthorizationContext` or `ExecutionGrant`. Both are
 * tracked in module-private registries that live in the restricted mint tree
 * (`./context-registry.ts` and `./grant-registry.ts`). No registry record is ever exposed, so no
 * caller can fabricate, re-register, reset, or re-arm a grant/context. A plain data literal with
 * the same fields, a spread copy, or a fabricated object therefore fails verification.
 *
 * This subpath is importable ONLY by @dap/security and @dap/testkit (enforced by lint,
 * ATK-ARCH-05). Production code in @dap/actions and the AI layer must not import it — they
 * receive a pre-minted grant only through a Gateway-approved ExecutionCall.
 *
 * Fail-closed: every check below rejects on anything it cannot prove to be minted and valid.
 */
import type { ExecutionGrant } from "../execution.js";
import { consumeIfBound, registerGrant, type GrantBinding } from "./grant-registry.js";

// The full grant binding (requestId, actionId, paramsDigest, tenantId, userId), single-use.
// Re-exported so @dap/security can name it. `tenantId` is validated as a UUID by the caller.
export type { GrantBinding } from "./grant-registry.js";

// Minting of AuthorizationContexts is owned by ./context-registry.ts. Exposed HERE from the mint
// subpath only — never from the package barrel.
export { isMintedContext, mintContext as mintAuthorizationContext } from "./context-registry.js";

/**
 * Mint an ExecutionGrant bound to the 5-tuple. The grant is single-use: it can be consumed
 * exactly once, and only by a call whose binding matches all five fields. The grant object and
 * its stored binding snapshot are frozen.
 */
export function mintExecutionGrant(binding: GrantBinding): ExecutionGrant {
  return registerGrant(binding) as unknown as ExecutionGrant;
}

/**
 * Verify and consume a grant atomically (single-use).
 *
 * Returns true exactly once, and only if:
 *   - `grant` was minted by `mintExecutionGrant` (not a literal / copy), and
 *   - it has not been consumed yet, and
 *   - its stored binding matches `expected` on ALL FIVE fields (requestId, actionId,
 *     paramsDigest, tenantId, userId).
 *
 * Any mismatch (or a forged / already-used grant) returns false and does NOT consume the
 * grant, so a later call carrying the correct binding can still succeed. Reentrancy-safe:
 * `expected`'s fields are read once into locals before the decision (see grant-registry.ts).
 */
export function consumeExecutionGrant(grant: unknown, expected: GrantBinding): boolean {
  return consumeIfBound(grant, expected);
}
