/**
 * T082, ATK-SECRET-01..04. The oracles are proven able to fail; the scenarios run against the end-to-end world through the shared world (T070).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AuditEvent, PlannerFeedback } from "@dap/contracts";
import { REASON_CODES } from "@dap/contracts";
import { ALICE, FAULT_CANARY, FISHING_ACTIONS, SECRET_CANARIES, WIDE_GATEWAY_CONFIG, runScenario, secretExtractionScenarios, secretFindings, withGateway } from "@dap/testkit";
import type { AttackObservation, GatewayWorld, WorldUser } from "@dap/testkit";

const scenario = (id: string) => secretExtractionScenarios.find((entry) => entry.id === id)!;
const refused: PlannerFeedback = { outcome: "FORBIDDEN_POLICY", category: "not_available" };
const tryLater: PlannerFeedback = { outcome: "DENIED", category: "try_later" };
const obs = (over: Partial<AttackObservation>): AttackObservation => ({ feedback: [], executorCalls: 0, auditEvents: [], leakFindings: [], ...over });
const event = (over: Partial<AuditEvent>): AuditEvent => ({ id: "e", occurredAt: "2026-01-01T00:00:00Z", type: "AI_ACTION_DENIED", requestId: "r", decisionId: "r", tenantId: "t", userId: "u", aiSessionId: "s", turnId: "n", model: "m", actionId: null, definitionVersion: null, paramsView: {}, risk: null, outcome: "DENIED", reason: "dependency_failure", confirmationId: null, confirmationState: null, executionResult: null, resource: null, ...over }) as AuditEvent;

describe("the canaries and the scenario list", () => {
  it("lists ATK-SECRET-01..04 and registers distinct, non-trivial canaries", () => {
    expect(secretExtractionScenarios.map((entry) => entry.id)).toEqual(["ATK-SECRET-01", "ATK-SECRET-02", "ATK-SECRET-03", "ATK-SECRET-04"]);
    expect(new Set(SECRET_CANARIES).size).toBe(SECRET_CANARIES.length);
    expect(SECRET_CANARIES.every((canary) => canary.length >= 16)).toBe(true);
    expect(FISHING_ACTIONS).toContain("getPassword");
    expect(FISHING_ACTIONS).toContain("readEnv");
    for (const entry of secretExtractionScenarios) expect(entry.category).toBe("secret-extraction");
  });
});

describe("secretFindings", () => {
  it("finds nothing in clean output", () => expect(secretFindings(obs({ feedback: [tryLater], auditEvents: [event({})] }))).toEqual([]));
  it.each(SECRET_CANARIES)("finds the canary %s in planner output and in the trail", (canary) => {
    expect(secretFindings(obs({ feedback: [{ outcome: "DENIED", category: "try_later", note: canary } as never] })).join()).toContain("planner output: canary");
    expect(secretFindings(obs({ auditEvents: [event({ actionId: canary })] })).join()).toContain("audit trail: canary");
  });
  it("detects independently encoded, case-folded and truncated canaries in feedback, result data and EVERY audit field", () => {
    const canary = 'QZ"\\\n秘密_private_marker';
    for (const secret of [SECRET_CANARIES[0]!, canary]) {
      for (const value of [secret, JSON.stringify(secret).slice(1, -1), Buffer.from(secret).toString("base64"), encodeURIComponent(secret), secret.toLowerCase(), secret.toUpperCase(), secret.slice(0, 12), secret.split("").map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")]) {
        for (const field of Object.keys(event({}))) {
          expect(secretFindings(obs({ auditEvents: [event({ [field]: value })] }), [secret]), field).not.toEqual([]);
        }
        expect(secretFindings(obs({ feedback: [{ ...tryLater, result: { detail: value } } as never] }), [secret])).not.toEqual([]);
        expect(secretFindings(obs({ auditEvents: [event({ paramsView: { [value]: "hidden key" } })] }), [secret])).not.toEqual([]);
      }
    }
    expect(secretFindings(obs({ feedback: [tryLater], auditEvents: [event({})] }), [canary])).toEqual([]);
  });
  it("finds an extra canary, a stack trace, a secret-shaped value and reported leaks", () => {
    expect(secretFindings(obs({ auditEvents: [event({ actionId: "hunter2" })] }), ["hunter2"])).not.toEqual([]);
    expect(secretFindings(obs({ auditEvents: [event({ actionId: "Error: x\n    at f (/a/b.ts:1:2)" })] })).join()).toContain("stack-trace");
    expect(secretFindings(obs({ feedback: [{ outcome: "DENIED", category: "try_later", note: "sk-abcdefghijklmnopqrstuvwx" } as never] })).join()).toContain("secret-shaped");
    expect(secretFindings(obs({ leakFindings: ["x"] }))).toEqual(["reported: x"]);
  });
  it("does not count a reason code in the trail as a leak (the trail legitimately records them)", () => {
    expect(secretFindings(obs({ auditEvents: [event({ reason: "permission_missing" })] }))).toEqual([]);
  });
});

describe("ATK-SECRET-01 / 03 / 04 oracles", () => {
  it("ATK-SECRET-01 reports a canary and a wrong submission count", () => {
    const four = [tryLater, tryLater, tryLater, tryLater];
    expect(scenario("ATK-SECRET-01").verify(obs({ feedback: four }))).toEqual([]);
    expect(scenario("ATK-SECRET-01").verify(obs({ feedback: four, auditEvents: [event({ actionId: SECRET_CANARIES[0]! })] })).length).toBeGreaterThan(0);
    expect(scenario("ATK-SECRET-01").verify(obs({ feedback: [tryLater] }))).toContain("submission count mismatch");
  });
  it("ATK-SECRET-03 wants the generic try-later answer, an idle executor and codes only in the trail", () => {
    const good = obs({ feedback: [tryLater], auditEvents: [event({})] });
    expect(scenario("ATK-SECRET-03").verify(good)).toEqual([]);
    expect(scenario("ATK-SECRET-03").verify({ ...good, executorCalls: 1 })).toContain("executor ran");
    expect(scenario("ATK-SECRET-03").verify({ ...good, feedback: [{ outcome: "DENIED", category: "not_available" }] })).toContain("feedback is not the generic try-later answer");
    expect(scenario("ATK-SECRET-03").verify({ ...good, feedback: [{ ...tryLater, extra: 1 } as never] })).toContain("feedback is not the generic try-later answer");
    expect(scenario("ATK-SECRET-03").verify({ ...good, auditEvents: [event({ reason: "hook said: hunter2" as never })] })).toEqual(expect.arrayContaining(["an audit record holds a reason that is not a code"]));
    expect(scenario("ATK-SECRET-03").verify({ ...good, auditEvents: [event({ actionId: "password=hunter2" })] }).length).toBeGreaterThan(0);
  });
  it("ATK-SECRET-04 reports a stack trace in the feedback", () => {
    expect(scenario("ATK-SECRET-04").verify(obs({ feedback: [tryLater] }))).toEqual([]);
    expect(scenario("ATK-SECRET-04").verify(obs({ feedback: [{ outcome: "DENIED", category: "try_later", detail: "Error: x\n    at f (/a/b.ts:1:2)" } as never] })).length).toBeGreaterThan(0);
  });
});

describe("ATK-SECRET-02 oracle", () => {
  const all = (feedback: PlannerFeedback) => FISHING_ACTIONS.map(() => feedback);
  it("passes when every fishing proposal is refused as not available and nothing ran", () => expect(scenario("ATK-SECRET-02").verify(obs({ feedback: all(refused) }))).toEqual([]));
  it("also accepts INVALID_ACTION for a name nobody registered", () => expect(scenario("ATK-SECRET-02").verify(obs({ feedback: all({ outcome: "INVALID_ACTION", category: "not_available" }) }))).toEqual([]));
  it.each([["an executor call", { executorCalls: 1 }, "executor ran"], ["a missing answer", { feedback: [refused] }, "submission count mismatch"]] as const)("reports %s", (_name, over, message) => {
    expect(scenario("ATK-SECRET-02").verify({ ...obs({ feedback: all(refused) }), ...over } as AttackObservation)).toContain(message);
  });
  it("reports a proposal that was allowed, or told to try later, or invalid", () => {
    for (const feedback of [{ outcome: "ALLOWED", category: "ok" }, tryLater, { outcome: "INVALID_PARAMETERS", category: "invalid_input" }, { outcome: "UNAUTHORIZED", category: "not_available" }] as PlannerFeedback[]) {
      expect(scenario("ATK-SECRET-02").verify(obs({ feedback: [feedback, ...all(refused).slice(1)] })), JSON.stringify(feedback)).toContain("proposal 0 was not refused as not available");
    }
  });
});

/**
 * The scenarios against the REAL gateway, through withGateway(). The surfaces the planner can see are the PlannerFeedback of each submission; the surface
 * the Gateway's decision leaves behind is the audit trail (the world's captured events), which is where a decision's reason and result are recorded.
 * ATK-SECRET-02's reserved names are also covered by T052 (tests/security/unknown-action.test.ts, ATK-UNKNOWN-02) and prompt-injection.test.ts (ATK-INJECT-01).
 */
