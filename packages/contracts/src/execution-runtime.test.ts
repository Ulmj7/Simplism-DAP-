import { describe, expect, it } from "vitest";
import type { ExecutionCall, ExecutionResult } from "./execution.js";
import { defineExecutor } from "./execution-runtime.js";
import { isMintedContext, mintAuthorizationContext, mintExecutionGrant } from "./mint/index.js";
import type { GrantBinding } from "./mint/index.js";
import type { AuthenticatedPrincipal } from "./security-context.js";

// T021: defineExecutor's wrapper verifies AND consumes the grant BEFORE running the body
// (FR-017, ATK-ARCH-02). The guard requires:
//   - call.security to be a context minted by mintAuthorizationContext (a plain literal is not),
//   - the grant to be minted, unconsumed, and bound to the call on ALL FIVE fields
//     (requestId, actionId, paramsDigest, security.tenantId, security.userId).
// Any failure throws ExecutionGuardError and runs nothing, and a mismatched attempt must NOT
// consume the grant (so a correct later call still works).

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

interface WorldOpts {
  /** Affects the minted call.security (tenant/user identity carried by the call). */
  principal?: Partial<AuthenticatedPrincipal>;
  /** Affects the grant's binding. */
  bind?: Record<string, string>;
  /** Overrides the call's requestId / actionId / paramsDigest (plain-string values). */
  callField?: Record<string, string>;
}

function world(opts: WorldOpts = {}) {
  const ctx = mintAuthorizationContext(principal(opts.principal));
  const b = binding(opts.bind);
  const grant = mintExecutionGrant(b);
  let runs = 0;
  const call = {
    grant,
    security: ctx,
    params: { name: "Ada" },
    resource: null,
    requestId: b.requestId,
    actionId: b.actionId,
    paramsDigest: b.paramsDigest,
    ...opts.callField,
  } as unknown as ExecutionCall<Record<string, unknown>>;
  const body = async (): Promise<ExecutionResult> => {
    runs += 1;
    return { status: "success", value: "done" };
  };
  const executor = defineExecutor({ id: "exec-1", run: body });
  return { ctx, b, grant, call, executor, getRuns: () => runs };
}

describe("defineExecutor grant guard (ATK-ARCH-02)", () => {
  it("runs the body when the grant, minted context, and all five binding fields match", async () => {
    const { call, executor, getRuns } = world();
    const result = await executor.execute(call);
    expect(result).toEqual({ status: "success", value: "done" });
    expect(getRuns()).toBe(1);
  });

  it("throws and never runs the body when there is no grant", async () => {
    const { ctx, call, executor, getRuns } = world();
    const noGrant: ExecutionCall<Record<string, unknown>> = {
      ...call,
      grant: null as unknown as ExecutionCall<Record<string, unknown>>["grant"],
    };
    await expect(executor.execute(noGrant)).rejects.toThrow();
    expect(getRuns()).toBe(0);
    expect(isMintedContext(ctx)).toBe(true);
  });

  it("throws and never runs the body for a forged (plain literal) grant", async () => {
    const { call, executor, getRuns } = world();
    const forged = { requestId: "req-1", actionId: "act-1", paramsDigest: "digest-1" };
    const forgedCall: ExecutionCall<Record<string, unknown>> = {
      ...call,
      grant: forged as unknown as ExecutionCall<Record<string, unknown>>["grant"],
    };
    await expect(executor.execute(forgedCall)).rejects.toThrow();
    expect(getRuns()).toBe(0);
  });
});

describe("defineExecutor verifies ALL FIVE binding fields (single-field mismatch rejected)", () => {
  it("rejects a wrong actionId; body never runs", async () => {
    const { executor, call, getRuns } = world({ callField: { actionId: "act-OTHER" } });
    await expect(executor.execute(call)).rejects.toThrow();
    expect(getRuns()).toBe(0);
  });

  it("rejects a wrong paramsDigest; body never runs", async () => {
    const { executor, call, getRuns } = world({ callField: { paramsDigest: "digest-OTHER" } });
    await expect(executor.execute(call)).rejects.toThrow();
    expect(getRuns()).toBe(0);
  });

  it("rejects a wrong tenantId (call.security differs from the grant); body never runs", async () => {
    const { executor, call, getRuns } = world({
      principal: { tenantId: "22222222-2222-4222-8222-222222222222" },
    });
    await expect(executor.execute(call)).rejects.toThrow();
    expect(getRuns()).toBe(0);
  });

  it("rejects a wrong userId (call.security differs from the grant); body never runs", async () => {
    const { executor, call, getRuns } = world({ principal: { userId: "user-bob" } });
    await expect(executor.execute(call)).rejects.toThrow();
    expect(getRuns()).toBe(0);
  });

  it("rejects a wrong requestId; body never runs", async () => {
    const { executor, call, getRuns } = world({ callField: { requestId: "req-OTHER" } });
    await expect(executor.execute(call)).rejects.toThrow();
    expect(getRuns()).toBe(0);
  });
});

