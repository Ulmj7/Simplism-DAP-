/**
 * T083, POS-01 and ATK-PRIV-04. A suite of denials cannot tell a working Gateway from one that denies everything: these must ALLOW.
 * The oracles are proven able to fail; the scenarios run through the shared end-to-end world (T070).
 */
import { describe, expect, it } from "vitest";
import type { AttackScenario, AuthorizationContext, AuditEvent } from "@dap/contracts";
import { ALICE, BOB, TENANT_A, TENANT_B, VALID_PARAMS, contextViolations, ctx, positiveScenarios, withGateway } from "@dap/testkit";
import type { GatewayWorld, PositiveObservation, WorldUser } from "@dap/testkit";

const alice = ctx(TENANT_A, ALICE);
const scenario = (id: string) => positiveScenarios.find((entry) => entry.id === id)!;
const ev = (type: AuditEvent["type"]) => ({ type }) as AuditEvent;
const validated = { message: "hello" };
const good = (over: Partial<PositiveObservation> = {}): PositiveObservation => ({
  feedback: [{ outcome: "ALLOWED", category: "ok" }], executorCalls: 1, auditEvents: [ev("AI_ACTION_PROPOSED"), ev("AI_ACTION_ALLOWED"), ev("AI_ACTION_EXECUTED")], leakFindings: [],
  executorContexts: [alice], serviceIdentityCalls: 0, requestingUser: alice, validated, receivedParams: [{ message: "hello" }], ...over,
});
const safe = { actionId: "x", risk: "SAFE", changesState: false, targetsResource: false, requiresConfirmation: false } as const;

describe("which capabilities the positive controls apply to", () => {
  it("applies to SAFE capabilities that need no confirmation, and to nothing else", () => {
    for (const entry of positiveScenarios) {
      expect(entry.appliesTo(safe)).toBe(true);
      for (const risk of ["LOW", "MEDIUM", "HIGH", "CRITICAL", "FORBIDDEN"] as const) expect(entry.appliesTo({ ...safe, risk }), `${entry.id} ${risk}`).toBe(false);
      expect(entry.appliesTo({ ...safe, requiresConfirmation: true })).toBe(false);
    }
    expect(positiveScenarios.map((entry) => entry.id)).toEqual(["POS-01", "ATK-PRIV-04"]);
  });
});

describe("POS-01 oracle", () => {
  it("passes one allowed execution with exactly the validated parameters and the full trail", () => expect(scenario("POS-01").verify(good())).toEqual([]));
  it("compares the data of the received parameters, not their prototype: the Gateway's frozen null-prototype object equals the plain validated one", () => {
    const received = Object.freeze(Object.assign(Object.create(null) as Record<string, unknown>, { message: "hello" }));
    expect(scenario("POS-01").verify(good({ receivedParams: [received] }))).toEqual([]);
    expect(scenario("POS-01").verify(good({ receivedParams: [Object.freeze(Object.assign(Object.create(null) as Record<string, unknown>, { message: "other" }))] }))).toContain("the executor did not receive exactly the validated parameters");
  });
  it("rejects non-JSON and hidden extra parameters instead of serializing them away", () => {
    for (const received of [
      { message: "hello", extra: undefined }, { message: NaN }, new Date("2026-01-01"),
      { message: "hello", [Symbol("hidden")]: 1 }, Object.defineProperty({ message: "hello" }, "hidden", { value: 1 }),
      JSON.parse('{"message":"hello","__proto__":{}}'),
    ]) expect(scenario("POS-01").verify(good({ receivedParams: [received] }))).toContain("the executor did not receive exactly the validated parameters");
    expect(scenario("POS-01").verify(good({ validated: { message: null }, receivedParams: [{ message: NaN }] }))).not.toEqual([]);
    expect(scenario("POS-01").verify(good({ validated: "2026-01-01T00:00:00.000Z", receivedParams: [new Date("2026-01-01")] }))).not.toEqual([]);
  });
  it.each([
    ["the proposal was denied", { feedback: [{ outcome: "DENIED", category: "not_available" }] }, "the proposal was not allowed"],
    ["the planner was told try_later", { feedback: [{ outcome: "ALLOWED", category: "try_later" }] }, "the proposal was not allowed"],
    ["two answers", { feedback: [{ outcome: "ALLOWED", category: "ok" }, { outcome: "ALLOWED", category: "ok" }] }, "the proposal was not allowed"],
    ["the executor never ran", { executorCalls: 0 }, "the executor did not run exactly once"], ["the executor ran twice", { executorCalls: 2 }, "the executor did not run exactly once"],
    ["the trail lacks the allow-event", { auditEvents: [ev("AI_ACTION_PROPOSED"), ev("AI_ACTION_EXECUTED")] }, "the trail is not PROPOSED, ALLOWED, EXECUTED"],
    ["the trail has a denial too", { auditEvents: [ev("AI_ACTION_PROPOSED"), ev("AI_ACTION_ALLOWED"), ev("AI_ACTION_DENIED"), ev("AI_ACTION_EXECUTED")] }, "the trail is not PROPOSED, ALLOWED, EXECUTED"],
    ["the executor received other parameters", { receivedParams: [{ message: "other" }] }, "the executor did not receive exactly the validated parameters"],
    ["the executor received extra parameters", { receivedParams: [{ message: "hello", extra: 1 }] }, "the executor did not receive exactly the validated parameters"],
    ["no parameters were received", { receivedParams: [] }, "the executor did not receive exactly the validated parameters"],
  ] as const)("reports: %s", (_name, over, message) => expect(scenario("POS-01").verify(good(over as Partial<PositiveObservation>))).toContain(message));
});