const A_ALICE: WorldUser = { tenant: "A", user: ALICE };
const EVERYWHERE = [...SECRET_CANARIES, FAULT_CANARY, "hunter2"];
const REASONS: ReadonlySet<string> = new Set(REASON_CODES);
const observe = (world: GatewayWorld, feedback: readonly PlannerFeedback[]): AttackObservation => ({ feedback: [...feedback], executorCalls: world.executorCalls(), auditEvents: [...world.events()], leakFindings: [] });
/** Everything a planner or a reviewer could read, as one string: the answers and every audit event. */
const surface = (o: AttackObservation) => JSON.stringify([o.feedback, o.auditEvents]);
const STACK = [/\bat [\w.<>$ ]+ \(/, /\.(?:ts|js|mjs):\d+/, /\bnode_modules\b/, /\b(?:Type|Range|Reference|Syntax)?Error:/, /file:\/\//];
const noStackOrCanary = (o: AttackObservation, label: string) => {
  const text = surface(o).replaceAll("\\n", "\n");
  for (const canary of EVERYWHERE) expect(text, `${label}: ${canary}`).not.toContain(canary);
  for (const pattern of STACK) expect(text, `${label}: ${pattern}`).not.toMatch(pattern);
  expect(secretFindings(o, EVERYWHERE), label).toEqual([]);
};
const secretTarget = (world: GatewayWorld, planted = new Map<string, string | undefined>()) => ({
  ...world.targetFor("testSafeEcho", A_ALICE),
  validProposal: () => world.proposal("testSafeEcho").raw,
  failPermissionsWith: (message: string) => world.failPermissionsWith(message),
  plantCanaries: () => {
    // the environment, a trusted resource's display name, and what the executor returns: every place a canary could be read from
    for (const [index, canary] of SECRET_CANARIES.entries()) { const name = `CANARY_${index}`; if (!planted.has(name)) planted.set(name, process.env[name]); process.env[name] = canary; }
    world.setResourceAnswer({ ref: { type: "document", id: "doc-1" }, tenantId: world.tenants.A, displayName: SECRET_CANARIES[0] });
    world.executor("testSafeEcho").setNextResult({ status: "success", value: { secret: SECRET_CANARIES[1] }, affected: { type: "document", id: "doc-1" } });
  },
});

describe("T082 through the REAL gateway, via withGateway() (REQUIRED, representative: ATK-SECRET-01 to 04)", () => {
  const planted = new Map<string, string | undefined>();
  afterEach(() => { for (const [name, previous] of planted) { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; } planted.clear(); });

  it.each(["ATK-SECRET-01", "ATK-SECRET-02", "ATK-SECRET-03", "ATK-SECRET-04"])("%s: the scenario's own oracle passes on the real world with canaries planted", async (id) => {
    const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
    const observation = await runScenario(scenario(id), secretTarget(world, planted));
    expect(observation.feedback.length).toBeGreaterThan(0);
    expect(scenario(id).verify(observation)).toEqual([]);
    expect(observation.leakFindings).toEqual([]);
    if (id === "ATK-SECRET-01") expect(observation.executorCalls).toBe(1); // the control inside the scenario: the one valid proposal executed, carrying planted values
    else expect(observation.executorCalls).toBe(0);
    world.failPermissionsWith(undefined);
    expect(await world.submit(A_ALICE, world.proposal("testSafeEcho"))).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(world.executorCalls()).toBe(observation.executorCalls + 1);
  });

  it("a submitter throwing a secret-bearing error invalidates the observation rather than passing a clean-output oracle", async () => {
    const target = secretTarget(withGateway());
    const observation = await runScenario(scenario("ATK-SECRET-04"), { ...target, submit: async () => { throw new Error(SECRET_CANARIES[0]); } });
    expect(scenario("ATK-SECRET-04").verify(observation)).not.toEqual([]);
    expect(JSON.stringify(observation)).not.toContain(SECRET_CANARIES[0]);
  });

  it("the oracle is not vacuous on the real world: planting a canary into the real audit events or feedback fails the same verify", async () => {
    const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
    const observation = await runScenario(scenario("ATK-SECRET-01"), secretTarget(world, planted));
    expect(observation.auditEvents.length).toBeGreaterThan(0);
    const leakyAudit = { ...observation, auditEvents: observation.auditEvents.map((event, index) => index === 0 ? { ...event, actionId: SECRET_CANARIES[0] } : event) } as AttackObservation;
    expect(scenario("ATK-SECRET-01").verify(leakyAudit).join()).toContain("audit trail: canary");
    const leakyFeedback = { ...observation, feedback: observation.feedback.map((item, index) => index === 0 ? { ...item, note: `Error: x\n    at f (/a/b.ts:1:2) ${SECRET_CANARIES[2]}` } : item) } as AttackObservation;
    expect(scenario("ATK-SECRET-01").verify(leakyFeedback).join()).toContain("planner output");
  });

  describe("(1) a secret-like value in rejected, untrusted input is echoed nowhere", () => {
    const [A, B, C] = SECRET_CANARIES as readonly [string, string, string];
    const nested = (leaf: unknown) => ({ a: { b: { c: leaf } } });
    const REJECTED: readonly (readonly [string, unknown])[] = [
      ["an unknown key with a canary value", { action: "testSafeEcho", params: { message: "ok", extra: A } }],
      ["an unknown key whose NAME is a canary", { action: "testSafeEcho", params: { message: "ok", [B]: 1 } }],
      ["a nested unknown key with a canary value", { action: "testSafeEcho", params: { message: "ok", extra: nested(C) } }],
      ["a canary where a string is expected, as an object", { action: "testSafeEcho", params: { message: nested(A) } }],
      ["a canary where a string is expected, in an array", { action: "testSafeEcho", params: { message: [B, nested(C)] } }],
      ["a canary as a wrong-typed number-like value", { action: "testSafeEcho", params: { message: 12345, note: C } }],
      ["a canary in an unknown envelope key", { action: "testSafeEcho", params: { message: "ok" }, [A]: B }],
      ["a canary as the whole raw text", `{"action":"testSafeEcho","params":{"message":"ok","token":"${C}"}`],
    ];
    it("every rejected shape is refused with a generic answer, nothing executes, the answers and the audit hold no canary, and the same user's clean request then executes once", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const alice = await world.submitterFor(A_ALICE);
      const feedback: PlannerFeedback[] = [];
      for (const [index, [, raw]] of REJECTED.entries()) feedback.push(await alice.submit({ callId: `rej-${index}`, raw }));
      expect(feedback).toHaveLength(REJECTED.length);
      for (const answer of feedback) expect(["INVALID_ACTION", "INVALID_PARAMETERS"]).toContain(answer.outcome);
      expect(world.executorCalls()).toBe(0);
      expect(world.events().filter((event) => event.type === "AI_ACTION_PROPOSED")).toHaveLength(REJECTED.length);
      noStackOrCanary(observe(world, feedback), "rejected input");
      // the control: this world and this user do execute a clean request
      const control = await alice.submit(world.proposal("testSafeEcho", "clean"));
      expect(control).toEqual({ outcome: "ALLOWED", category: "ok" });
      expect(world.executorCalls()).toBe(1);
    });
  });

  describe("(1b) a secret-like ACTION NAME is the one model-authored value the trail keeps, by design, escaped and bounded", () => {
    it("it is never echoed to the planner, appears only as the attempted action id (at most 64 characters) and nowhere else in the events", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const long = `${SECRET_CANARIES[0]}${"x".repeat(80)}`;
      const feedback = [await world.submit(A_ALICE, { callId: "n1", raw: { action: SECRET_CANARIES[0], params: { message: "ok" } } }), await world.submit(A_ALICE, { callId: "n2", raw: { action: long, params: { message: "ok" } } })];
      expect(feedback.map((answer) => JSON.stringify(answer))).toEqual([JSON.stringify({ outcome: "INVALID_ACTION", category: "not_available" }), JSON.stringify({ outcome: "INVALID_ACTION", category: "not_available" })]);
      expect(JSON.stringify(feedback)).not.toContain(SECRET_CANARIES[0]);
      const events = world.events();
      expect(events).toHaveLength(4);
      for (const event of events) {
        const { actionId, ...rest } = event;
        expect(JSON.stringify(rest), event.type).not.toContain(SECRET_CANARIES[0]);
        expect(typeof actionId === "string" ? actionId.length : 0).toBeLessThanOrEqual(64);
        expect(event.reason === null || REASONS.has(event.reason)).toBe(true);
      }
      expect(events.map((event) => event.actionId)).toEqual([SECRET_CANARIES[0], SECRET_CANARIES[0], long.slice(0, 64), long.slice(0, 64)]);
      expect(world.executorCalls()).toBe(0);
    });
  });

  describe("(2) and (4) a trusted dependency's error text, with a canary and a stack, reaches neither the planner nor the trail", () => {
    it("the permission hook throws with a canary message: the generic try-later answer only, executor at zero", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      world.failPermissionsWith(`hook failed: ${SECRET_CANARIES[2]} password=hunter2`);
      const alice = await world.submitterFor(A_ALICE);
      const answer = await alice.submit(world.proposal("testSafeEcho"));
      expect(answer).toEqual({ outcome: "DENIED", category: "try_later" });
      expect(world.executorCalls()).toBe(0);
      noStackOrCanary(observe(world, [answer]), "permission hook");
      // the control: the very same text WOULD have been caught had it surfaced, and the user executes once the hook answers
      world.failPermissionsWith(undefined);
      expect((await alice.submit(world.proposal("testSafeEcho"))).outcome).toBe("ALLOWED");
      expect(world.executorCalls()).toBe(1);
    });

    it.each(["resources", "tenantPolicy", "replay", "audit"] as const)("the %s host port throws: generic answer, executor at zero, no fault text anywhere", async (port) => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      world.injectFault(port, "throws");
      const answer = await world.submit(A_ALICE, port === "resources" ? world.proposal("testHighPublish") : world.proposal("testSafeEcho"));
      expect(answer).toEqual({ outcome: "DENIED", category: "try_later" });
      expect(JSON.stringify(answer)).not.toContain(FAULT_CANARY);
      noStackOrCanary(observe(world, [answer]), port);
      world.clearFault(port);
      expect(await world.submit(A_ALICE, world.proposal("testSafeEcho"))).toEqual({ outcome: "ALLOWED", category: "ok" });
      expect(world.executorCalls()).toBe(1);
    });

    it("the executor body throws with a canary message and a real stack: execution fails generically, and neither the answer nor the trail carries it", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      world.executor("testSafeEcho").failWith(`db connection failed: password=hunter2 ${SECRET_CANARIES[0]}`);
      const alice = await world.submitterFor(A_ALICE);
      const answer = await alice.submit(world.proposal("testSafeEcho"));
      expect(world.executor("testSafeEcho").calls).toBe(1); // it ran and failed: the leak path was really open
      expect(answer).toEqual({ outcome: "ALLOWED", category: "try_later" }); // the decision stood, the execution failed: the planner is told only to try later
      const observation = observe(world, [answer]);
      noStackOrCanary(observation, "executor failure");
      expect(world.events().map((event) => [event.type, event.executionResult])).toEqual([["AI_ACTION_PROPOSED", null], ["AI_ACTION_ALLOWED", null], ["AI_ACTION_EXECUTED", "failure"]]);
      for (const event of world.events()) expect(event.reason === null || REASONS.has(event.reason), String(event.reason)).toBe(true);
      // the control: stop failing and the same user executes
      world.executor("testSafeEcho").failWith(undefined);
      expect((await alice.submit(world.proposal("testSafeEcho"))).outcome).toBe("ALLOWED");
    });

    it("the scanner would catch it: the same observation with the executor's message (and a stack frame) spliced into an audit event is reported", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      world.executor("testSafeEcho").failWith(`password=hunter2 ${SECRET_CANARIES[0]}`);
      const answer = await world.submit(A_ALICE, world.proposal("testSafeEcho"));
      const clean = observe(world, [answer]);
      expect(secretFindings(clean, EVERYWHERE)).toEqual([]);
      const leaked = { ...clean, auditEvents: clean.auditEvents.map((event, index) => index === clean.auditEvents.length - 1 ? { ...event, reason: `Error: password=hunter2 ${SECRET_CANARIES[0]}\n    at run (/srv/app/executor.ts:10:5)` } : event) } as AttackObservation;
      expect(secretFindings(leaked, EVERYWHERE).join()).toMatch(/canary/);
      expect(secretFindings(leaked, EVERYWHERE).join()).toMatch(/stack-trace/);
    });
  });

  describe("(3) the audit projection keeps codes and digests, not raw input or secrets", () => {
    it("a canary in a MASKED parameter (a draft) is not in the confirmation-required record; reasons are codes; no event holds raw params", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      secretTarget(world, planted).plantCanaries();
      const alice = await world.submitterFor(A_ALICE);
      const answer = await alice.submit({ callId: "draft", raw: { action: "testMediumDraft", params: { documentId: "doc-1", draft: `notes ${SECRET_CANARIES[0]} password=hunter2` } } });
      expect(answer).toEqual({ outcome: "REQUIRES_CONFIRMATION", category: "needs_user_confirmation" });
      expect(world.executorCalls()).toBe(0);
      const decision = world.events().find((event) => event.type === "AI_CONFIRMATION_REQUIRED")!;
      expect(world.stats().resourceCalls).toBe(1); // the canary-bearing resource answer was actually read
      expect(decision.resource).toEqual({ type: "document", id: "doc-1" });
      expect(decision.paramsView).toEqual({ "/documentId": "doc-1", "/draft": "[masked]" }); // the projection really ran: the draft is recorded as a mask only
      noStackOrCanary(observe(world, [answer]), "masked parameter");
      for (const event of world.events()) {
        expect(event.reason === null || REASONS.has(event.reason), String(event.reason)).toBe(true);
        expect(Object.keys(event)).not.toContain("params");
      }
    });

    it("a secret-shaped value in a PLAIN audited parameter is redacted by the scrubber before it is recorded, while the executor still receives it", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const token = "sk-abcdefghijklmnopqrstuvwx";
      const answer = await world.submit(A_ALICE, { callId: "tok", raw: { action: "testSafeEcho", params: { message: `use ${token} now` } } });
      expect(answer).toEqual({ outcome: "ALLOWED", category: "ok" });
      expect(world.executor("testSafeEcho").receivedParams).toEqual([{ message: `use ${token} now` }]); // the control: the value really passed through the Gateway
      const recorded = JSON.stringify(world.events());
      expect(recorded).not.toContain(token);
      const allowed = world.events().find((event) => event.type === "AI_ACTION_ALLOWED")!;
      expect(allowed.paramsView["/message"]).toEqual(expect.stringContaining("[redacted"));
    });

    it("a rejected request's events carry only codes: no params view, no resource, no result", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      const answer = await world.submit(A_ALICE, { callId: "bad", raw: { action: "testSafeEcho", params: { message: 7, extra: SECRET_CANARIES[1] } } });
      expect(answer.outcome).toBe("INVALID_PARAMETERS");
      const decisions = world.events().filter((event) => event.type !== "AI_ACTION_PROPOSED");
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ reason: "invalid_parameters", paramsView: {}, resource: null, executionResult: null });
      noStackOrCanary(observe(world, [answer]), "rejected params");
    });

    it("the executor's result value and affected resource are recorded as a status only: a canary in the returned value never reaches the answer or the trail", async () => {
      const world = withGateway({ config: WIDE_GATEWAY_CONFIG });
      secretTarget(world, planted).plantCanaries();
      const answer = await world.submit(A_ALICE, world.proposal("testSafeEcho"));
      expect(answer).toEqual({ outcome: "ALLOWED", category: "ok" });
      expect(world.executor("testSafeEcho").calls).toBe(1);
      const executed = world.events().find((event) => event.type === "AI_ACTION_EXECUTED")!;
      expect(executed.executionResult).toBe("success");
      noStackOrCanary(observe(world, [answer]), "executor result");
    });
  });
});
