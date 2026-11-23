import { describe, expect, it } from "vitest";
import type { ExecutionGrant } from "../execution.js";
import {
  consumeExecutionGrant,
  isMintedContext,
  mintAuthorizationContext,
  mintExecutionGrant,
  type GrantBinding,
} from "./index.js";
import type { AuthenticatedPrincipal } from "../security-context.js";

// T019: the minting runtime is the ONLY way to produce a recognized AuthorizationContext or
// ExecutionGrant. A plain data literal with the same fields is useless (ATK-ARCH-03/04), a
// copied reference is useless, and a grant is single-use and bound to a 5-tuple.

function principal(overrides: Partial<AuthenticatedPrincipal> = {}): AuthenticatedPrincipal {
  return {
    userId: "user-alice",
    tenantId: "11111111-1111-4111-8111-111111111111",
    sessionId: "session-1",
    authenticatedAt: "2026-01-01T00:00:00.000Z",
    validUntil: "2026-01-01T00:10:00.000Z",
    ...overrides,
  };
}

function binding(overrides: Record<string, string> = {}): GrantBinding {
  const base = {
    requestId: "req-1",
    actionId: "act-1",
    paramsDigest: "digest-1",
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "user-alice",
    ...overrides,
  };
  return base as unknown as GrantBinding;
}

describe("AuthorizationContext minting (ATK-ARCH-03/04)", () => {
  it("recognizes a context minted by this module", () => {
    const ctx = mintAuthorizationContext(principal());
    expect(isMintedContext(ctx)).toBe(true);
  });

  it("does NOT recognize a plain object literal with the same fields", () => {
    const p = principal();
    const forged = {
      userId: p.userId,
      tenantId: p.tenantId,
      sessionId: p.sessionId,
      authenticatedAt: p.authenticatedAt,
      validUntil: p.validUntil,
    };
    expect(isMintedContext(forged)).toBe(false);
  });

  it("does NOT recognize a spread copy of a minted context", () => {
    const ctx = mintAuthorizationContext(principal());
    const copy = { ...ctx };
    expect(isMintedContext(copy)).toBe(false);
  });

  it("does NOT recognize a plain object, null, or a non-object", () => {
    expect(isMintedContext(null)).toBe(false);
    expect(isMintedContext({})).toBe(false);
    expect(isMintedContext("not-an-object")).toBe(false);
    expect(isMintedContext(42)).toBe(false);
  });
});

describe("ExecutionGrant minting and single-use consumption", () => {
  it("a forged grant (plain literal) is never consumable", () => {
    const expected = binding();
    const forged = {
      requestId: expected.requestId,
      actionId: expected.actionId,
      paramsDigest: expected.paramsDigest,
    };
    expect(consumeExecutionGrant(forged, expected)).toBe(false);
  });

  it("a grant is single-use: the first matching consume wins, the rest fail", () => {
    const b = binding();
    const grant = mintExecutionGrant(b);
    expect(consumeExecutionGrant(grant, b)).toBe(true);
    // Same grant, same binding again: already consumed.
    expect(consumeExecutionGrant(grant, b)).toBe(false);
    // The public ExecutionGrant shape carries only the call fields; still single-use.
    expect(consumeExecutionGrant(grant as ExecutionGrant, b)).toBe(false);
  });

  it("a mismatch on ANY single binding field is rejected (and does not consume)", () => {
    const base = binding();

    const variations: Array<[string, GrantBinding]> = [
      ["requestId", binding({ requestId: "req-OTHER" })],
      ["actionId", binding({ actionId: "act-OTHER" })],
      ["paramsDigest", binding({ paramsDigest: "digest-OTHER" })],
      ["tenantId", binding({ tenantId: "22222222-2222-4222-8222-222222222222" })],
      ["userId", binding({ userId: "user-bob" })],
    ];

    for (const [field, expected] of variations) {
      const grant = mintExecutionGrant(base);
      expect(consumeExecutionGrant(grant, expected), `mismatch on ${field} must fail`).toBe(false);
      // A mismatch must NOT consume the grant: the correct binding still succeeds.
      expect(consumeExecutionGrant(grant, base), `correct binding still usable after a ${field} mismatch`).toBe(true);
    }
  });

  it("a fully matching binding is accepted exactly once", () => {
    const b = binding();
    const grant = mintExecutionGrant(b);
    expect(consumeExecutionGrant(grant, b)).toBe(true);
  });

  it("rejects null / non-object grants", () => {
    const b = binding();
    expect(consumeExecutionGrant(null, b)).toBe(false);
    expect(consumeExecutionGrant(undefined, b)).toBe(false);
    expect(consumeExecutionGrant({}, b)).toBe(false);
  });
});

describe("grant registry hardening (input aliasing + getter reentrancy)", () => {
  it("does not alias the caller's binding: mutating the original after minting cannot rebind the grant (B)", () => {
    const original: GrantBinding = binding();
    const grant = mintExecutionGrant(original);

    // Mutate the ORIGINAL binding object to tenant B / bob AFTER minting.
    const mutable = original as unknown as Record<string, string>;
    mutable.tenantId = "22222222-2222-4222-8222-222222222222";
    mutable.userId = "user-bob";

    // Consuming against the MUTATED values must be false: the grant is bound to the original snapshot.
    const mutatedExpected: GrantBinding = {
      requestId: "req-1",
      actionId: "act-1",
      paramsDigest: "digest-1",
      tenantId: "22222222-2222-4222-8222-222222222222",
      userId: "user-bob",
    } as unknown as GrantBinding;
    expect(consumeExecutionGrant(grant, mutatedExpected)).toBe(false);

    // Consuming against the ORIGINAL values is still true.
    const originalExpected: GrantBinding = {
      requestId: "req-1",
      actionId: "act-1",
      paramsDigest: "digest-1",
      tenantId: "11111111-1111-4111-8111-111111111111",
      userId: "user-alice",
    } as unknown as GrantBinding;
    expect(consumeExecutionGrant(grant, originalExpected)).toBe(true);
  });

  it("a hostile getter on `expected` that consumes the same grant cannot double-consume (C)", () => {
    const b = binding();
    const grant = mintExecutionGrant(b);
    let consumedCount = 0;

    // A `requestId` getter that, when read, recursively consumes the grant with a correct binding.
    const hostile: GrantBinding = {
      actionId: b.actionId,
      paramsDigest: b.paramsDigest,
      tenantId: b.tenantId,
      userId: b.userId,
      get requestId() {
        const inner = consumeExecutionGrant(grant, b); // fires BEFORE the outer reads requestId
        if (inner) consumedCount += 1;
        return b.requestId; // then return the correct id
      },
    } as unknown as GrantBinding;

    const outer = consumeExecutionGrant(grant, hostile);
    if (outer) consumedCount += 1;

    // Total successful consumptions must be <= 1 (the inner one); the outer must be rejected.
    expect(consumedCount).toBeLessThanOrEqual(1);
    // The grant is now consumed: any further correct consume fails.
    expect(consumeExecutionGrant(grant, b)).toBe(false);
  });
});
