/**
 * T072, ATK-PRIV-01, 02, 05, 06, 07, 08 and the parity oracle. Runs now: the scenario definitions, every oracle proven able to FAIL with
 * hand-built observations, the parity oracle against the real host fakes, and the facts the scenarios rely on (the reserved action names,
 * the schemas that must accept a claim as plain text). The scenario runs against the whole chain are `it.todo` with their precise blockers.
 */
import { describe, expect, it } from "vitest";
import type { AttackObservation, AuditEvent, CapabilityTraits, PermissionId, PlannerFeedback } from "@dap/contracts";
import { buildRegistry } from "@dap/security";
import {
  ALICE, BOB, CAROL, CLAIM_KEYS, FakePermissionChecker, NON_BOOLEAN_ANSWERS, PERMISSION_ACTION_NAMES, PRIVILEGE_CLAIMS, SPOOFED_PAGES, TENANT_A, TENANT_B, VALID_PARAMS,
  ctx, hostParity, parityViolations, privilegeEscalationScenarios, WIDE_GATEWAY_CONFIG, runScenario, stringParamNames, withGateway, testCriticalDelete, testHighPublish, testLowNavigate, testMediumDraft, testSafeEcho, validParamsFor, validParamsForDocument,
} from "@dap/testkit";
import type { DenialScenario, GatewayWorld, WorldUser } from "@dap/testkit";

const scenario = (id: string) => privilegeEscalationScenarios.find((entry) => entry.id === id)!;
const denial = (id: string) => scenario(id) as DenialScenario;
const traitsFor = (actionId: string, risk: CapabilityTraits["risk"] = "SAFE"): CapabilityTraits => ({ actionId, risk, changesState: false, targetsResource: false, requiresConfirmation: false });
const safe = traitsFor("testSafeEcho");
const event = (over: Partial<AuditEvent>): AuditEvent => ({ id: "e", occurredAt: "2026-01-01T00:00:00Z", type: "AI_ACTION_DENIED", requestId: "r", decisionId: "r", tenantId: "t", userId: "u", aiSessionId: "s", turnId: "n", model: "m", actionId: null, definitionVersion: null, paramsView: {}, risk: null, outcome: "UNAUTHORIZED", reason: "permission_missing", confirmationId: null, confirmationState: null, executionResult: null, resource: null, ...over }) as AuditEvent;
const obs = (over: Partial<AttackObservation>): AttackObservation => ({ feedback: [], executorCalls: 0, auditEvents: [], leakFindings: [], ...over });
const denied = (outcome: string, category: string, extra: object = {}): PlannerFeedback => ({ outcome, category, ...extra }) as PlannerFeedback;

describe("the scenarios", () => {
  it("are the catalogue's, in order, all of category privilege-escalation", () => {
    expect(privilegeEscalationScenarios.map((entry) => entry.id)).toEqual(["ATK-PRIV-01", "ATK-PRIV-02", "ATK-PRIV-05", "ATK-PRIV-06", "ATK-PRIV-07", "ATK-PRIV-08"]);
    for (const entry of privilegeEscalationScenarios) expect(entry.category).toBe("privilege-escalation");
  });
  it("apply to capabilities a caller can be authorized for, and never to a FORBIDDEN one", () => {
    for (const id of ["ATK-PRIV-01", "ATK-PRIV-02", "ATK-PRIV-06", "ATK-PRIV-07", "ATK-PRIV-08"]) {
      expect(scenario(id).appliesTo(safe), id).toBe(true);
      expect(scenario(id).appliesTo(traitsFor("testForbiddenShell", "FORBIDDEN")), id).toBe(false);
    }
    expect(scenario("ATK-PRIV-05").appliesTo(traitsFor("testForbiddenShell", "FORBIDDEN"))).toBe(true);
  });
  it("ATK-PRIV-08 needs a capability that executes without confirmation: it must show an allow before the expiry", () => {
    expect(scenario("ATK-PRIV-08").appliesTo({ ...safe, requiresConfirmation: true })).toBe(false);
  });
});

