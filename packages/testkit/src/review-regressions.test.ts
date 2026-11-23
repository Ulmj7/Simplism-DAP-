import { describe, expect, it } from "vitest";
import type { AttackScenario, ExecutionCall, PermissionId } from "@dap/contracts";
import { mintExecutionGrant } from "@dap/contracts/mint";
import { FakeClock } from "./clock.js";
import { IdGenerator } from "./ids.js";
import { LeakScanner } from "./leak-scanner.js";
import { faulty } from "./fault-injection.js";
import { FakePermissionChecker, FakeAuthenticationPort, withServiceIdentityRecording, ServiceIdentityHook } from "./host-fakes.js";
import { RecordingExecutor } from "./recording-executor.js";
import { InMemoryAuditSink } from "./audit-capture.js";
import { runScenario, type ScenarioTarget } from "./scenario-runner.js";
import { ctx, TENANT_A, TENANT_B, ALICE, TENANT_A_RESOURCES, USER_ROLES } from "./world.js";
import { testMediumDraft } from "./test-capabilities/index.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const HEX = "0123456789abcdef0123456789abcdef";
const rec = () => new RecordingExecutor({ id: "test-exec", result: { status: "success" } });
const target = (): ScenarioTarget => ({
  actionId: "testSafeEcho", risk: "SAFE", changesState: false, targetsResource: false, requiresConfirmation: false,
  planner: { script: [] }, submit: async () => ({ outcome: "ALLOWED", category: "ok" }), executor: rec(),
  audit: new InMemoryAuditSink(), visibleOutput: null,
});
const scenario = (run: AttackScenario["run"]): AttackScenario => ({ id: "review", category: "secret-extraction", title: "review", appliesTo: () => true, verify: () => [], run });

