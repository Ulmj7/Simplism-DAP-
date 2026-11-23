/**
 * T070 / T078: the minimal test world for the REAL Policy Gateway, and the authorize path proven end to end through it. Nothing between the
 * submitter and the executor is replaced: context, intake, rate limit, replay, resolve, validate, authorize, risk, confirmation, audit and
 * execute all run; only the host ports and the in-memory adapters are fakes.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig } from "@dap/security";
import { ALICE, BOB, CAROL, TENANT_A, TENANT_B, VALID_PARAMS, WIDE_GATEWAY_CONFIG, isMintedWorldContext, withGateway } from "@dap/testkit";
import type { GatewayWorld, WorldUser } from "@dap/testkit";

const A_ALICE: WorldUser = { tenant: "A", user: ALICE };
const B_ALICE: WorldUser = { tenant: "B", user: ALICE };
const A_BOB: WorldUser = { tenant: "A", user: BOB };
const A_CAROL: WorldUser = { tenant: "A", user: CAROL };
const types = (world: GatewayWorld) => world.events().map((event) => event.type);
const NOT_AVAILABLE = JSON.stringify({ outcome: "DENIED", category: "not_available" });

describe("a permitted SAFE action reaches the executor exactly once", () => {
  it("with exactly the validated, frozen parameters, and the audit shows PROPOSED, ALLOWED, EXECUTED", async () => {
    const world = withGateway();
    const alice = await world.submitterFor(A_ALICE);
    expect(await alice.submit(world.proposal("testSafeEcho"))).toEqual({ outcome: "ALLOWED", category: "ok" });
    const executor = world.executor("testSafeEcho");
    expect(executor.calls).toBe(1);
    expect(executor.receivedParams).toEqual([VALID_PARAMS.testSafeEcho]);
    expect(Object.isFrozen(executor.receivedParams[0])).toBe(true);
    expect(types(world)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
    expect(world.events()[1]).toMatchObject({ outcome: "ALLOWED", reason: "allowed", risk: "SAFE", actionId: "testSafeEcho", tenantId: TENANT_A, userId: ALICE });
    expect(world.executorCalls()).toBe(1); // no other capability ran
  });

  it("a LOW action is allowed the same way, and every other capability's executor stayed at zero", async () => {
    const world = withGateway();
    const alice = await world.submitterFor(A_ALICE);
    expect(await alice.submit(world.proposal("testLowNavigate"))).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(world.executor("testLowNavigate").calls).toBe(1);
    expect(world.executorCalls()).toBe(1);
  });

  it("a HIGH action needs a confirmation: the executor stays at zero and there is no ALLOWED event", async () => {
    const world = withGateway();
    const alice = await world.submitterFor(A_ALICE);
    expect(await alice.submit(world.proposal("testHighPublish"))).toEqual({ outcome: "REQUIRES_CONFIRMATION", category: "needs_user_confirmation" });
    expect(world.executorCalls()).toBe(0);
    expect(types(world)).toEqual(["AI_ACTION_PROPOSED", "AI_CONFIRMATION_REQUIRED"]);
  });
});

describe("a user lacking the permission is denied", () => {
  it("UNAUTHORIZED, permission_missing, executor at zero, no ALLOWED event", async () => {
    const world = withGateway();
    const carol = await world.submitterFor(A_CAROL);
    expect(await carol.submit(world.proposal("testSafeEcho"))).toEqual({ outcome: "UNAUTHORIZED", category: "not_available" });
    expect(world.executorCalls()).toBe(0);
    expect(types(world)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_DENIED"]);
    expect(world.events()[1]).toMatchObject({ outcome: "UNAUTHORIZED", reason: "permission_missing", userId: CAROL });
    expect(world.events().some((event) => event.type === "AI_ACTION_ALLOWED")).toBe(false);
  });

  it("a permission that is granted and then revoked stops the very next proposal", async () => {
    const world = withGateway();
    const bob = await world.submitterFor(A_BOB);
    expect((await bob.submit(world.proposal("testSafeEcho"))).outcome).toBe("ALLOWED");
    world.revokePermission(A_BOB, "perm.test.safe-echo");
    expect((await bob.submit(world.proposal("testSafeEcho"))).outcome).toBe("UNAUTHORIZED");
    expect(world.executor("testSafeEcho").calls).toBe(1);
    world.grantPermission(A_BOB, "perm.test.safe-echo");
    expect((await bob.submit(world.proposal("testSafeEcho"))).outcome).toBe("ALLOWED");
  });

  it("only a literal true from the host allows: any other answer is denied", async () => {
    for (const answer of ["yes", 1, {}, [true], null, undefined, "true"]) {
      const world = withGateway();
      world.setPermissionAnswer(answer);
      const alice = await world.submitterFor(A_ALICE); // alice holds the permission for real, so only the override can deny her
      expect((await alice.submit(world.proposal("testSafeEcho"))).outcome, JSON.stringify(answer)).not.toBe("ALLOWED");
      expect(world.executorCalls()).toBe(0);
    }
    const world = withGateway();
    world.setPermissionAnswer(true);
    expect((await (await world.submitterFor(A_CAROL)).submit(world.proposal("testSafeEcho"))).outcome).toBe("ALLOWED");
  });
});

describe("host answer overrides are literal, and only a clear removes them", () => {
  it("setPermissionAnswer(undefined) is the answer undefined (a denial), and clearPermissionAnswer gives the real grants back", async () => {
    const world = withGateway();
    const alice = await world.submitterFor(A_ALICE);
    world.setPermissionAnswer(undefined);
    expect(await alice.submit(world.proposal("testSafeEcho"))).toEqual({ outcome: "DENIED", category: "try_later" }); // a malformed host answer is a dependency failure: fail closed
    expect(world.executorCalls()).toBe(0);
    world.clearPermissionAnswer();
    expect((await alice.submit(world.proposal("testSafeEcho"))).outcome).toBe("ALLOWED");
  });
  it("setResourceAnswer(undefined) is a host that answers undefined (a failure, fail closed), and clearResourceAnswer gives the real table back", async () => {
    const world = withGateway();
    const alice = await world.submitterFor(A_ALICE);
    world.setResourceAnswer(undefined);
    expect(await alice.submit(world.proposal("testHighPublish"))).toEqual({ outcome: "DENIED", category: "try_later" });
    expect(world.executorCalls()).toBe(0);
    world.clearResourceAnswer();
    expect((await alice.submit(world.proposal("testHighPublish"))).outcome).toBe("REQUIRES_CONFIRMATION");
  });
});

describe("world controls added for the denial scenarios", () => {
  it("setGloballyEnabled(false) removes a capability from the global allowlist even for a Gateway already built, and true restores it", async () => {
    const world = withGateway();
    expect((await world.submit(A_ALICE, world.proposal("testSafeEcho"))).outcome).toBe("ALLOWED"); // the Gateway exists now
    world.setGloballyEnabled("testSafeEcho", false);
    expect(await world.submit(A_ALICE, world.proposal("testSafeEcho"))).toEqual({ outcome: "DENIED", category: "not_available" });
    expect(world.executor("testSafeEcho").calls).toBe(1);
    expect(world.events().at(-1)).toMatchObject({ reason: "action_not_enabled" });
    expect((await world.submit(A_ALICE, world.proposal("testLowNavigate"))).outcome).toBe("ALLOWED"); // only the named capability
    world.setGloballyEnabled("testSafeEcho", true);
    expect((await world.submit(A_ALICE, world.proposal("testSafeEcho"))).outcome).toBe("ALLOWED");
  });
  it("inputSchemas replaces the named capability's schema in the registry the Gateway enforces, and no other", async () => {
    const world = withGateway({ inputSchemas: { testSafeEcho: z.strictObject({ message: z.string().max(3) }) } });
    expect((await world.submit(A_ALICE, { callId: "long", raw: { action: "testSafeEcho", params: { message: "four" } } })).outcome).toBe("INVALID_PARAMETERS");
    expect((await world.submit(A_ALICE, { callId: "short", raw: { action: "testSafeEcho", params: { message: "ok" } } })).outcome).toBe("ALLOWED");
    expect((await world.submit(A_ALICE, world.proposal("testLowNavigate"))).outcome).toBe("ALLOWED");
  });
  it("global changes rebuild both replicas, preserve old snapshots and survive restart; reset restores the initial allowlist", async () => {
    const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
    const previous = await Promise.all([1, 2].map((instance) => world.submitterFor(A_ALICE, { instance })));
    world.setGloballyEnabled("testSafeEcho", false);
    // An already bound door uses the real Gateway's captured startup allowlist, not a mutable test-only policy.
    for (const old of previous) expect(await old.submit(world.proposal("testSafeEcho"))).toEqual({ outcome: "ALLOWED", category: "ok" });
    for (const instance of [1, 2]) {
      expect(await world.submit(A_ALICE, world.proposal("testSafeEcho"), { instance })).toEqual({ outcome: "DENIED", category: "not_available" });
      world.restart(instance);
      expect(await world.submit(A_ALICE, world.proposal("testSafeEcho"), { instance })).toEqual({ outcome: "DENIED", category: "not_available" });
    }
    expect(world.executorCalls()).toBe(2);
    world.reset();
    for (const instance of [1, 2]) expect(await world.submit(A_ALICE, world.proposal("testSafeEcho"), { instance })).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(world.executorCalls()).toBe(2);
  });
  it("schema overrides change the real definition hash without mutating other worlds, and reset retains the original override", async () => {
    const ordinary = withGateway();
    const hash = ordinary.deps.registry.get("testSafeEcho")!.definitionHash;
    const changed = withGateway({ inputSchemas: { testSafeEcho: z.strictObject({ message: z.string().max(3) }) } });
    const changedHash = changed.deps.registry.get("testSafeEcho")!.definitionHash;
    expect(changedHash).not.toBe(hash);
    expect(changed.deps.registry.fingerprint).not.toBe(ordinary.deps.registry.fingerprint);
    expect(changed.deps.registry.get("testLowNavigate")!.definitionHash).toBe(ordinary.deps.registry.get("testLowNavigate")!.definitionHash);
    for (const world of [ordinary, withGateway()]) {
      expect(world.deps.registry.get("testSafeEcho")!.definitionHash).toBe(hash);
      expect(await world.submit(A_ALICE, { callId: "original", raw: { action: "testSafeEcho", params: { message: "four" } } })).toEqual({ outcome: "ALLOWED", category: "ok" });
      expect(world.executorCalls()).toBe(1);
    }
    changed.reset();
    expect(changed.deps.registry.get("testSafeEcho")!.definitionHash).toBe(changedHash);
    expect((await changed.submit(A_ALICE, { callId: "replaced", raw: { action: "testSafeEcho", params: { message: "four" } } })).outcome).toBe("INVALID_PARAMETERS");
    expect(changed.executorCalls()).toBe(0);
    expect(await changed.submit(A_ALICE, { callId: "valid", raw: { action: "testSafeEcho", params: { message: "ok" } } })).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(changed.executorCalls()).toBe(1);
    expect(() => withGateway({ inputSchemas: { testSafeEcho: z.object({ message: z.string().max(3) }) } })).toThrow();
  });
  it("the shared wide configuration preserves every non-rate security bound", () => {
    const { limits: widened, ...security } = WIDE_GATEWAY_CONFIG;
    const { limits: defaults, ...originalSecurity } = DEFAULT_GATEWAY_CONFIG;
    expect(security).toEqual(originalSecurity);
    for (const key of ["executionsPerTurn", "maxChainDepth", "turnBudgetMs", "highRiskPerUserPerHour"] as const) expect(widened[key]).toEqual(defaults[key]);
  });
  it("WIDE_GATEWAY_CONFIG does not throttle a long run of denials, where the default configuration does", async () => {
    const denials = async (config?: GatewayConfig) => {
      const world = withGateway(config === undefined ? {} : { config });
      const outcomes = new Set<string>();
      for (let index = 0; index < 20; index++) outcomes.add(JSON.stringify(await world.submit(A_CAROL, world.proposal("testSafeEcho"))));
      return outcomes;
    };
    expect([...(await denials(WIDE_GATEWAY_CONFIG))]).toEqual([JSON.stringify({ outcome: "UNAUTHORIZED", category: "not_available" })]);
    expect((await denials()).size).toBeGreaterThan(1);
  });
});

describe("world controls added for the evidence scenarios", () => {
  it("failPermissionsWith makes the host's permission hook throw that message: the planner hears only try-later, and undefined stops it", async () => {
    const world = withGateway();
    const alice = await world.submitterFor(A_ALICE);
    world.failPermissionsWith("hook down: CANARY");
    expect(await alice.submit(world.proposal("testSafeEcho"))).toEqual({ outcome: "DENIED", category: "try_later" });
    expect(world.executorCalls()).toBe(0);
    world.failPermissionsWith(undefined);
    expect((await alice.submit(world.proposal("testSafeEcho"))).outcome).toBe("ALLOWED");
  });
  it("a recording executor that fails after being recorded counts as a call, and stops failing on request", async () => {
    const world = withGateway();
    world.executor("testSafeEcho").failWith("boom");
    expect(await world.submit(A_ALICE, world.proposal("testSafeEcho"))).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(world.executor("testSafeEcho").calls).toBe(1);
    world.executor("testSafeEcho").failWith(undefined);
    expect(await world.submit(A_ALICE, world.proposal("testSafeEcho"))).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(world.executor("testSafeEcho").calls).toBe(2);
  });

});

describe("world controls added for the PostgreSQL audit proofs", () => {
  it("auditSink: every event is committed to the injected sink before the world's capture records it; the default stays the in-memory capture", async () => {
    const committed: AuditEvent[] = [];
    const seenByCapture: number[] = [];
    const world = withGateway({ auditSink: { append: async (event) => { committed.push(event); seenByCapture.push(world.events().length); } } });
    expect((await world.submit(A_ALICE, world.proposal("testSafeEcho"))).outcome).toBe("ALLOWED");
    expect(committed.map((event) => event.type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
    expect(seenByCapture).toEqual([0, 1, 2]); // the capture trails the sink by exactly the event being written
    expect(world.events()).toEqual(committed);
    expect(withGateway().events()).toEqual([]);
  });
  it("auditSink: a sink that rejects fails the allow-event closed: try later, executor at zero, and the capture holds no ALLOWED", async () => {
    const world = withGateway({ auditSink: { append: async () => { throw new Error("db down: CANARY"); } } });
    expect(await world.submit(A_ALICE, world.proposal("testSafeEcho"))).toEqual({ outcome: "DENIED", category: "try_later" });
    expect(world.executorCalls()).toBe(0);
    expect(world.events()).toEqual([]);
  });
  it("onRun: the observer runs inside the executor body, after the call is recorded, and sees the guarded call", async () => {
    const world = withGateway();
    const seen: unknown[] = [];
    world.executor("testSafeEcho").onRun(async (call) => { seen.push([call.actionId, world.executor("testSafeEcho").calls, world.events().map((event) => event.type)]); });
    await world.submit(A_ALICE, world.proposal("testSafeEcho"));
    expect(seen).toEqual([["testSafeEcho", 1, ["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED"]]]);
    world.executor("testSafeEcho").onRun(undefined);
    await world.submit(A_ALICE, world.proposal("testSafeEcho"));
    expect(seen).toHaveLength(1);
  });
});

describe("a wrong-tenant, inaccessible or nonexistent resource is denied with the same bytes", () => {
  it("other tenant, nonexistent and same-tenant-unauthorized look identical to the planner, and the executor stays at zero", async () => {
    const world = withGateway();
    const alice = await world.submitterFor(A_ALICE);
    const answers = [];
    for (const kind of ["other-tenant", "nonexistent", "same-tenant-unauthorized"] as const) answers.push(await alice.submit(world.resourceProposal("testMediumDraft", kind)));
    expect(answers.map((answer) => JSON.stringify(answer))).toEqual([NOT_AVAILABLE, NOT_AVAILABLE, NOT_AVAILABLE]);
    expect(world.executorCalls()).toBe(0);
    const decisions = world.events().filter((event) => event.type !== "AI_ACTION_PROPOSED");
    expect(decisions.map((event) => event.reason)).toEqual(["resource_not_available", "resource_not_available", "resource_not_available"]);
    expect(JSON.stringify(world.events())).not.toMatch(/B: Sales pipeline|B: Vendor list/);
  });

  it("a host that returns another tenant's resource is a tenant_mismatch, still the same bytes", async () => {
    const world = withGateway();
    world.setResourceAnswer(world.foreignResource("A"));
    const alice = await world.submitterFor(A_ALICE);
    expect(JSON.stringify(await alice.submit(world.resourceProposal("testMediumDraft", "other-tenant")))).toBe(NOT_AVAILABLE);
    expect(world.events().at(-1)).toMatchObject({ reason: "tenant_mismatch" });
    expect(world.executorCalls()).toBe(0);
    expect(JSON.stringify(world.events())).not.toContain(world.foreignDisplayNames("A")[0]);
  });

  it("the same document id in two tenants resolves inside the caller's tenant only", async () => {
    const world = withGateway();
    // "doc-1" exists in both tenants; a MEDIUM action stops at risk (confirmation required) after authorize resolved it in the caller's tenant.
    for (const who of [A_ALICE, B_ALICE]) {
      const answer = await (await world.submitterFor(who)).submit(world.proposal("testMediumDraft"));
      expect(answer.outcome).toBe("REQUIRES_CONFIRMATION");
    }
    expect(world.events().filter((event) => event.type === "AI_CONFIRMATION_REQUIRED").map((event) => [event.tenantId, event.resource])).toEqual([
      [TENANT_A, { type: "document", id: "doc-1" }], [TENANT_B, { type: "document", id: "doc-1" }],
    ]);
  });
});

describe("the executor receives the requesting user's own minted context", () => {
  it("user id, tenant id and session match the requester, the context is the minted one, and nothing from the proposal is in it", async () => {
    const world = withGateway();
    const alice = await world.submitterFor({ ...A_ALICE, session: "alice-session" });
    await alice.submit(world.proposal("testSafeEcho"));
    const [call] = world.executor("testSafeEcho").callLog;
    expect(isMintedWorldContext(call!.security)).toBe(true);
    expect(call!.security).toBe(alice.context);
    expect(call!.security).toMatchObject({ userId: ALICE, tenantId: TENANT_A, sessionId: "alice-session" });
    expect(call!.requestId).toBe(world.events()[0]!.requestId);
  });

  it("claims of identity in the proposal change nothing: they are rejected, not obeyed", async () => {
    const world = withGateway();
    const carol = await world.submitterFor(A_CAROL);
    const claim = { action: "testSafeEcho", params: { ...VALID_PARAMS.testSafeEcho, userId: ALICE, tenantId: TENANT_B, role: "admin" } };
    expect((await carol.submit({ callId: "claim", raw: claim })).outcome).toBe("INVALID_PARAMETERS");
    expect(world.executorCalls()).toBe(0);
  });

  it("two users, and the same user id in two tenants, are independent", async () => {
    const world = withGateway();
    const alice = await world.submitterFor(A_ALICE);
    const aliceInB = await world.submitterFor(B_ALICE);
    const carol = await world.submitterFor(A_CAROL);
    expect((await alice.submit(world.proposal("testSafeEcho"))).outcome).toBe("ALLOWED");
    expect((await carol.submit(world.proposal("testSafeEcho"))).outcome).toBe("UNAUTHORIZED");
    expect((await aliceInB.submit(world.proposal("testSafeEcho"))).outcome).toBe("ALLOWED");
    const calls = world.executor("testSafeEcho").callLog;
    expect(calls.map((call) => [call.security.tenantId, call.security.userId])).toEqual([[TENANT_A, ALICE], [TENANT_B, ALICE]]);
    expect(calls[0]!.security).not.toBe(calls[1]!.security);
  });
});

describe("the world's controls act on the real host ports", () => {
  it("a page the host reports only narrows: a wrong page for a page-bound capability never allows what permission refused", async () => {
    const world = withGateway();
    world.setReportedPage("page.spoofed");
    const carol = await world.submitterFor(A_CAROL);
    expect((await carol.submit(world.proposal("testSafeEcho"))).outcome).toBe("UNAUTHORIZED");
    expect(world.executorCalls()).toBe(0);
  });

  it("an expired session is UNAUTHORIZED, a refused session cannot even submit", async () => {
    const world = withGateway();
    const alice = await world.submitterFor(A_ALICE);
    world.expireSession(A_ALICE);
    expect(await alice.submit(world.proposal("testSafeEcho"))).toEqual({ outcome: "UNAUTHORIZED", category: "not_available" });
    expect(world.executorCalls()).toBe(0);
    const fresh = withGateway();
    fresh.refuseSession(A_ALICE);
    await expect(fresh.submitterFor(A_ALICE)).rejects.toThrow(/session/);
  });

  it("a faulted port denies and the executor stays at zero, for each host port", async () => {
    // (The pages port is only asked for a capability bound to pages; every test capability allows any page, so a fault there has nothing to bite.)
    for (const port of ["permissions", "resources", "replay", "rateLimiter", "tenantPolicy", "audit", "clock"] as const) {
      for (const mode of ["throws", "undefined", "wrong-type"] as const) {
        const world = withGateway();
        const submitter = await world.submitterFor(A_ALICE);
        world.injectFault(port, mode);
        const answer = await submitter.submit(world.proposal(port === "resources" ? "testMediumDraft" : "testSafeEcho"));
        expect(["DENIED", "UNAUTHORIZED"], `${port}/${mode}`).toContain(answer.outcome);
        expect(world.executorCalls(), `${port}/${mode}`).toBe(0);
      }
    }
  });

  it("a cleared fault restores service", async () => {
    const world = withGateway();
    const alice = await world.submitterFor(A_ALICE);
    world.injectFault("permissions", "throws");
    expect((await alice.submit(world.proposal("testSafeEcho"))).outcome).not.toBe("ALLOWED");
    world.clearFault("permissions");
    expect((await alice.submit(world.proposal("testSafeEcho"))).outcome).toBe("ALLOWED");
  });

  it("a capability disabled for one tenant is denied there and allowed in the other", async () => {
    const world = withGateway();
    world.disableCapability("A", "testSafeEcho");
    expect((await (await world.submitterFor(A_ALICE)).submit(world.proposal("testSafeEcho"))).outcome).toBe("DENIED");
    expect((await (await world.submitterFor(B_ALICE)).submit(world.proposal("testSafeEcho"))).outcome).toBe("ALLOWED");
  });

  it("the clock is the world's own and moves only when told to", async () => {
    const world = withGateway();
    const before = world.clock.now();
    await (await world.submitterFor(A_ALICE)).submit(world.proposal("testSafeEcho"));
    expect(world.clock.now()).toBe(before);
    world.advanceClock(5);
    expect(Date.parse(world.clock.now()) - Date.parse(before)).toBe(5000);
  });

  it("events can be filtered by request, and reset returns the whole world to its initial state", async () => {
    const world = withGateway();
    const alice = await world.submitterFor(A_ALICE);
    await alice.submit(world.proposal("testSafeEcho", "one"));
    await alice.submit(world.proposal("testSafeEcho", "two"));
    const ids = world.requestIds();
    expect(ids).toHaveLength(2);
    expect(world.eventsFor(ids[0]!).map((event) => event.type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
    expect(world.events({ type: "AI_ACTION_EXECUTED" })).toHaveLength(2);
    world.revokePermission(A_ALICE, "perm.test.safe-echo");
    world.advanceClock(10);
    world.reset();
    expect(world.events()).toEqual([]);
    expect(world.executorCalls()).toBe(0);
    const again = await world.submitterFor(A_ALICE);
    expect((await again.submit(world.proposal("testSafeEcho", "one"))).outcome).toBe("ALLOWED"); // permission and replay state are fresh
  });

  it("is deterministic: two worlds given the same proposals record identical events (request ids, times and decisions)", async () => {
    const record = async () => {
      const world = withGateway();
      const alice = await world.submitterFor(A_ALICE);
      await alice.submit(world.proposal("testSafeEcho"));
      await alice.submit(world.proposal("testHighPublish", "high"));
      // The audit event ids come from the production event factory (random UUIDs); everything the world controls, including the request ids, is deterministic.
      return JSON.stringify(world.events().map((event) => Object.fromEntries(Object.entries(event).filter(([key]) => key !== "id"))));
    };
    expect(await record()).toBe(await record());
  });
});