describe("ATK-PRIV-01 cases", () => {
  it("is one proposal with valid parameters, expected UNAUTHORIZED / permission_missing and audited under the action", () => {
    expect(denial("ATK-PRIV-01").cases(safe)).toEqual([{ raw: { action: "testSafeEcho", params: VALID_PARAMS.testSafeEcho }, outcome: "UNAUTHORIZED", reason: "permission_missing", auditedAction: "testSafeEcho" }]);
  });
  it("hands out fresh parameters each time, so one run cannot disturb the next", () => {
    const first = denial("ATK-PRIV-01").cases(safe)[0]!.raw as { params: { message: string } };
    first.params.message = "changed";
    expect((denial("ATK-PRIV-01").cases(safe)[0]!.raw as { params: { message: string } }).params.message).toBe("hello from the test kit");
    expect(VALID_PARAMS.testSafeEcho.message).toBe("hello from the test kit");
  });
});

describe("ATK-PRIV-02 cases", () => {
  it("put every claim into every string parameter, expecting the same UNAUTHORIZED a benign value gets", () => {
    const cases = denial("ATK-PRIV-02").cases(safe);
    const texts = cases.filter((item) => item.outcome === "UNAUTHORIZED");
    expect(texts).toHaveLength(stringParamNames("testSafeEcho").length * PRIVILEGE_CLAIMS.length);
    expect(texts.map((item) => (item.raw as { params: { message: string } }).params.message)).toEqual([...PRIVILEGE_CLAIMS]);
    for (const item of texts) expect(item).toMatchObject({ reason: "permission_missing", auditedAction: "testSafeEcho" });
  });
  it("also claims in extra keys, which a strict schema refuses as unknown keys at the root", () => {
    const extra = denial("ATK-PRIV-02").cases(safe).filter((item) => item.outcome === "INVALID_PARAMETERS");
    expect(extra).toHaveLength(CLAIM_KEYS.length);
    for (const item of extra) expect(item).toMatchObject({ reason: "invalid_parameters", issues: [{ path: "", code: "unknown_key" }] });
    expect(extra.map((item) => Object.keys((item.raw as { params: object }).params).filter((key) => key !== "message")[0])).toEqual([...CLAIM_KEYS]);
  });
  it("the valid parameters are the test kit's, with the opt-out capability sharing the draft capability's", () => {
    expect(validParamsFor("testMediumOptOut")).toEqual(VALID_PARAMS.testMediumDraft);
    expect(validParamsFor("testMediumOptOut")).not.toBe(validParamsFor("testMediumOptOut"));
    expect(validParamsFor("nobody")).toEqual({});
    expect(validParamsForDocument("testCriticalDelete", "doc-9")).toEqual({ documentId: "doc-9" });
    expect(validParamsForDocument("testMediumDraft", "doc-9")).toEqual({ documentId: "doc-9", draft: VALID_PARAMS.testMediumDraft.draft });
  });
  it("covers every string parameter of every capability that has one", () => {
    expect(stringParamNames("testMediumDraft")).toEqual(["documentId", "draft"]);
    expect(denial("ATK-PRIV-02").cases(traitsFor("testMediumDraft", "MEDIUM")).filter((item) => item.outcome === "UNAUTHORIZED")).toHaveLength(2 * PRIVILEGE_CLAIMS.length);
    expect(stringParamNames("testCriticalDelete")).toEqual(["documentId"]);
    expect(stringParamNames("testHighPublish")).toEqual(["documentId"]);
    expect(stringParamNames("unknownCapability")).toEqual([]);
  });
  it("is only meaningful because the real schemas accept each claim as plain text and refuse each claim key", () => {
    const definitions = [testSafeEcho, testLowNavigate, testMediumDraft, testHighPublish, testCriticalDelete];
    const registry = buildRegistry(definitions as never);
    for (const definition of definitions) {
      const schema = registry.get(definition.id)!.definition.inputSchema as { safeParse(value: unknown): { success: boolean } };
      for (const item of denial("ATK-PRIV-02").cases(traitsFor(definition.id))) {
        const params = (item.raw as { params: unknown }).params;
        expect(schema.safeParse(params).success, `${definition.id} ${JSON.stringify(params)}`).toBe(item.outcome === "UNAUTHORIZED");
      }
    }
  });
});

describe("ATK-PRIV-05", () => {
  it("expects every permission-changing name to be refused by policy, audited under the name the planner used", () => {
    const cases = denial("ATK-PRIV-05").cases(safe);
    expect(cases.map((item) => item.auditedAction)).toEqual([...PERMISSION_ACTION_NAMES]);
    for (const item of cases) expect(item).toMatchObject({ outcome: "FORBIDDEN_POLICY", reason: "reserved_forbidden_action", raw: { params: {} } });
  });
  it.each([...PERMISSION_ACTION_NAMES])("%s is classified as a reserved forbidden action by the registry", (name) => {
    expect(buildRegistry([testSafeEcho] as never).isReservedForbidden(name)).toBe(true);
  });
});