describe("senior review regressions", () => {
  it("keeps the clock valid and unchanged after overflowing advances", () => {
    const clock = new FakeClock();
    for (const seconds of [Number.MAX_VALUE, 8.64e12]) expect(() => clock.advance(seconds)).toThrow(RangeError);
    expect(clock.now()).toBe("2026-01-01T00:00:00.000Z");
    expect(() => new FakeClock("2026-01-01T00:00:00")).toThrow(RangeError);
  });

  it.each([NaN, Infinity, 1.5, -1, 2 ** 32])("rejects invalid deterministic ID seed %j", (seed) => {
    expect(() => new IdGenerator(seed)).toThrow(RangeError);
  });

  it("scans embedded secrets, secret keys, and deep output without echoing keys", () => {
    const scanner = new LeakScanner({ canaries: ["SECRET_CANARY"] });
    for (const value of [`confirmation: ${UUID}`, "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl", "reason: permission_missing", "    at /srv/private.ts:7:3"]) {
      expect(scanner.scan(value).length).toBeGreaterThan(0);
    }
    let deep: unknown = HEX;
    for (let i = 0; i < 100; i++) deep = { child: deep };
    expect(scanner.scan(deep).some((f) => f.kind === "secret-shaped")).toBe(true);
    const findings = scanner.scan({ SECRET_CANARY: "benign", [UUID]: HEX });
    expect(findings.some((f) => f.kind === "canary")).toBe(true);
    expect(JSON.stringify(findings)).not.toContain("SECRET_CANARY");
    expect(JSON.stringify(findings)).not.toContain(UUID);
  });

  it("reports unreadable output instead of throwing or claiming it is clean", () => {
    const output = { get secret() { throw new Error("SECRET_CANARY"); } };
    expect(new LeakScanner().scan(output).length).toBeGreaterThan(0);
  });

  it("does not mistake ordinary domains or prose for leaked tokens or reason codes", () => {
    expect(new LeakScanner().scan("You are allowed to open docs.example.test.")).toEqual([]);
  });

  it("injects faults into class methods without calling the original", async () => {
    let calls = 0;
    class Port { async check() { calls++; return true; } get() { calls++; return 1; } }
    const wrapped = faulty(new Port(), "hangs") as Port;
    expect(typeof wrapped.check).toBe("function");
    let settled = false;
    void wrapped.check().then(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    const wrong = faulty(new Port(), "wrong-type") as Port;
    expect(await wrong.check()).toBe("yes");
    expect(await wrong.get()).toBe("yes");
    expect(calls).toBe(0);
  });

  it("records class and symbol service methods with detached arguments", () => {
    const symbol = Symbol("service");
    class Service { current(arg: { value: number }) { return arg.value; } [symbol]() { return "symbol"; } }
    const hook = new ServiceIdentityHook();
    const wrapped = withServiceIdentityRecording(new Service(), hook);
    const arg = { value: 1 };
    expect(wrapped.current(arg)).toBe(1);
    expect(wrapped[symbol]()).toBe("symbol");
    arg.value = 2;
    expect(hook.calls).toHaveLength(2);
    expect(hook.calls[0]?.args).toEqual([{ value: 1 }]);
    expect(Object.isFrozen(hook.calls[0]?.args[0])).toBe(true);
  });

  it("wraps host fakes with private Map state without missing their methods", async () => {
    const source = new FakePermissionChecker();
    const hook = new ServiceIdentityHook();
    const wrapped = withServiceIdentityRecording(source, hook);
    expect(await wrapped.has(ctx(TENANT_A, ALICE), "p" as PermissionId)).toBe(false);
    expect(source.calls).toBe(1);
    expect(hook.calls).toHaveLength(1);
  });

  it("retains service invocation evidence for arguments that cannot be copied", () => {
    const hook = new ServiceIdentityHook();
    let invoked = 0;
    const wrapped = withServiceIdentityRecording({ act(arg: unknown) { void arg; invoked++; return "done"; } }, hook);
    for (const arg of [() => {}, new Date(0), new Map()]) expect(wrapped.act(arg)).toBe("done");
    expect(invoked).toBe(3);
    expect(hook.calls).toHaveLength(3);
    expect(hook.calls[0]?.args).toEqual([{ kind: "unreadable-arguments" }]);
  });

  it("records detached nested parameters while retaining minted identities", async () => {
    const params = { nested: { value: 1 } };
    const security = ctx(TENANT_A, ALICE);
    const grant = mintExecutionGrant({ requestId: "req" as never, actionId: "testSafeEcho" as never, paramsDigest: "digest" as never, tenantId: TENANT_A, userId: ALICE });
    const call: ExecutionCall<typeof params> = { grant, security, params, resource: null, requestId: "req" as never, actionId: "testSafeEcho" as never, paramsDigest: "digest" as never };
    const recorder = rec();
    await recorder.executor.execute(call);
    params.nested.value = 99;
    expect(recorder.receivedParams).toEqual([{ nested: { value: 1 } }]);
    expect(Object.isFrozen((recorder.receivedParams[0] as typeof params).nested)).toBe(true);
    expect(recorder.callLog[0]?.security).toBe(security);
    expect(recorder.grants[0]).toBe(grant);
  });

  it("keeps executor invocation evidence when parameter capture fails", async () => {
    const security = ctx(TENANT_A, ALICE);
    const grant = mintExecutionGrant({ requestId: "req" as never, actionId: "testSafeEcho" as never, paramsDigest: "digest" as never, tenantId: TENANT_A, userId: ALICE });
    const recorder = rec();
    let entered = -1;
    const call: ExecutionCall<unknown> = { grant, security, params: { get secret() { entered = recorder.calls; throw new Error(HEX); } }, resource: null, requestId: "req" as never, actionId: "testSafeEcho" as never, paramsDigest: "digest" as never };
    await expect(recorder.executor.execute(call)).rejects.toThrow();
    expect(recorder.calls).toBe(1);
    expect(recorder.grantsSeen).toBe(1);
    expect(recorder.grants[0]).toBe(grant);
    expect(recorder.receivedParams).toEqual([{ kind: "unreadable-arguments" }]);
    expect(entered).toBe(1);
  });

  it("snapshots authentication responses and world fixtures", async () => {
    const principal = { userId: "alice", tenantId: TENANT_A, sessionId: "s", authenticatedAt: "2026-01-01T00:00:00Z", validUntil: "2026-01-02T00:00:00Z" };
    const auth = new FakeAuthenticationPort(principal);
    principal.userId = "mallory";
    const response = await auth.authenticate("evidence");
    expect(response?.userId).toBe("alice");
    expect(Object.isFrozen(response)).toBe(true);
    expect(Object.isFrozen(TENANT_A_RESOURCES[0]?.ref)).toBe(true);
    expect(Object.isFrozen(USER_ROLES[0])).toBe(true);
  });

  it("scopes permission grants to the tenant even when user ids repeat", async () => {
    const checker = new FakePermissionChecker();
    const permission = "document:read" as PermissionId;
    checker.grant(ALICE, permission, TENANT_A);
    expect(await checker.has(ctx(TENANT_A, ALICE), permission)).toBe(true);
    expect(await checker.has(ctx(TENANT_B, ALICE), permission)).toBe(false);
    checker.revoke(ALICE, permission, TENANT_A);
    expect(await checker.has(ctx(TENANT_A, ALICE), permission)).toBe(false);
  });

  it("does not turn __proto__ audit keys into a mutable prototype", async () => {
    const sink = new InMemoryAuditSink();
    const event = JSON.parse('{"paramsView":{"__proto__":{"canary":"secret"}}}') as Parameters<typeof sink.append>[0];
    await sink.append(event);
    const view = sink.events[0]!.paramsView;
    expect(Object.hasOwn(view, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(view)).toBe(Object.prototype);
    expect(Object.isFrozen(Reflect.get(view, "__proto__"))).toBe(true);
  });

  it("does not trust scenario counts, omissions, or leak findings", async () => {
    const t = target();
    t.submit = async () => ({ outcome: "DENIED", category: "not_available", hidden: HEX }) as never;
    const obs = await runScenario(scenario(async (input) => {
      await (input as ScenarioTarget).submit({ callId: "c", raw: "{}" });
      return { feedback: [], executorCalls: 100, auditEvents: [], leakFindings: [HEX] };
    }), t);
    expect(obs.feedback).toHaveLength(1);
    expect(obs.executorCalls).toBe(0);
    expect(obs.leakFindings.length).toBeGreaterThan(0);
    expect(JSON.stringify(obs.leakFindings)).not.toContain(HEX);
  });

  it("scans already emitted feedback and visible output even when a scenario throws", async () => {
    const t = target();
    Object.assign(t, { visibleOutput: { text: HEX } });
    const obs = await runScenario(scenario(async () => { throw new Error("secret failure"); }), t);
    expect(obs.feedback[0]?.outcome).toBe("DENIED");
    expect(obs.leakFindings.some((finding) => finding.startsWith("secret-shaped:"))).toBe(true);
  });

  it("scans changing visible output and caller-registered canaries", async () => {
    const t = target();
    const scanner = new LeakScanner({ canaries: ["CUSTOM_CANARY"] });
    t.submit = async () => {
      Object.assign(t, { visibleOutput: "CUSTOM_CANARY" });
      return { outcome: "ALLOWED", category: "ok" };
    };
    const obs = await runScenario(scenario(async (input) => {
      const observed = input as ScenarioTarget;
      expect(observed.visibleOutput).toBeNull();
      await observed.submit({ callId: "c", raw: "{}" });
      return { feedback: [], executorCalls: 0, auditEvents: [], leakFindings: [] };
    }), t, scanner);
    expect(obs.leakFindings.some((finding) => finding.startsWith("canary:"))).toBe(true);
    expect(JSON.stringify(obs.leakFindings)).not.toContain("CUSTOM_CANARY");
  });

  it("does not call malformed feedback a successful run", async () => {
    const obs = await runScenario(scenario(async () => ({ feedback: [null], executorCalls: 0, auditEvents: [], leakFindings: [] }) as never), target());
    expect(obs.feedback[0]?.outcome).toBe("DENIED");
    expect(obs.leakFindings).toContain("runner-error:$");
  });

  it("retains repeated submissions when the scenario omits identical feedback", async () => {
    const obs = await runScenario(scenario(async (input) => {
      const t = input as ScenarioTarget;
      const first = await t.submit({ callId: "1", raw: "{}" });
      await t.submit({ callId: "2", raw: "{}" });
      return { feedback: [first], executorCalls: 0, auditEvents: [], leakFindings: [] };
    }), target());
    expect(obs.feedback).toHaveLength(2);
    expect(obs.feedback.every((item) => item.outcome === "ALLOWED")).toBe(true);
  });

  it("keeps captured feedback with cyclic and bigint extra data", async () => {
    const t = target();
    const answer = { outcome: "ALLOWED", category: "ok", self: null as unknown, extra: 1n };
    answer.self = answer;
    t.submit = async () => answer as never;
    const obs = await runScenario(scenario(async (input) => {
      const feedback = await (input as ScenarioTarget).submit({ callId: "c", raw: "{}" });
      return { feedback: [feedback], executorCalls: 0, auditEvents: [], leakFindings: [] };
    }), t);
    expect(obs.feedback).toHaveLength(1);
    expect(obs.feedback[0]?.outcome).toBe("ALLOWED");
  });

  it("scans reported feedback without reading ignored audit and count claims", async () => {
    let ignoredReads = 0;
    const scanner = new LeakScanner({ canaries: ["CUSTOM_CANARY"] });
    const obs = await runScenario(scenario(async () => ({
      feedback: [{ outcome: "DENIED", category: "not_available", hidden: "CUSTOM_CANARY" }],
      get auditEvents(): never { ignoredReads++; throw new Error("ignored"); },
      get executorCalls(): never { ignoredReads++; throw new Error("ignored"); },
      leakFindings: [],
    })), target(), scanner);
    expect(obs.leakFindings.some((finding) => finding.startsWith("canary:"))).toBe(true);
    expect(ignoredReads).toBe(0);
  });

  it("records unreadable output even if the scenario catches it and clears it", async () => {
    const t = target();
    Object.assign(t, { visibleOutput: { get secret() { throw new Error(HEX); } } });
    const obs = await runScenario(scenario(async (input) => {
      try { void (input as ScenarioTarget).visibleOutput; } catch { /* scenario hides the read failure */ }
      Object.assign(t, { visibleOutput: null });
      return { feedback: [], executorCalls: 0, auditEvents: [], leakFindings: [] };
    }), t);
    expect(obs.feedback[0]?.outcome).toBe("DENIED");
    expect(obs.leakFindings).toContain("scan-error:$");
  });

  it("latches a submitter failure even if the scenario catches the rejection", async () => {
    const t = target();
    t.submit = async () => { throw new Error("SECRET_CANARY"); };
    const obs = await runScenario(scenario(async (input) => {
      try { await (input as ScenarioTarget).submit({ callId: "c", raw: "{}" }); } catch { /* scenario hides the target failure */ }
      return { feedback: [], executorCalls: 0, auditEvents: [], leakFindings: [] };
    }), t);
    expect(obs.feedback[0]?.outcome).toBe("DENIED");
  });

  it("contains throwing output getters and malformed scenario observations", async () => {
    const t = target();
    Object.defineProperty(t, "visibleOutput", { get() { throw new Error(HEX); } });
    const obs = await runScenario(scenario(async () => undefined as never), t);
    expect(obs.feedback[0]?.outcome).toBe("DENIED");
    expect(obs.leakFindings.length).toBeGreaterThan(0);
    expect(JSON.stringify(obs.leakFindings)).not.toContain(HEX);
  });

  it("requires MEDIUM confirmation by default", () => {
    expect(testMediumDraft.confirmation.kind).toBe("required");
    expect(testMediumDraft.describeConsequence).toBeTypeOf("function");
  });
});