describe("defineExecutor single-use + fail-closed details", () => {
  it("a mismatched attempt does NOT consume the grant (a correct later call still succeeds)", async () => {
    const w = world();
    // Wrong actionId: rejected, and must NOT burn the grant.
    const bad = {
      grant: w.grant,
      security: w.ctx,
      params: { name: "Ada" },
      resource: null,
      requestId: w.b.requestId,
      actionId: "act-OTHER",
      paramsDigest: w.b.paramsDigest,
    } as unknown as ExecutionCall<Record<string, unknown>>;
    await expect(w.executor.execute(bad)).rejects.toThrow();

    // The correct call with the same grant still succeeds.
    const good = {
      grant: w.grant,
      security: w.ctx,
      params: { name: "Ada" },
      resource: null,
      requestId: w.b.requestId,
      actionId: w.b.actionId,
      paramsDigest: w.b.paramsDigest,
    } as unknown as ExecutionCall<Record<string, unknown>>;
    const res = await w.executor.execute(good);
    expect(res).toEqual({ status: "success", value: "done" });
    expect(w.getRuns()).toBe(1);
  });

  it("throws and never re-runs the body for a consumed grant", async () => {
    const { call, executor, getRuns } = world();
    await executor.execute(call); // consumes
    expect(getRuns()).toBe(1);
    await expect(executor.execute(call)).rejects.toThrow();
    expect(getRuns()).toBe(1);
  });

  it("rejects a plain-literal security (matching ids) and does not consume the grant", async () => {
    const w = world();
    // A structurally identical but NOT-minted context.
    const fakeSecurity = {
      userId: "user-alice",
      tenantId: "11111111-1111-4111-8111-111111111111",
      sessionId: "session-1",
      authenticatedAt: "2026-01-01T00:00:00.000Z",
      validUntil: "2026-01-01T00:10:00.000Z",
    };
    const call = {
      grant: w.grant,
      security: fakeSecurity,
      params: { name: "Ada" },
      resource: null,
      requestId: w.b.requestId,
      actionId: w.b.actionId,
      paramsDigest: w.b.paramsDigest,
    } as unknown as ExecutionCall<Record<string, unknown>>;
    await expect(w.executor.execute(call)).rejects.toThrow();
    expect(w.getRuns()).toBe(0);

    // The grant was NOT burned: a call with a real minted context still works.
    const realCtx = mintAuthorizationContext(principal());
    const good = {
      grant: w.grant,
      security: realCtx,
      params: { name: "Ada" },
      resource: null,
      requestId: w.b.requestId,
      actionId: w.b.actionId,
      paramsDigest: w.b.paramsDigest,
    } as unknown as ExecutionCall<Record<string, unknown>>;
    const res = await w.executor.execute(good);
    expect(res).toEqual({ status: "success", value: "done" });
    expect(w.getRuns()).toBe(1);
  });
});

describe("defineExecutor reentrancy (hostile getter double-execution)", () => {
  it("a hostile call.requestId getter that re-enters the executor cannot double-run the body (C)", async () => {
    const b = binding();
    const ctx = mintAuthorizationContext(principal());
    const grant = mintExecutionGrant(b);
    let runs = 0;
    const executor = defineExecutor({
      id: "exec-1",
      run: async () => {
        runs += 1;
        return { status: "success", value: "done" };
      },
    });

    // A plain, fully-matching call that the getter will feed to the executor.
    const plainCall: ExecutionCall<Record<string, unknown>> = {
      grant,
      security: ctx,
      params: { name: "Ada" },
      resource: null,
      requestId: b.requestId,
      actionId: b.actionId,
      paramsDigest: b.paramsDigest,
    };

    // A call whose `requestId` getter recursively executes the executor with `plainCall`.
    const hostileCall = {
      grant,
      security: ctx,
      params: { name: "Ada" },
      resource: null,
      get requestId() {
        void executor.execute(plainCall); // fires when the guard reads call.requestId
        return b.requestId;
      },
      actionId: b.actionId,
      paramsDigest: b.paramsDigest,
    } as unknown as ExecutionCall<Record<string, unknown>>;

    // The inner execution (triggered by the getter) consumes the grant and runs the body once.
    // The outer call must then be rejected. Total successful body runs must stay <= 1.
    await expect(executor.execute(hostileCall)).rejects.toThrow();
    expect(runs).toBeLessThanOrEqual(1);

    // The grant is consumed: a plain correct call now fails too.
    await expect(executor.execute(plainCall)).rejects.toThrow();
    expect(runs).toBeLessThanOrEqual(1);
  });
});