describe("ATK-PRIV-06 oracle (non-boolean permission answers)", () => {
  const n = NON_BOOLEAN_ANSWERS.length;
  const good = obs({ feedback: Array.from({ length: n }, () => denied("DENIED", "try_later")) });
  it("covers the truthy non-booleans the catalogue names, and more", () => {
    for (const answer of ["yes", 1, {}]) expect(NON_BOOLEAN_ANSWERS).toContainEqual(answer);
    expect(NON_BOOLEAN_ANSWERS).not.toContain(true);
    expect(NON_BOOLEAN_ANSWERS).not.toContain(false);
  });
  it("passes denials, whether UNAUTHORIZED or DENIED", () => {
    expect(scenario("ATK-PRIV-06").verify(good)).toEqual([]);
    expect(scenario("ATK-PRIV-06").verify(obs({ feedback: Array.from({ length: n }, () => denied("UNAUTHORIZED", "not_available")) }))).toEqual([]);
  });
  it("reports a missing answer inside the list without throwing", () => {
    const sparse = { ...good, feedback: [undefined, ...good.feedback.slice(1)] } as unknown as AttackObservation;
    expect(scenario("ATK-PRIV-06").verify(sparse)).toContain("a non-boolean answer was not denied at 0");
  });
  it.each([
    ["the executor ran", { executorCalls: 1 }, "executor ran"], ["a missing answer", { feedback: good.feedback.slice(1) }, "submission count mismatch"],
    ["an allow", { feedback: [denied("ALLOWED", "ok"), ...good.feedback.slice(1)] }, "a non-boolean answer was not denied at 0"],
    ["an allow reported as try_later", { feedback: [denied("ALLOWED", "try_later"), ...good.feedback.slice(1)] }, "a non-boolean answer was not denied at 0"],
    ["an outcome that is not a denial", { feedback: [denied("INVALID_ACTION", "not_available"), ...good.feedback.slice(1)] }, "a non-boolean answer was not denied at 0"],
    ["a denial that says ok", { feedback: [denied("DENIED", "ok"), ...good.feedback.slice(1)] }, "a non-boolean answer was not denied at 0"],
    ["a feedback with extra fields", { feedback: [denied("DENIED", "try_later", { note: "x" }), ...good.feedback.slice(1)] }, "a non-boolean answer was not denied at 0"],
    ["an allow record", { auditEvents: [event({ type: "AI_ACTION_ALLOWED" })] }, "an allow or result record exists"], ["a result record", { auditEvents: [event({ type: "AI_ACTION_EXECUTED" })] }, "an allow or result record exists"],
    ["a leak", { leakFindings: ["canary:$"] }, "planner output leaked"],
  ] as const)("reports: %s", (_name, over, message) => expect(scenario("ATK-PRIV-06").verify({ ...good, ...over } as AttackObservation)).toContain(message));
});

