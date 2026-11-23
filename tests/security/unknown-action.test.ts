import { describe, expect, it } from "vitest";
import type { AttackObservation, AuditEvent } from "@dap/contracts";
import { buildRegistry, createEnablementPolicy, InMemoryTenantActionPolicyStore } from "@dap/security";
import { ALICE, ctx, TENANT_A, TENANT_B, testSafeEcho, RESERVED_ATTACK_NAMES, PROTOTYPE_ACTION_NAMES, WIDE_GATEWAY_CONFIG, lookalikeNames, runScenario, unknownActionScenarios, withGateway } from "@dap/testkit";
import type { DenialScenario, GatewayWorld, WorldUser } from "@dap/testkit";

const registry = buildRegistry([testSafeEcho]);
describe("T052 unknown actions", () => {
  it("ATK-UNKNOWN-01 never-registered action has no lookup", () => {
    expect(registry.get(testSafeEcho.id)).toBeDefined();
    expect(registry.get("deleteEverything")).toBeUndefined();
  });
  it.each(RESERVED_ATTACK_NAMES)("ATK-UNKNOWN-02 classifies %s as forbidden", (name) => {
    expect(registry.isReservedForbidden(name)).toBe(true);
    expect(registry.get(name)).toBeUndefined();
  });
  it.each(lookalikeNames(testSafeEcho.id))("ATK-UNKNOWN-03 rejects look-alike %j", (name) => {
    expect(registry.get(name)).toBeUndefined();
  });
  it.each(PROTOTYPE_ACTION_NAMES)("ATK-UNKNOWN-04 rejects prototype name %s", (name) => {
    expect(registry.get(name)).toBeUndefined();
  });
  it("ATK-UNKNOWN-05 global enablement defaults to deny", async () => {
    const policy = createEnablementPolicy({ registry, tenantPolicy: new InMemoryTenantActionPolicyStore() });
    expect(await policy.isEnabled(ctx(TENANT_A, ALICE), testSafeEcho.id)).toBe(false);
  });
  it("ATK-UNKNOWN-06 tenant disable takes effect immediately and only in that tenant", async () => {
    const tenantPolicy = new InMemoryTenantActionPolicyStore();
    const policy = createEnablementPolicy({ registry, tenantPolicy, globalAllowlist: new Set([testSafeEcho.id]) });
    expect(await policy.isEnabled(ctx(TENANT_A, ALICE), testSafeEcho.id)).toBe(true);
    await tenantPolicy.setDisabled(ctx(TENANT_A, ALICE), testSafeEcho.id, true, "operator");
    expect(await policy.isEnabled(ctx(TENANT_A, ALICE), testSafeEcho.id)).toBe(false);
    expect(await policy.isEnabled(ctx(TENANT_B, ALICE), testSafeEcho.id)).toBe(true);
  });
  // 07 (FORBIDDEN allowlist startup) and 08 (property writes/no mutator) already have registry unit tests.
  it.todo("ATK-UNKNOWN-08 submit 'register tool X' text through the real gateway: fingerprint/definitions unchanged, no executor (OPTIONAL)");
  it("ATK-UNKNOWN-01 oracle accepts complete evidence and detects corrupted decisions, audit linkage and leaks", () => {
    // Synthetic observations test the oracle itself; no gateway is simulated.
    const proposed: AuditEvent = {
      id: "event-1", occurredAt: ctx(TENANT_A, ALICE).authenticatedAt,
      type: "AI_ACTION_PROPOSED", requestId: "request-1" as AuditEvent["requestId"],
      decisionId: "decision-1", tenantId: TENANT_A, userId: ALICE,
      aiSessionId: "session-1", turnId: "turn-1", model: "scripted",
      actionId: "deleteEverything", definitionVersion: null, paramsView: {}, risk: null,
      outcome: "INVALID_ACTION", reason: "unknown_action", confirmationId: null,
      confirmationState: null, executionResult: null, resource: null,
    };
    const denied: AuditEvent = { ...proposed, id: "event-2", type: "AI_ACTION_DENIED" };
    const observation: AttackObservation = {
      feedback: [{ outcome: "INVALID_ACTION", category: "not_available" }],
      executorCalls: 0, auditEvents: [proposed, denied], leakFindings: [],
    };
    const scenario = unknownActionScenarios[0]!;
    expect(scenario.verify(observation)).toEqual([]);
    expect(scenario.verify({ ...observation, feedback: [{ outcome: "INVALID_ACTION", category: "invalid_input" }] })).toContain("decision mismatch at 0");
    expect(scenario.verify({ ...observation, feedback: [{ outcome: "ALLOWED", category: "ok" }] })).toContain("decision mismatch at 0");
    expect(scenario.verify({ ...observation, auditEvents: [proposed, { ...denied, reason: "internal_error" }] })).toContain("audit mismatch at 0");
    expect(scenario.verify({ ...observation, auditEvents: [proposed, { ...denied, requestId: "wrong" as AuditEvent["requestId"] }] })).toContain("audit mismatch at 0");
    expect(scenario.verify({ ...observation, leakFindings: ["canary:$"] })).toContain("planner output leaked");
  });
  for (const scenario of unknownActionScenarios) {
    it(`${scenario.id} independent oracle rejects empty evidence and execution`, () => {
      const empty = { feedback: [], executorCalls: 0, auditEvents: [], leakFindings: [] };
      expect(scenario.verify(empty)).toContain("submission count mismatch");
      expect(scenario.verify({ ...empty, executorCalls: 1 })).toContain("executor ran");
    });
  }
  // ATK-UNKNOWN-04 (prototype names) and 08 (register-a-tool text) are OPTIONAL in M1 and stay definition-level.
  it.todo("ATK-UNKNOWN-04 prototype names through the real gateway (OPTIONAL)");
});

