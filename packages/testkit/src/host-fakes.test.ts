import { describe, expect, it } from "vitest";
import type {
  ActionId,
  AuthenticatedPrincipal,
  ConfirmationId,
  ConfirmationView,
  IsoInstant,
  PageId,
  PermissionId,
  ResolvedResource,
  RiskLevel,
  TenantId,
  UserId,
} from "@dap/contracts";
import { mintAuthorizationContext } from "@dap/contracts/mint";
import {
  FakeAuthenticationPort,
  FakeConfirmationChannel,
  FakePageContextProvider,
  FakePermissionChecker,
  FakeResourceAuthorizer,
  createServiceIdentityHook,
  withServiceIdentityRecording,
} from "./host-fakes.js";

// T031: host fakes. Default behavior is DENY / null / not found. Every fake counts calls.

const TENANT = "11111111-1111-4111-8111-111111111111" as TenantId;
const TENANT_B = "22222222-2222-4222-8222-222222222222" as TenantId;
const ALICE = "user-alice" as UserId;
const BOB = "user-bob" as UserId;
const PERM = "docs:delete" as PermissionId;

function principal(userId: string, tenantId: TenantId): AuthenticatedPrincipal {
  return {
    userId,
    tenantId,
    sessionId: `sess-${userId}`,
    authenticatedAt: "2026-01-01T00:00:00.000Z",
    validUntil: "2026-01-01T00:10:00.000Z",
  };
}

const DOC: ResolvedResource = {
  ref: { type: "document", id: "doc-1" },
  tenantId: TENANT,
  displayName: "Quarterly Report",
};

function view(): ConfirmationView {
  return {
    id: "123e4567-e89b-42d3-a456-426614174000" as ConfirmationId,
    actionId: "act-doc-delete" as ActionId,
    risk: "CRITICAL" as RiskLevel,
    consequence: { title: "Delete document", effects: ["gone"], irreversible: true },
    expiresAt: "2026-01-01T00:05:00.000Z" as IsoInstant,
  };
}

describe("FakeAuthenticationPort", () => {
  it("denies (null) by default and counts calls", async () => {
    const port = new FakeAuthenticationPort();
    expect(await port.authenticate("cookie")).toBeNull();
    expect(await port.authenticate("cookie")).toBeNull();
    expect(port.calls).toBe(2);
  });

  it("returns the configured principal and can be unset", async () => {
    const port = new FakeAuthenticationPort();
    port.setResponse(principal(ALICE, TENANT));
    expect(await port.authenticate("cookie")).toEqual(principal(ALICE, TENANT));
    port.setResponse(null);
    expect(await port.authenticate("cookie")).toBeNull();
    expect(port.calls).toBe(2);
  });
});

describe("FakePermissionChecker", () => {
  it("denies by default and counts calls", async () => {
    const checker = new FakePermissionChecker();
    const ctx = mintAuthorizationContext(principal(ALICE, TENANT));
    expect(await checker.has(ctx, PERM)).toBe(false);
    expect(checker.calls).toBe(1);
  });

  it("grant then revoke per (userId, permission) works", async () => {
    const checker = new FakePermissionChecker();
    const ctx = mintAuthorizationContext(principal(ALICE, TENANT));
    const other = mintAuthorizationContext(principal(BOB, TENANT));

    checker.grant(ALICE, PERM, TENANT);
    expect(await checker.has(ctx, PERM)).toBe(true);
    // Revoking for alice does not touch bob...
    checker.revoke(ALICE, PERM, TENANT);
    expect(await checker.has(ctx, PERM)).toBe(false);
    // ...and a grant for bob does not leak to alice.
    checker.grant(BOB, PERM, TENANT);
    expect(await checker.has(ctx, PERM)).toBe(false);
    expect(await checker.has(other, PERM)).toBe(true);
    expect(checker.calls).toBe(4);
  });
});