describe("ATK-PRIV-07 oracle (spoofed page context)", () => {
  const pages = SPOOFED_PAGES.length;
  const unauthorized = denied("UNAUTHORIZED", "not_available");
  const unknownKey = denied("INVALID_PARAMETERS", "invalid_input", { issues: [{ path: "", code: "unknown_key" }] });
  const goodEvents = Array.from({ length: pages }, (_, i) => event({ id: `d${i}`, reason: "permission_missing" }));
  const good = obs({ feedback: [...Array.from({ length: pages }, () => unauthorized), unknownKey, unknownKey, unknownKey], auditEvents: goodEvents });
  it("reads the first decision records only, ignoring PROPOSED records between them", () => {
    const proposed = event({ type: "AI_ACTION_PROPOSED", reason: null, outcome: null });
    const interleaved = obs({ ...good, auditEvents: goodEvents.flatMap((decision) => [proposed, decision]) });
    expect(scenario("ATK-PRIV-07").verify(interleaved)).toEqual([]);
    const wrong = obs({ ...good, auditEvents: [proposed, event({ reason: "context_not_allowed" }), ...goodEvents.slice(1)] });
    expect(scenario("ATK-PRIV-07").verify(wrong)).toContain("a spoofed page was recorded as something other than a missing permission");
  });
  it("passes: a claimed page changes nothing, and the planner cannot name a page at all", () => expect(scenario("ATK-PRIV-07").verify(good)).toEqual([]));
  it.each([
    ["the executor ran", { executorCalls: 1 }, "executor ran"], ["a missing answer", { feedback: good.feedback.slice(1) }, "submission count mismatch"],
    ["the page turned a denial into an allow", { feedback: [denied("ALLOWED", "ok"), ...good.feedback.slice(1)] }, "the spoofed page changed the decision at 0"],
    ["the page turned it into a different denial", { feedback: [denied("DENIED", "not_available"), ...good.feedback.slice(1)] }, "the spoofed page changed the decision at 0"],
    ["a page field in params was accepted", { feedback: [...good.feedback.slice(0, pages), unauthorized, ...good.feedback.slice(pages + 1)] }, `the spoofed page changed the decision at ${pages}`],
    ["the unknown-key answer lost its issue", { feedback: [...good.feedback.slice(0, pages), denied("INVALID_PARAMETERS", "invalid_input"), ...good.feedback.slice(pages + 1)] }, `the spoofed page changed the decision at ${pages}`],
    ["the denial was recorded as a context problem", { auditEvents: [event({ reason: "context_not_allowed" }), ...goodEvents.slice(1)] }, "a spoofed page was recorded as something other than a missing permission"],
    ["a leak", { leakFindings: ["x"] }, "planner output leaked"],
  ] as const)("reports: %s", (_name, over, message) => expect(scenario("ATK-PRIV-07").verify({ ...good, ...over } as AttackObservation)).toContain(message));
});

describe("ATK-PRIV-08 oracle (session expires mid-turn)", () => {
  const good = { ...obs({ feedback: [denied("ALLOWED", "ok"), denied("UNAUTHORIZED", "not_available")], executorCalls: 1, auditEvents: [event({ type: "AI_ACTION_ALLOWED", reason: "allowed" }), event({ reason: "session_expired" })] }), executedBefore: 1 } as AttackObservation;
  it("passes: allowed before, unauthorized after, no execution after, recorded as an expired session", () => expect(scenario("ATK-PRIV-08").verify(good)).toEqual([]));
  it.each([
    ["the first proposal was not allowed (a vacuous control)", { feedback: [denied("DENIED", "not_available"), denied("UNAUTHORIZED", "not_available")] }, "the proposal before expiry was not allowed (the control is vacuous)"],
    ["the proposal after expiry was allowed", { feedback: [denied("ALLOWED", "ok"), denied("ALLOWED", "ok")] }, "the proposal after expiry was not unauthorized"],
    ["the proposal after expiry was told to try later", { feedback: [denied("ALLOWED", "ok"), denied("DENIED", "try_later")] }, "the proposal after expiry was not unauthorized"],
    ["the executor ran after expiry", { executorCalls: 2 }, "the executor ran after the session expired"],
    ["the first proposal did not execute", { executedBefore: 0, executorCalls: 0 }, "the proposal before expiry did not execute exactly once"],
    ["the denial was recorded as a missing permission", { auditEvents: [good.auditEvents[0]!, event({ reason: "permission_missing" })] }, "the denial after expiry was not recorded as an expired session"],
    ["no decision records", { auditEvents: [] }, "the denial after expiry was not recorded as an expired session"],
    ["a leak", { leakFindings: ["x"] }, "planner output leaked"],
  ] as const)("reports: %s", (_name, over, message) => expect(scenario("ATK-PRIV-08").verify({ ...good, ...over } as AttackObservation)).toContain(message));
  it("reports a second answer that carries extra fields", () => {
    const extra = { ...good, feedback: [denied("ALLOWED", "ok"), denied("UNAUTHORIZED", "not_available", { note: "x" })] } as AttackObservation;
    expect(scenario("ATK-PRIV-08").verify(extra)).toContain("the proposal after expiry was not unauthorized");
  });
  it("reads the LAST decision record, ignoring PROPOSED records around it", () => {
    const proposed = event({ type: "AI_ACTION_PROPOSED", reason: null, outcome: null });
    const interleaved = { ...good, auditEvents: [proposed, event({ type: "AI_ACTION_ALLOWED", reason: "allowed" }), proposed, event({ reason: "session_expired" }), proposed] } as AttackObservation;
    expect(scenario("ATK-PRIV-08").verify(interleaved)).toEqual([]);
    const wrong = { ...good, auditEvents: [proposed, event({ type: "AI_ACTION_ALLOWED", reason: "allowed" }), proposed, event({ reason: "permission_missing" }), proposed] } as AttackObservation;
    expect(scenario("ATK-PRIV-08").verify(wrong)).toContain("the denial after expiry was not recorded as an expired session");
  });
  it("reports a missing second answer", () => expect(scenario("ATK-PRIV-08").verify({ ...good, feedback: [denied("ALLOWED", "ok")] } as AttackObservation)).toEqual(["submission count mismatch"]));
});

