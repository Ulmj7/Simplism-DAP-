import { describe, expect, it } from "vitest";
import { buildRegistry } from "@dap/security";
import { validateGatewayConfig } from "@dap/security";
import { ALICE, WIDE_GATEWAY_CONFIG, malformedParamsSchema, malformedParameterScenarios, runScenario, testSafeEcho, withGateway } from "@dap/testkit";
import type { DenialScenario, WorldUser } from "@dap/testkit";

const EXERCISED = ["ATK-PARAMS-01", "ATK-PARAMS-02", "ATK-PARAMS-03", "ATK-PARAMS-04", "ATK-PARAMS-05", "ATK-PARAMS-08", "ATK-PARAMS-09", "ATK-PARAMS-11"];
const EXPECTED_CASES: Readonly<Record<string, number>> = { "ATK-PARAMS-01": 1, "ATK-PARAMS-02": 3, "ATK-PARAMS-03": 1, "ATK-PARAMS-04": 1, "ATK-PARAMS-05": 4, "ATK-PARAMS-08": 1, "ATK-PARAMS-09": 1, "ATK-PARAMS-11": 10 };
const traits = { actionId: testSafeEcho.id, risk: "SAFE" as const, changesState: false, targetsResource: false, requiresConfirmation: false };
describe("T053 malformed parameters", () => {
  it("fixture schema registers and accepts bounded benign parameters", () => {
    const registry = buildRegistry([{ ...testSafeEcho, inputSchema: malformedParamsSchema }]);
    expect(registry.get(testSafeEcho.id)?.definition.inputSchema.safeParse({ message: "ok", count: 10, tags: ["a", "b"], options: { nested: { leaf: { value: "ok" } } } }).success).toBe(true);
  });
  for (const scenario of malformedParameterScenarios) {
    if (["01", "02", "03", "04", "05", "11"].some((suffix) => scenario.id.endsWith(suffix))) {
      it(`${scenario.id} schema rejects every malformed fixture`, () => {
        for (const item of scenario.cases(traits)) {
          const raw = item.raw as { params: unknown };
          expect(malformedParamsSchema.safeParse(raw.params).success).toBe(false);
        }
      });
    }
    // The REQUIRED runs are below, through withGateway(). 06, 07, 10 and 13 are OPTIONAL in M1 and stay definition-level.
    if (!EXERCISED.includes(scenario.id) && scenario.id !== "ATK-PARAMS-12") it.todo(`${scenario.id} ${scenario.title}: real gateway run (OPTIONAL)`);
  }
  it.todo("ATK-PARAMS-12 getter/Proxy: invalid-first remains denied; valid-first executes only the validated frozen first snapshot (OPTIONAL; not part of the M1 representative set)");
  it("ATK-PARAMS-09 fixture exceeds byte cap before character count reaches cap", () => {
    const raw = malformedParameterScenarios.find((item) => item.id === "ATK-PARAMS-09")!.cases(traits)[0]!.raw as string;
    expect(raw.length).toBeLessThan(1024);
    expect(Buffer.byteLength(raw)).toBeGreaterThan(1024);
  });
});

const A_ALICE: WorldUser = { tenant: "A", user: ALICE };
/** The fixture caps of the 08/09 scenarios: 1024 payload bytes and 8 levels of JSON depth. */
const CAPPED = validateGatewayConfig({ ...WIDE_GATEWAY_CONFIG, maxPayloadBytes: 1024, maxJsonDepth: 8 });
const scenarioOf = (id: string) => malformedParameterScenarios.find((entry) => entry.id === id)! as DenialScenario;
const worldFor = (config = CAPPED) => withGateway({ config, inputSchemas: { testSafeEcho: malformedParamsSchema } });
const VALID = { message: "ok", count: 10, tags: ["a", "b"], options: { nested: { leaf: { value: "ok" } } } };
const LEAK_CANARIES = ["qz", "K9!", 'q"\\\nZ', "ξ私"] as const;
/** Inspect decoded string values AND keys; no minimum secret length. Exact empty projections below reject any encoding, too. */
const strings = (value: unknown): string[] => typeof value === "string" ? [value] : value !== null && typeof value === "object" ? Object.entries(value).flatMap(([key, child]) => [key, ...strings(child)]) : [];
const variants = (secret: string): readonly string[] => [...new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret).toString("base64"), secret.split("").map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")])];
const echoes = (output: unknown, secrets: readonly string[]): string[] => {
  const observed = strings(output);
  return secrets.filter((secret) => secret.length > 0 && variants(secret).some((variant) => observed.some((value) => value.includes(variant))));
};
const AUDIT_FIELDS = ["id", "occurredAt", "type", "requestId", "decisionId", "tenantId", "userId", "aiSessionId", "turnId", "model", "actionId", "definitionVersion", "paramsView", "risk", "outcome", "reason", "confirmationId", "confirmationState", "executionResult", "resource"].sort();
it.each(LEAK_CANARIES)("the leak check sees raw and encoded short values, keys and issue paths: %j", (secret) => {
  // Deliberately independent of variants(): dropping an encoding from the detector must fail this test.
  for (const variant of [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret), Buffer.from(secret).toString("base64"), secret.split("").map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")]) {
    for (const output of [{ value: variant }, { [variant]: "placeholder" }, { issues: [{ path: `/${variant}`, code: "type" }] }]) expect(echoes(output, [secret])).toContain(secret);
  }
  expect(echoes({ outcome: "INVALID_PARAMETERS", issues: [{ path: "", code: "unknown_key" }] }, [secret])).toEqual([]);
});