describe("ATK-PRIV-04 oracle", () => {
  it("passes the requesting user's own context and no service identity", () => expect(scenario("ATK-PRIV-04").verify(good())).toEqual([]));
  it("reports an executor that did not run exactly once, and a missing observation", () => {
    expect(scenario("ATK-PRIV-04").verify(good({ executorCalls: 0 }))).toEqual(["the executor did not run exactly once"]);
    expect(scenario("ATK-PRIV-04").verify(good({ executorContexts: [alice, alice] }))).toEqual(["the executor did not run exactly once"]);
    expect(scenario("ATK-PRIV-04").verify({ ...good(), requestingUser: undefined } as never)).toEqual(["no requesting user was observed"]);
  });
  it.each([
    ["another user's context", ctx(TENANT_A, BOB), 0, "the executor was not given the requesting user's own context object"],
    ["a copy of the context", { ...alice } as AuthorizationContext, 0, "the executor was not given the requesting user's own context object"],
    ["another tenant", ctx(TENANT_B, ALICE), 0, "the executor's identity differs from the requesting user's"],
    ["a service identity hook call", alice, 1, "a service-identity hook was invoked"],
  ] as const)("reports %s", (_name, received, calls, message) => {
    expect(contextViolations(received, alice, calls)).toContain(message);
    expect(scenario("ATK-PRIV-04").verify(good({ executorContexts: [received], serviceIdentityCalls: calls }))).toContain(message);
  });
});

/**
 * The scenarios against the REAL gateway, through withGateway(). What tests/security/test-world.gateway.test.ts (T070/T078) already proves is not repeated:
 * a permitted SAFE action runs once with the frozen params and the PROPOSED, ALLOWED, EXECUTED trail; the executor's `security` is the submitter's minted context;
 * two users are independent. What the two scenario oracles add, and this section runs: the independent expectation of the validated params, the identity of
 * the context object, the oracle's own sensitivity to a wrong world. There is no service-identity port; context substitution, rather than an unreachable bait counter, is the evidence.
 */
describe("POS-01 and ATK-PRIV-04 against the REAL gateway, through withGateway()", () => {
  const A_ALICE: WorldUser = { tenant: "A", user: ALICE };
  /** The PositiveTarget view of one world and one user: the validated params are the test's own expectation, not read back from the world. */
  async function positiveTarget(world: GatewayWorld, who: WorldUser) {
    const submitter = await world.submitterFor(who);
    const base = world.targetFor("testSafeEcho", who);
    return { ...base, validProposal: () => ({ raw: world.proposal("testSafeEcho").raw, validated: { message: VALID_PARAMS.testSafeEcho.message } }),
      requestingUser: submitter.context, executorContexts: () => world.executor("testSafeEcho").callLog.map((call) => call.security) };
  }
  /** These two scenarios read the context OBJECT and the received parameters from the observation, which runScenario's data snapshot would replace by copies, so the scenario's own `run` is called. */
  const drive = (entry: AttackScenario, target: object) => entry.run(target as never);
  const traits = (world: GatewayWorld) => world.targetFor("testSafeEcho", A_ALICE);

  it.each(["POS-01", "ATK-PRIV-04"])("%s: the scenario passes on a permitted SAFE capability, and it applies to it", async (id) => {
    const world = withGateway();
    expect(scenario(id).appliesTo(traits(world))).toBe(true);
    const observation = await drive(scenario(id), await positiveTarget(world, A_ALICE));
    expect(scenario(id).verify(observation)).toEqual([]);
    expect(observation.feedback).toEqual([{ outcome: "ALLOWED", category: "ok" }]);
    expect(observation.executorCalls).toBe(1);
    expect(observation.auditEvents.map((event) => event.type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
  });

  it("ATK-PRIV-04: the executor's context is the requesting user's own object, in tenant B as in tenant A, without substituting a service-shaped context", async () => {
    for (const who of [A_ALICE, { tenant: "B", user: ALICE } as WorldUser]) {
      const world = withGateway();
      const target = await positiveTarget(world, who);
      const observation = await drive(scenario("ATK-PRIV-04"), target);
      expect(scenario("ATK-PRIV-04").verify(observation)).toEqual([]);
      expect(target.executorContexts()[0]).toBe(target.requestingUser);
      expect(target.requestingUser.tenantId).toBe(world.tenants[who.tenant]);
    }
  });

  it("an unprivileged user's call does not count as a positive control", async () => {
    const carol = await positiveTarget(withGateway(), { tenant: "A", user: "carol" });
    const denied = await drive(scenario("POS-01"), carol);
    expect(scenario("POS-01").verify(denied).length).toBeGreaterThan(0); // a world that denies everything fails the positive control
  });

  it("the oracle sees a wrong world: another user's context, a service-shaped copy or a changed parameter fails the same scenarios", async () => {
    const world = withGateway();
    const target = await positiveTarget(world, A_ALICE);
    const bob = (await world.submitterFor({ tenant: "A", user: "bob" })).context;
    const spoofed = { ...target, requestingUser: bob };
    expect(scenario("ATK-PRIV-04").verify(await drive(scenario("ATK-PRIV-04"), spoofed))).toContain("the executor was not given the requesting user's own context object");
    const changed = { ...(await positiveTarget(withGateway(), A_ALICE)), validProposal: () => ({ raw: { action: "testSafeEcho", params: { message: "hello from the test kit" } }, validated: { message: "something else" } }) };
    expect(scenario("POS-01").verify(await drive(scenario("POS-01"), changed))).toContain("the executor did not receive exactly the validated parameters");
  });
});