describe("the parity oracle (the same user through the host's own check)", () => {
  const unauthorized = denied("UNAUTHORIZED", "not_available");
  it("passes when both deny", () => expect(parityViolations({ feedback: unauthorized, host: false, expect: "denied" })).toEqual([]));
  it.each([
    ["the gateway allowed what the host denies", { feedback: denied("ALLOWED", "ok"), host: false, expect: "denied" }, "the gateway allowed what the host's own check denies"],
    ["the gateway allowed what the host denies (any)", { feedback: denied("ALLOWED", "ok"), host: false, expect: "any" }, "the gateway allowed what the host's own check denies"],
    ["a truthy non-boolean host answer is not an allow, so the gateway allow is an escalation", { feedback: denied("ALLOWED", "ok"), host: "yes", expect: "any" }, "the gateway allowed what the host's own check denies"],
    ["the host allows the user the scenario says lacks the permission", { feedback: unauthorized, host: true, expect: "denied" }, "the scenario's user is allowed by the host: the fixture does not lack the permission"],
    ["the gateway denied with another outcome", { feedback: denied("DENIED", "try_later"), host: false, expect: "denied" }, "the gateway denied with an outcome other than UNAUTHORIZED"],
    ["the gateway denied as an invalid action", { feedback: denied("INVALID_ACTION", "not_available"), host: false, expect: "denied" }, "the gateway denied with an outcome other than UNAUTHORIZED"],
  ] as const)("reports: %s", (_name, input, message) => expect(parityViolations(input as never)).toContain(message));
  it("accepts a gateway that denies for another reason when the scenario only wants agreement", () => {
    expect(parityViolations({ feedback: denied("DENIED", "try_later"), host: true, expect: "any" })).toEqual([]);
    expect(parityViolations({ feedback: denied("ALLOWED", "ok"), host: true, expect: "any" })).toEqual([]);
  });

  it("asks the REAL host fake directly: a user without the grant is denied by both, a granted user by neither", async () => {
    const host = new FakePermissionChecker();
    const permission = "perm.test.safe-echo" as PermissionId;
    host.grant(ALICE, permission, TENANT_A);
    expect(await hostParity(host, ctx(TENANT_A, CAROL), permission, unauthorized, "denied")).toEqual([]);
    expect(await hostParity(host, ctx(TENANT_A, BOB), permission, unauthorized, "denied")).toEqual([]);
    expect(await hostParity(host, ctx(TENANT_A, ALICE), permission, unauthorized, "denied")).toEqual(["the scenario's user is allowed by the host: the fixture does not lack the permission"]);
    expect(await hostParity(host, ctx(TENANT_A, ALICE), permission, denied("ALLOWED", "ok"), "any")).toEqual([]);
    expect(await hostParity(host, ctx(TENANT_A, CAROL), permission, denied("ALLOWED", "ok"), "any")).toEqual(["the gateway allowed what the host's own check denies"]);
    expect(host.calls).toBe(5);
  });
  it("a grant in another tenant is no grant: the host check is per tenant", async () => {
    const host = new FakePermissionChecker();
    const permission = "perm.test.safe-echo" as PermissionId;
    host.grant(ALICE, permission, TENANT_B);
    expect(await hostParity(host, ctx(TENANT_A, ALICE), permission, unauthorized, "denied")).toEqual([]);
  });
  it("a host that cannot be asked is a violation, never an allow", async () => {
    const broken = { has: async () => { throw new Error("CANARY"); } };
    expect(await hostParity(broken as never, ctx(TENANT_A, ALICE), "p" as PermissionId, unauthorized, "denied")).toEqual(["the host's own check could not be asked"]);
  });
  it("a host that answers a non-boolean denies (only the literal true allows)", async () => {
    for (const answer of ["yes", 1, {}, undefined]) {
      const host = { has: async () => answer };
      expect(await hostParity(host as never, ctx(TENANT_A, ALICE), "p" as PermissionId, unauthorized, "denied"), String(answer)).toEqual([]);
    }
  });
});