const A_ALICE: WorldUser = { tenant: "A", user: ALICE };
const scenario = (id: string) => unknownActionScenarios.find((entry) => entry.id === id)! as DenialScenario;
/** The registry's own fingerprint and per-definition hashes: any change to the capability list or to a definition changes this string. */
const fingerprintOf = (world: GatewayWorld) => JSON.stringify([world.deps.registry.fingerprint, world.deps.registry.list().map((entry) => [entry.definition.id, entry.definitionHash])]);
const CASES: readonly (readonly [id: string, count: number, prepare: (world: GatewayWorld) => void])[] = [
  ["ATK-UNKNOWN-01", 1, () => undefined],
  ["ATK-UNKNOWN-02", 9, () => undefined],
  ["ATK-UNKNOWN-03", 7, () => undefined],
  ["ATK-UNKNOWN-05", 1, (world) => world.setGloballyEnabled("testSafeEcho", false)],
  ["ATK-UNKNOWN-06", 1, (world) => world.disableCapability("A", "testSafeEcho")],
];

describe("T052 through the REAL gateway, via withGateway() (M1 representatives plus optional look-alikes)", () => {
  it.each(CASES)("%s: generic denial, PROPOSED plus one decision per proposal, nothing executes, the registry is unchanged, and a permitted call still executes", async (id, count, prepare) => {
    const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
    prepare(world);
    const target = world.targetFor("testSafeEcho", A_ALICE);
    const before = fingerprintOf(world);
    const idsBefore = world.deps.registry.list().map((entry) => entry.definition.id);
    const observation = await runScenario(scenario(id), target);
    expect(scenario(id).cases(target)).toHaveLength(count); // the scenario ran the cases it claims to
    expect(observation.feedback).toHaveLength(count);
    expect(scenario(id).verify(observation, target)).toEqual([]);
    expect(observation.executorCalls).toBe(0);
    expect(world.executorCalls()).toBe(0); // no capability's executor ran, not only the one under test
    expect(world.events().filter((event) => event.type === "AI_ACTION_PROPOSED")).toHaveLength(count);
    expect(world.events().filter((event) => event.type !== "AI_ACTION_PROPOSED")).toHaveLength(count);
    expect(world.events().some((event) => event.type === "AI_ACTION_ALLOWED" || event.type === "AI_ACTION_EXECUTED")).toBe(false);
    expect(fingerprintOf(world)).toBe(before);
    expect(world.deps.registry.list().map((entry) => entry.definition.id)).toEqual(idsBefore);
    // The control: the same user, the same capability, a valid call. It is only refused where the scenario's own cause (disable) is in force.
    world.setGloballyEnabled("testSafeEcho", true);
    world.disableCapability("A", "testSafeEcho", false);
    const control = await target.submit(world.proposal("testSafeEcho"));
    expect(control).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(world.executor("testSafeEcho").calls).toBe(1);
  });

  it("every denied case in 02 and 03 is a different name: no look-alike resolves to the registered capability, and each exact name still does", async () => {
    const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
    const names = lookalikeNames(testSafeEcho.id);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain(testSafeEcho.id);
    expect(world.deps.registry.get(testSafeEcho.id)).toBeDefined();
    for (const name of names) expect(world.deps.registry.get(name), JSON.stringify(name)).toBeUndefined();
  });

  it("a disabled capability is disabled only where the scenario says: tenant B's user still executes while tenant A's does not (ATK-UNKNOWN-06)", async () => {
    const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
    world.disableCapability("A", "testSafeEcho");
    expect(await world.submit(A_ALICE, world.proposal("testSafeEcho"))).toEqual({ outcome: "DENIED", category: "not_available" });
    expect(world.executorCalls()).toBe(0);
    expect(await world.submit({ tenant: "B", user: ALICE }, world.proposal("testSafeEcho"))).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(world.executorCalls()).toBe(1);
  });
});