describe("T053 through the REAL gateway, via withGateway() (M1 representatives plus optional nested/size/depth boundaries)", () => {
  it.each(EXERCISED)("%s: the scenario's generic issues (paths and generic codes, never values), nothing executes, no input value is echoed, and a valid call still executes", async (id) => {
    const world = worldFor();
    const target = world.targetFor("testSafeEcho", A_ALICE);
    const scenario = scenarioOf(id);
    const cases = scenario.cases(target);
    expect(cases).toHaveLength(EXPECTED_CASES[id]!);
    const observation = await runScenario(scenario, target);
    expect(observation.feedback).toHaveLength(cases.length);
    expect(scenario.verify(observation, target)).toEqual([]);
    expect(observation.executorCalls).toBe(0);
    expect(world.executorCalls()).toBe(0);
    for (const feedback of observation.feedback) {
      expect(Object.keys(feedback).every((key) => ["outcome", "category", "issues"].includes(key))).toBe(true);
      for (const issue of (feedback as { issues?: { path: string; code: string }[] }).issues ?? []) expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
    }
    for (const event of world.events()) {
      expect(Object.keys(event).sort()).toEqual(AUDIT_FIELDS);
      expect(event.paramsView).toEqual({}); // No rejected data is projected, regardless of its length or encoding.
      expect(event.resource).toBeNull();
      expect([null, "testSafeEcho"]).toContain(event.actionId);
      expect(event.userId).toBe(ALICE);
      expect(event.tenantId).toBe(world.tenants.A);
      expect(event.model).toBe("scripted");
      expect(event.aiSessionId).toBe("session-alice");
      expect(event.turnId).toBe("turn-1");
      expect(event.occurredAt).toBe(world.clock.now());
      expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(event.requestId).toMatch(/^dec-[0-9a-f]{16}$/);
      expect(event.decisionId).toBe(event.requestId);
      expect(event.confirmationId).toBeNull(); expect(event.confirmationState).toBeNull(); expect(event.executionResult).toBeNull();
      expect([null, "SAFE"]).toContain(event.risk);
      expect([null, 1]).toContain(event.definitionVersion);
    }
    // The control would execute: the same user and capability with the schema's valid input.
    expect(await target.submit({ callId: "control", raw: { action: "testSafeEcho", params: VALID } })).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(world.executor("testSafeEcho").calls).toBe(1);
    expect(world.executor("testSafeEcho").receivedParams).toEqual([VALID]);
  });

  it.each(LEAK_CANARIES)("short/escaped canary %j in unknown keys and values never appears in feedback or denial audit data", async (secret) => {
    const world = worldFor();
    for (const [index, params] of [
      { message: secret, [secret]: secret },
      { message: secret, options: { nested: { leaf: { value: secret, [secret]: secret } } } },
    ].entries()) {
      expect(await world.submit(A_ALICE, { callId: `canary-${index}`, raw: { action: "testSafeEcho", params } })).toEqual({ outcome: "INVALID_PARAMETERS", category: "invalid_input", issues: [{ path: "", code: "unknown_key" }] });
    }
    expect(world.executorCalls()).toBe(0);
    expect(echoes(world.events(), [secret])).toEqual([]);
    for (const event of world.events()) expect(event.paramsView).toEqual({});
    // The canary text itself is valid data: only the extra key caused the denials.
    expect(await world.submit(A_ALICE, { callId: "canary-control", raw: { action: "testSafeEcho", params: { message: secret } } })).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(world.executorCalls()).toBe(1);
    expect(world.executor("testSafeEcho").receivedParams).toEqual([{ message: secret }]);
  });

  it("ATK-PARAMS-04 is a nested unknown field: the schema nests three levels, and a valid nested value is accepted by the same world", async () => {
    const world = worldFor();
    const nested = { message: "ok", options: { nested: { leaf: { value: "ok", extra: true } } } };
    expect(await world.submit(A_ALICE, { callId: "n1", raw: { action: "testSafeEcho", params: nested } })).toEqual({ outcome: "INVALID_PARAMETERS", category: "invalid_input", issues: [{ path: "", code: "unknown_key" }] });
    expect(world.executorCalls()).toBe(0);
    expect((await world.submit(A_ALICE, { callId: "n2", raw: { action: "testSafeEcho", params: { message: "ok", options: { nested: { leaf: { value: "ok" } } } } } })).outcome).toBe("ALLOWED");
    expect(world.executorCalls()).toBe(1);
  });

  it("ATK-PARAMS-11: identity-like keys change nothing: a permitted and an unprivileged user hear the same thing, and the claims never reach the executor", async () => {
    const world = worldFor();
    const carol: WorldUser = { tenant: "A", user: "carol" };
    for (const key of ["tenantId", "userId", "role", "confirmed", "isAdmin"]) {
      const raw = { action: "testSafeEcho", params: { message: "ok", [key]: "claimed" } };
      const fromAlice = await world.submit(A_ALICE, { callId: `a-${key}`, raw });
      const fromCarol = await world.submit(carol, { callId: `c-${key}`, raw });
      expect(fromAlice, key).toEqual({ outcome: "INVALID_PARAMETERS", category: "invalid_input", issues: [{ path: "", code: "unknown_key" }] });
      expect(JSON.stringify(fromCarol), key).toBe(JSON.stringify(fromAlice));
    }
    expect(world.executorCalls()).toBe(0);
    expect(world.executor("testSafeEcho").receivedParams).toEqual([]);
    expect(await world.submit(A_ALICE, { callId: "identity-control", raw: { action: "testSafeEcho", params: VALID } })).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(world.executorCalls()).toBe(1);
  });

  describe("exact boundaries, just over", () => {
    const raw = (message: string) => JSON.stringify({ action: "testSafeEcho", params: { message } });
    it("the byte cap: a payload of exactly maxPayloadBytes executes; one byte more is payload_too_large, whether the extra byte is ASCII or a multibyte character", async () => {
      const cap = 100;
      const config = validateGatewayConfig({ ...WIDE_GATEWAY_CONFIG, maxPayloadBytes: cap });
      const overhead = Buffer.byteLength(raw(""));
      const exact = raw("x".repeat(cap - overhead));
      expect(Buffer.byteLength(exact)).toBe(cap);
      const world = withGateway({ config });
      expect(await world.submit(A_ALICE, { callId: "at-cap", raw: exact })).toEqual({ outcome: "ALLOWED", category: "ok" });
      expect(world.executor("testSafeEcho").calls).toBe(1);
      const over = [raw("x".repeat(cap - overhead + 1)), raw("x".repeat(cap - overhead - 2) + "\u754c")];
      expect(over.map((text) => Buffer.byteLength(text))).toEqual([cap + 1, cap + 1]);
      expect(over[1]!.length).toBeLessThanOrEqual(cap); // the second is over the cap in bytes while its character count is not
      for (const [index, text] of over.entries()) {
        const mark = world.events().length;
        expect(await world.submit(A_ALICE, { callId: `over-${index}`, raw: text })).toEqual({ outcome: "INVALID_ACTION", category: "not_available" });
        expect(world.eventsSince(mark).map((event) => event.reason)).toEqual([null, "payload_too_large"]);
      }
      expect(world.executor("testSafeEcho").calls).toBe(1); // only the at-cap control ever ran
    });

    it.each(["object", "array"] as const)("the %s depth cap: maxJsonDepth reaches the schema; one deeper is malformed_envelope", async (kind) => {
      const levels = (count: number) => Array.from({ length: count }).reduce<unknown>((value) => kind === "object" ? { child: value } : [value], null);
      const world = worldFor();
      const atCap = CAPPED.maxJsonDepth - 2; // the envelope and `params` are the first two levels
      const answer = async (count: number, callId: string) => { const mark = world.events().length; const feedback = await world.submit(A_ALICE, { callId, raw: { action: "testSafeEcho", params: { message: "ok", nested: levels(count) } } }); return { feedback, reasons: world.eventsSince(mark).map((event) => event.reason) }; };
      const accepted = await answer(atCap, "d-at");
      expect(accepted.feedback).toEqual({ outcome: "INVALID_PARAMETERS", category: "invalid_input", issues: [{ path: "", code: "unknown_key" }] });
      expect(accepted.reasons).toEqual([null, "invalid_parameters"]);
      const over = await answer(atCap + 1, "d-over");
      expect(over.feedback).toEqual({ outcome: "INVALID_ACTION", category: "not_available" });
      expect(over.reasons).toEqual([null, "malformed_envelope"]);
      expect(world.executorCalls()).toBe(0);
      expect(await world.submit(A_ALICE, { callId: "depth-control", raw: { action: "testSafeEcho", params: VALID } })).toEqual({ outcome: "ALLOWED", category: "ok" });
      expect(world.executorCalls()).toBe(1);
    });
  });
});