describe("defineExecutor passes the body the SAME verified call (snapshot, not the original accessor object)", () => {
  it("the body receives the exact minted context the guard verified; a getter returning different values on re-read does not leak", async () => {
    const b = binding(); // tenant A / alice
    const ctxA = mintAuthorizationContext(principal()); // minted A/alice
    const grant = mintExecutionGrant(b);

    // Unminted tenant B / bob — what a hostile getter returns on the SECOND read.
    const ctxB = {
      userId: "user-bob",
      tenantId: "22222222-2222-4222-8222-222222222222",
      sessionId: "session-bad",
      authenticatedAt: "2026-01-01T00:00:00.000Z",
      validUntil: "2026-01-01T00:10:00.000Z",
    };

    let securityReads = 0;
    let seen: { userId: string; tenantId: string; callFrozen: boolean; grantFrozen: boolean } | null = null;
    const executor = defineExecutor({
      id: "exec-1",
      run: async (call: ExecutionCall<Record<string, unknown>>) => {
        // The body reads call.security and the identity values exactly once.
        seen = {
          userId: call.security.userId,
          tenantId: call.security.tenantId,
          callFrozen: Object.isFrozen(call),
          grantFrozen: Object.isFrozen(call.grant),
        };
        return { status: "success", value: "done" };
      },
    });

    // A call whose `security` getter returns the minted A context on the FIRST read and the
    // unminted B context on any later read. If the guard and the body both read `call.security`
    // separately, the body would see B (a different tenant) and the getter would read twice.
    const hostileCall = {
      grant,
      params: { name: "Ada" },
      resource: null,
      requestId: b.requestId,
      actionId: b.actionId,
      paramsDigest: b.paramsDigest,
      get security() {
        securityReads += 1;
        return securityReads === 1 ? ctxA : ctxB;
      },
    } as unknown as ExecutionCall<Record<string, unknown>>;

    const res = await executor.execute(hostileCall);
    expect(res).toEqual({ status: "success", value: "done" });

    // The guard read `security` exactly ONCE (the verified minted A context). The body must see
    // that SAME A context, never the second-read B context, and never re-trigger the getter.
    expect(seen).toEqual({
      userId: "user-alice",
      tenantId: "11111111-1111-4111-8111-111111111111",
      callFrozen: true,
      grantFrozen: true,
    });
    expect(securityReads).toBe(1);
    // The verified context object is precisely the one the guard accepted.
    expect(isMintedContext(ctxA)).toBe(true);
  });
});

describe("minted objects are immutable (tenant isolation)", () => {
  it("reads each call field once and preserves the grant and normalized nested data", async () => {
    const b = binding();
    const security = mintAuthorizationContext(principal());
    const grant = mintExecutionGrant(b);
    const params = Object.freeze({ nested: Object.freeze({ name: "Ada" }) });
    const resource = Object.freeze({
      ref: Object.freeze({ type: "project", id: "project-1" }),
      tenantId: b.tenantId,
      displayName: "Project",
    });
    const values = {
      grant, security, params, resource,
      requestId: b.requestId, actionId: b.actionId, paramsDigest: b.paramsDigest,
    };
    const reads = new Map<string, number>();
    const hostile = Object.defineProperties({}, Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, {
        get() {
          const count = (reads.get(key) ?? 0) + 1;
          reads.set(key, count);
          return count === 1 ? value : undefined;
        },
      }]),
    )) as ExecutionCall<typeof params>;
    const executor = defineExecutor<typeof params>({
      id: "exec-1",
      run: async (call) => {
        expect(Object.isFrozen(call)).toBe(true);
        for (let repeat = 0; repeat < 2; repeat += 1) {
          expect(call.grant).toBe(grant);
          expect(call.security).toBe(security);
          expect(call.params).toBe(params);
          expect(call.params.nested.name).toBe("Ada");
          expect(call.resource).toBe(resource);
          expect(call.resource?.ref.id).toBe("project-1");
        }
        return { status: "success" };
      },
    });
    await executor.execute(hostile);
    for (const key of Object.keys(values)) expect(reads.get(key), key).toBe(1);
    await expect(executor.execute(values)).rejects.toThrow();
  });

  it("a minted context is frozen: assigning tenantId throws TypeError, value unchanged", () => {
    const ctx = mintAuthorizationContext(principal());
    expect(Object.isFrozen(ctx)).toBe(true);
    const before = ctx.tenantId;
    const mutable = ctx as unknown as { tenantId: string };
    expect(() => {
      mutable.tenantId = "99999999-9999-4999-8999-999999999999";
    }).toThrow(TypeError);
    expect(ctx.tenantId).toBe(before);
  });

  it("a minted grant is frozen: assigning actionId throws TypeError, value unchanged", () => {
    const grant = mintExecutionGrant(binding());
    expect(Object.isFrozen(grant)).toBe(true);
    const before = grant.actionId;
    const mutable = grant as unknown as { actionId: string };
    expect(() => {
      mutable.actionId = "act-OTHER";
    }).toThrow(TypeError);
    expect(grant.actionId).toBe(before);
  });
});