describe("FakeResourceAuthorizer", () => {
  it("returns null by default and counts calls", async () => {
    const authorizer = new FakeResourceAuthorizer();
    const ctx = mintAuthorizationContext(principal(ALICE, TENANT));
    expect(await authorizer.resolve(ctx, { type: "document", id: "doc-1" }, PERM)).toBeNull();
    expect(authorizer.calls).toBe(1);
  });

  it("resolves only resources registered for the SAME tenant", async () => {
    const authorizer = new FakeResourceAuthorizer();
    authorizer.registerResource(TENANT, { type: "document", id: "doc-1" }, DOC);

    const alice = mintAuthorizationContext(principal(ALICE, TENANT));
    const aliceInB = mintAuthorizationContext(principal(ALICE, TENANT_B));

    expect(await authorizer.resolve(alice, { type: "document", id: "doc-1" }, PERM)).toEqual(DOC);
    // Same user, other tenant: not found (indistinguishable, FR-025).
    expect(await authorizer.resolve(aliceInB, { type: "document", id: "doc-1" }, PERM)).toBeNull();
    expect(authorizer.calls).toBe(2);
  });
});

describe("FakePageContextProvider", () => {
  it("returns null by default and counts calls", async () => {
    const provider = new FakePageContextProvider();
    const ctx = mintAuthorizationContext(principal(ALICE, TENANT));
    const run = {
      aiSessionId: "run-1",
      turnId: "turn-1",
      model: "model-x",
      depth: 0,
      turnStartedAt: "2026-01-01T00:00:00.000Z" as IsoInstant,
    };
    expect(await provider.currentPage(ctx, run)).toBeNull();
    expect(provider.calls).toBe(1);
  });

  it("returns the configured page after set", async () => {
    const provider = new FakePageContextProvider();
    provider.setPage("page-docs" as PageId);
    const ctx = mintAuthorizationContext(principal(ALICE, TENANT));
    const run = {
      aiSessionId: "run-1",
      turnId: "turn-1",
      model: "model-x",
      depth: 0,
      turnStartedAt: "2026-01-01T00:00:00.000Z" as IsoInstant,
    };
    expect(await provider.currentPage(ctx, run)).toBe("page-docs" as PageId);
  });
});

describe("FakeConfirmationChannel", () => {
  it("records delivered views by default and counts calls", async () => {
    const channel = new FakeConfirmationChannel();
    const ctx = mintAuthorizationContext(principal(ALICE, TENANT));
    await channel.deliver(ctx, view());
    await channel.deliver(ctx, view());
    expect(channel.calls).toBe(2);
    expect(channel.delivered).toHaveLength(2);
    expect(channel.delivered[0]?.actionId).toBe("act-doc-delete");
  });

  it("can be switched to fail delivery, and the recorded list stays unchanged", async () => {
    const channel = new FakeConfirmationChannel();
    channel.failDelivery(true);
    const ctx = mintAuthorizationContext(principal(ALICE, TENANT));
    await expect(channel.deliver(ctx, view())).rejects.toThrow("fault");
    expect(channel.calls).toBe(1);
    expect(channel.delivered).toEqual([]);
  });
});

describe("service identity hook (ATK-PRIV-04)", () => {
  it("records nothing until invoked", () => {
    const hook = createServiceIdentityHook();
    expect(hook.calls).toEqual([]);
  });

  it("records every invocation of a wrapped service-identity object", () => {
    const hook = createServiceIdentityHook();
    const identity = {
      current(): { readonly userId: string } {
        return { userId: "svc-identity" };
      },
      claim(userId: string): string {
        return `claim:${userId}`;
      },
    };
    const wrapped = withServiceIdentityRecording(identity, hook);

    expect(wrapped.current()).toEqual({ userId: "svc-identity" });
    expect(wrapped.claim("alice")).toBe("claim:alice");

    expect(hook.calls).toHaveLength(2);
    expect(hook.calls[0]).toEqual({ method: "current", args: [] });
    expect(hook.calls[1]).toEqual({ method: "claim", args: ["alice"] });
  });
});