/** A scripted target that only RECORDS what a scenario does to the world and answers with the given feedback: it decides nothing, so it is no gateway. */
function scriptedTarget(answers: PlannerFeedback[], overrides: object = {}) {
  const log: string[] = [];
  const submitted: unknown[] = [];
  let next = 0;
  const target = {
    ...safe, planner: { script: [] }, visibleOutput: undefined, executor: { calls: 0, grantsSeen: 0, receivedParams: [] }, audit: { events: [] },
    validProposal: () => ({ action: "testSafeEcho", params: { message: "hello" } }),
    setPermissionAnswer: (answer: unknown) => { log.push(`answer:${typeof answer === "function" ? "fn" : JSON.stringify(answer) ?? "undefined"}`); },
    setReportedPage: (page: string | null) => { log.push(`page:${page}`); },
    expireSession: () => { log.push("expire"); },
    submit: async (call: { callId: string; raw: unknown }) => { log.push(`submit:${call.callId}`); submitted.push(call.raw); return answers[next++] ?? denied("DENIED", "not_available"); },
    ...overrides,
  };
  return { target, log, submitted };
}

describe("how the driven scenarios drive the world (a scripted target that records, not a gateway)", () => {
  it("ATK-PRIV-06 sets each non-boolean answer, then submits one valid proposal, in order", async () => {
    const { target, log, submitted } = scriptedTarget([]);
    const observation = await scenario("ATK-PRIV-06").run(target as never);
    expect(log).toEqual(NON_BOOLEAN_ANSWERS.flatMap((answer, index) => [`answer:${typeof answer === "function" ? "fn" : JSON.stringify(answer) ?? "undefined"}`, `submit:ATK-PRIV-06-${index}`]));
    expect(submitted).toEqual(NON_BOOLEAN_ANSWERS.map(() => ({ action: "testSafeEcho", params: { message: "hello" } })));
    expect(observation.feedback).toHaveLength(NON_BOOLEAN_ANSWERS.length);
  });
  it("ATK-PRIV-07 reports each spoofed page before its proposal, then puts a page claim into the parameters under three names", async () => {
    const { target, log, submitted } = scriptedTarget([]);
    await scenario("ATK-PRIV-07").run(target as never);
    expect(log).toEqual([...SPOOFED_PAGES.flatMap((page, index) => [`page:${page}`, `submit:ATK-PRIV-07-${index}`]), ...["page", "currentPage", "context"].map((_, i) => `submit:ATK-PRIV-07-${SPOOFED_PAGES.length + i}`)]);
    expect(submitted.slice(SPOOFED_PAGES.length)).toEqual(["page", "currentPage", "context"].map((key) => ({ action: "testSafeEcho", params: { message: "hello", [key]: "page.admin" } })));
  });
  it("ATK-PRIV-08 submits, remembers the executions so far, expires the session, then submits again", async () => {
    const executor = { calls: 1, grantsSeen: 0, receivedParams: [] };
    const { target, log } = scriptedTarget([denied("ALLOWED", "ok"), denied("UNAUTHORIZED", "not_available")], { executor });
    const observation = await scenario("ATK-PRIV-08").run(target as never) as AttackObservation & { executedBefore: number };
    expect(log).toEqual(["submit:ATK-PRIV-08-0", "expire", "submit:ATK-PRIV-08-1"]);
    expect(observation.executedBefore).toBe(1);
    expect(observation.feedback).toEqual([denied("ALLOWED", "ok"), denied("UNAUTHORIZED", "not_available")]);
  });
});

const A_ALICE: WorldUser = { tenant: "A", user: ALICE };
const A_CAROL: WorldUser = { tenant: "A", user: CAROL };
const SAFE_PERMISSION = "perm.test.safe-echo" as PermissionId;
const types = (world: GatewayWorld) => world.events().map((entry) => entry.type);

describe("the scenarios against the REAL gateway, through withGateway() (T072, REQUIRED: ATK-PRIV-01, 02, 06)", () => {
  describe("ATK-PRIV-01: a user without the permission, through the AI path and through the host's own check", () => {
    it("runScenario: UNAUTHORIZED / permission_missing, audited under the action, executor at zero, with the denial oracle satisfied", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const target = world.targetFor("testSafeEcho", A_CAROL);
      const observation = await runScenario(scenario("ATK-PRIV-01"), target);
      expect(denial("ATK-PRIV-01").verify(observation, target)).toEqual([]);
      expect(observation.feedback).toEqual([{ outcome: "UNAUTHORIZED", category: "not_available" }]);
      expect(observation.executorCalls).toBe(0);
      expect(world.executorCalls()).toBe(0);
      expect(world.events().some((entry) => entry.type === "AI_ACTION_ALLOWED" || entry.type === "AI_ACTION_EXECUTED")).toBe(false);
    });
    it("parity: the same user asked through the host's own permission port is denied too, for every test capability the user lacks", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const carol = await world.submitterFor(A_CAROL);
      for (const [actionId, permission] of [["testSafeEcho", "perm.test.safe-echo"], ["testLowNavigate", "perm.test.low-navigate"], ["testMediumDraft", "perm.test.medium-draft"], ["testHighPublish", "perm.test.high-publish"]] as const) {
        const feedback = await carol.submit(world.proposal(actionId));
        expect(await hostParity(world.deps.hooks.permissions, carol.context, permission as PermissionId, feedback, "denied"), actionId).toEqual([]);
      }
      expect(world.executorCalls()).toBe(0);
    });
    it("parity is not vacuous: the permitted user is allowed by BOTH, and the oracle reports a gateway that allows what the host denies", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const alice = await world.submitterFor(A_ALICE);
      const allowed = await alice.submit(world.proposal("testSafeEcho"));
      expect(allowed).toEqual({ outcome: "ALLOWED", category: "ok" });
      expect(await hostParity(world.deps.hooks.permissions, alice.context, SAFE_PERMISSION, allowed, "any")).toEqual([]);
      expect(await hostParity(world.deps.hooks.permissions, alice.context, SAFE_PERMISSION, allowed, "denied")).toEqual(["the scenario's user is allowed by the host: the fixture does not lack the permission"]);
      const carol = await world.submitterFor(A_CAROL);
      expect(await hostParity(world.deps.hooks.permissions, carol.context, SAFE_PERMISSION, allowed, "any")).toEqual(["the gateway allowed what the host's own check denies"]);
    });
    it("the host is the authority: revoking alice's grant denies her through both paths at once, and the executor does not run again", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const alice = await world.submitterFor(A_ALICE);
      expect((await alice.submit(world.proposal("testSafeEcho"))).outcome).toBe("ALLOWED");
      world.revokePermission(A_ALICE, SAFE_PERMISSION);
      const feedback = await alice.submit(world.proposal("testSafeEcho"));
      expect(feedback).toEqual({ outcome: "UNAUTHORIZED", category: "not_available" });
      expect(await hostParity(world.deps.hooks.permissions, alice.context, SAFE_PERMISSION, feedback, "denied")).toEqual([]);
      expect(world.executor("testSafeEcho").calls).toBe(1);
    });
  });

  describe("ATK-PRIV-02: identity, role and permission claims in AI input cannot raise authority", () => {
    it("runScenario: every claim in every string parameter, and every claim key, is answered as the benign call is, executor at zero", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const target = world.targetFor("testSafeEcho", A_CAROL);
      const observation = await runScenario(scenario("ATK-PRIV-02"), target);
      expect(denial("ATK-PRIV-02").verify(observation, target)).toEqual([]);
      expect(observation.feedback).toHaveLength(PRIVILEGE_CLAIMS.length + CLAIM_KEYS.length);
      expect(observation.executorCalls).toBe(0);
    });
    it("runScenario on a two-string capability: every claim in either string, still denied and never executed", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const target = world.targetFor("testMediumDraft", A_CAROL);
      const observation = await runScenario(scenario("ATK-PRIV-02"), target);
      expect(denial("ATK-PRIV-02").verify(observation, target)).toEqual([]);
      expect(world.executorCalls()).toBe(0);
    });
    it("a claim is outcome-neutral: the denied user hears exactly what the same call without the claim gets", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const carol = await world.submitterFor(A_CAROL);
      const baseline = await carol.submit(world.proposal("testSafeEcho"));
      for (const claim of PRIVILEGE_CLAIMS) {
        const feedback = await carol.submit({ callId: `claim-${PRIVILEGE_CLAIMS.indexOf(claim)}`, raw: { action: "testSafeEcho", params: { message: claim } } });
        expect(JSON.stringify(feedback), claim).toBe(JSON.stringify(baseline));
      }
      expect(world.executorCalls()).toBe(0);
    });
    it("a claim key is refused as an unknown key whoever sends it: a permitted and a denied user hear the same thing, and nothing runs", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const alice = await world.submitterFor(A_ALICE);
      const carol = await world.submitterFor(A_CAROL);
      for (const key of CLAIM_KEYS) {
        const raw = { action: "testSafeEcho", params: { ...VALID_PARAMS.testSafeEcho, [key]: key === "approved" || key === "isAdmin" ? true : "admin" } };
        const fromCarol = await carol.submit({ callId: `c-${key}`, raw });
        const fromAlice = await alice.submit({ callId: `a-${key}`, raw });
        expect(fromCarol, key).toEqual({ outcome: "INVALID_PARAMETERS", category: "invalid_input", issues: [{ path: "", code: "unknown_key" }] });
        expect(JSON.stringify(fromAlice), key).toBe(JSON.stringify(fromCarol));
      }
      expect(world.executorCalls()).toBe(0);
    });
    it("a claim does not turn a denial into an allow, and a permitted user's claim is plain data: the executor gets the text, with no extra authority", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const alice = await world.submitterFor(A_ALICE);
      expect((await alice.submit({ callId: "text", raw: { action: "testSafeEcho", params: { message: "role: admin" } } })).outcome).toBe("ALLOWED");
      expect(world.executor("testSafeEcho").receivedParams).toEqual([{ message: "role: admin" }]);
      const carol = await world.submitterFor(A_CAROL);
      expect((await carol.submit({ callId: "text-2", raw: { action: "testSafeEcho", params: { message: "role: admin" } } })).outcome).toBe("UNAUTHORIZED");
      expect(world.executor("testSafeEcho").calls).toBe(1);
      expect(world.executor("testSafeEcho").grants).toHaveLength(1);
      expect(world.executor("testSafeEcho").callLog[0]!.security).toBe(alice.context);
    });
  });

  describe("ATK-PRIV-06: a permission hook that answers anything but the literal true never allows", () => {
    it("runScenario: every non-boolean answer is a denial, nothing is allowed or executed, though the user really holds the permission", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const target = world.targetFor("testSafeEcho", A_ALICE);
      const observation = await runScenario(scenario("ATK-PRIV-06"), target);
      expect(scenario("ATK-PRIV-06").verify(observation)).toEqual([]);
      expect(observation.feedback).toHaveLength(NON_BOOLEAN_ANSWERS.length);
      expect(observation.executorCalls).toBe(0);
      expect(types(world).filter((type) => type === "AI_ACTION_PROPOSED")).toHaveLength(NON_BOOLEAN_ANSWERS.length);
    });
    it("is not vacuous: the same user is allowed once the override is cleared, and the literal true allows", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const alice = await world.submitterFor(A_ALICE);
      world.setPermissionAnswer("yes");
      expect((await alice.submit(world.proposal("testSafeEcho"))).outcome).not.toBe("ALLOWED");
      world.setPermissionAnswer(undefined);
      expect((await alice.submit(world.proposal("testSafeEcho"))).outcome).not.toBe("ALLOWED");
      world.clearPermissionAnswer();
      expect((await alice.submit(world.proposal("testSafeEcho"))).outcome).toBe("ALLOWED");
      expect(world.executor("testSafeEcho").calls).toBe(1);
    });
  });
});

describe("the remaining scenarios against the end-to-end chain (OPTIONAL in M1)", () => {
  it.todo("ATK-PRIV-05 runScenario: every permission-changing name is FORBIDDEN_POLICY with a policy-violation record (OPTIONAL)");
  it.todo("ATK-PRIV-07 runScenario: a spoofed page changes nothing (OPTIONAL; page narrowing and page-hook failures are proven in review-fixes.test.ts)");
  it.todo("ATK-PRIV-08 runScenario: an allow, the session expires, then UNAUTHORIZED (OPTIONAL)");
});
