/** Focused regressions for EXEC-01, LOGIC-01, RATE-01, AUTHZ-01, TEST-01/02/03, LIMIT-02 and RISK-01. */
import { describe, expect, it, vi } from "vitest";
import { defineExecutor } from "@dap/contracts";
import type { AnyActionDefinition, GatewayDependencies } from "@dap/contracts";
import { buildRegistry, createPolicyGateway } from "@dap/security";
import { ALL_TEST_CAPABILITIES, withGateway, WIDE_GATEWAY_CONFIG } from "@dap/testkit";
import { assemble } from "../../packages/security/src/gateway/create-gateway.js";
import { createPipeline } from "../../packages/security/src/gateway/pipeline.js";

const alice = { tenant: "A", user: "alice" } as const;
const ok = { outcome: "ALLOWED", category: "ok" };
const types = (w: ReturnType<typeof withGateway>) => w.events().map(e => e.type);
const registryWith = (id: string, patch: Partial<AnyActionDefinition>) => buildRegistry(ALL_TEST_CAPABILITIES.map(d => d.id === id ? { ...d, ...patch } : d));
const submit = async (w: ReturnType<typeof withGateway>, overrides: Partial<GatewayDependencies>, action = "testSafeEcho") => {
  const bound = await w.submitterFor(alice);
  return createPolicyGateway({ ...w.deps, ...overrides }).proposals.forSession(bound.context, bound.run).submit(w.proposal(action));
};

describe("EXEC-01 / TEST-03: real guarded executors may return arbitrary values", () => {
  it.each([new Date(0), new Map(), new (class Row { id = 1; })(), 10n, { id: 1 }])("success is preserved for value %s without exposing it", async value => {
    const w = withGateway(); let calls = 0;
    const executor = defineExecutor({ id: "real-result", run: async () => { calls++; return { status: "success", value }; } });
    expect(await submit(w, { executors: { executorFor: () => executor } })).toEqual(ok);
    expect(calls).toBe(1);
    expect(w.events().at(-1)).toMatchObject({ type: "AI_ACTION_EXECUTED", executionResult: "success" });
    expect(JSON.stringify(w.events())).not.toContain('"value"');
  });
  it("never reads value or lets malformed affected metadata turn a known success into failure", async () => {
    const w = withGateway(); let reads = 0;
    const executor = defineExecutor({ id: "real-result", run: async () => ({ status: "success", get value() { reads++; throw new Error("secret"); }, get affected() { throw new Error("secret"); } }) });
    expect(await submit(w, { executors: { executorFor: () => executor } })).toEqual(ok);
    expect(reads).toBe(0);
    expect(w.events().at(-1)?.executionResult).toBe("success");
    expect(JSON.stringify(w.events())).not.toContain("secret");
  });
});

describe("LOGIC-01 / TEST-01: durable ALLOW is the final policy decision", () => {
  it("missing executor binding is rejected before durable ALLOW", async () => {
    const w = withGateway();
    expect(await submit(w, { executors: { executorFor: () => undefined } })).toEqual({ outcome: "DENIED", category: "try_later" });
    expect(types(w)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_DENIED"]);
    expect(w.executorCalls()).toBe(0);
  });
  it.each([9999.6, 10000])("budget exhausted after committed ALLOW at %s never executes or produces a contradictory denial", async elapsed => {
    const w = withGateway(); const bound = await w.submitterFor(alice); let time = 0;
    const timer = { now: () => time, setTimeout: () => 0, clearTimeout: () => {} };
    const { stages, auditor } = assemble({ ...w.deps, audit: { append: async (e, o) => { await w.deps.audit.append(e, o); if (e.type === "AI_ACTION_ALLOWED") time = elapsed; } } });
    const result = await createPipeline(stages, { timer, audit: auditor }).evaluate({ context: bound.context, run: bound.run, decisionId: "budget", requestId: "budget" as never, readProposal: () => w.proposal("testSafeEcho") });
    expect(result.decision.outcome).toBe("ALLOWED"); expect(result.executionStatus).toBe("failure");
    expect(w.executorCalls()).toBe(0);
    expect(types(w)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED"]);
  });
  it.each([false, true])("bounded completion with hung result append, executor hangs=%s", async hangs => {
    vi.useFakeTimers();
    try {
      const w = withGateway({ config: { ...WIDE_GATEWAY_CONFIG, hookTimeoutMs: 40, proposalBudgetMs: 120 }, auditSink: { append: e => e.type === "AI_ACTION_EXECUTED" ? new Promise(() => {}) : Promise.resolve() } });
      if (hangs) w.executor("testSafeEcho").onRun(() => new Promise(() => {}));
      const pending = w.submit(alice, w.proposal("testSafeEcho"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toEqual({ outcome: "ALLOWED", category: hangs ? "try_later" : "ok" });
      expect(w.executorCalls()).toBe(1);
      expect(types(w)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED"]);
    } finally { vi.useRealTimers(); }
  });
  it.each(["throws", "hangs", "malformed"])("a known successful execution remains success after outer stage %s", async mode => {
    vi.useFakeTimers();
    try {
      const w = withGateway(); const bound = await w.submitterFor(alice);
      const { stages, auditor } = assemble(w.deps);
      const execute = stages.execute!;
      stages.execute = async request => {
        await execute(request);
        if (mode === "throws") throw new Error("post-execution fault");
        if (mode === "hangs") return new Promise(() => {});
        return {} as never;
      };
      const pending = createPipeline(stages, { audit: auditor }).evaluate({ context: bound.context, run: bound.run, decisionId: "outer", requestId: "outer" as never, readProposal: () => w.proposal("testSafeEcho") });
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await pending;
      expect(result.decision.outcome).toBe("ALLOWED"); expect(result.executionStatus).toBe("success");
      expect(w.executorCalls()).toBe(1);
      expect(types(w)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
    } finally { vi.useRealTimers(); }
  });
  it("a binding lost after ALLOW fails closed without minting an executable call or denying policy", async () => {
    const w = withGateway(); let committed = false;
    expect(await submit(w, {
      audit: { append: async (e, o) => { await w.deps.audit.append(e, o); if (e.type === "AI_ACTION_ALLOWED") committed = true; } },
      executors: { executorFor: id => committed ? undefined : w.deps.executors.executorFor(id) },
    })).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(w.executorCalls()).toBe(0); expect(types(w)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED"]);
  });
});

describe("RATE-01: malformed raw JSON has exactly one proposal admission", () => {
  it("malformed floods hit existing throttle with bounded state traffic", async () => {
    const w = withGateway(); const answers = [];
    for (let i = 0; i < 200; i++) answers.push(await w.submit(alice, { callId: `bad-${i}`, raw: "{" }));
    expect(answers.filter(a => a.outcome === "INVALID_ACTION")).toHaveLength(6);
    expect(answers.filter(a => a.outcome === "DENIED")).toHaveLength(194);
    expect(w.stats().sharedStoreCalls).toBeLessThanOrEqual(50); expect(w.executorCalls()).toBe(0);
    expect(w.events({ type: "AI_RATE_LIMITED" })).toHaveLength(194);
  });
  it("raw duplicate keys are rejected before replay or execution", async () => {
    const w = withGateway();
    expect((await w.submit(alice, { callId: "duplicate", raw: '{"action":"testSafeEcho","action":"testLowNavigate","params":{}}' })).outcome).toBe("INVALID_ACTION");
    expect(w.stats().replayClaims).toHaveLength(0); expect(w.executorCalls()).toBe(0);
    expect(types(w)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_DENIED"]);
  });
  it("valid proposals are charged once; a malformed proposal uses the same turn budget", async () => {
    const w = withGateway({ config: { ...WIDE_GATEWAY_CONFIG, limits: { ...WIDE_GATEWAY_CONFIG.limits, proposalsPerTurn: 3 } } });
    expect(await w.submit(alice, w.proposal("testSafeEcho"))).toEqual(ok);
    expect((await w.submit(alice, { callId: "malformed", raw: "{" })).outcome).toBe("INVALID_ACTION");
    expect(await w.submit(alice, w.proposal("testSafeEcho"))).toEqual(ok);
    expect((await w.submit(alice, w.proposal("testSafeEcho"))).outcome).toBe("DENIED");
    expect(w.executorCalls()).toBe(2); expect(w.stats().replayClaims).toHaveLength(2);
  });
});

describe("AUTHZ-01 / TEST-02: resource and page checks narrow authorization", () => {
  it("state changes with a null extracted resource cannot bypass the resource authorizer", async () => {
    const w = withGateway({ mediumConfirmationJustification: "reversible" });
    const registry = registryWith("testMediumDraft", { confirmation: { kind: "not-required", justification: "reversible" }, resource: () => null });
    expect((await submit(w, { registry }, "testMediumDraft")).outcome).toBe("DENIED");
    expect(w.executorCalls()).toBe(0); expect(types(w)).not.toContain("AI_ACTION_ALLOWED");
  });
  it("resource-authorized changes and legitimate null-resource reads still execute", async () => {
    const w = withGateway({ mediumConfirmationJustification: "reversible" });
    expect(await w.submit(alice, w.proposal("testMediumDraft"))).toEqual(ok);
    expect(w.stats().resourceCalls).toBe(1);
    expect(await w.submit(alice, w.proposal("testSafeEcho"))).toEqual(ok);
    expect(w.stats().resourceCalls).toBe(1);
  });
  it.each(["allowed", "denied", "unknown", "throws", "hangs", "wrong-type", "no-permission"])("page restricted capability: %s", async mode => {
    vi.useFakeTimers();
    try {
      const w = withGateway(); w.setReportedPage(mode === "denied" ? "other" : mode === "unknown" ? null : "home");
      if (mode === "no-permission") w.setPermissionAnswer(false);
      if (mode === "throws" || mode === "hangs" || mode === "wrong-type") w.injectFault("pages", mode);
      const pending = submit(w, { registry: registryWith("testSafeEcho", { allowedPages: ["home" as never] }) });
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await pending;
      expect(result.outcome === "ALLOWED").toBe(mode === "allowed");
      expect(w.executorCalls()).toBe(mode === "allowed" ? 1 : 0);
      expect(w.stats().pageCalls).toBe(mode === "no-permission" ? 0 : mode === "throws" || mode === "hangs" || mode === "wrong-type" ? 0 : 1);
    } finally { vi.useRealTimers(); }
  });
});

describe("LIMIT-02 / RISK-01", () => {
  it("audit outage is not user abuse; the session executes immediately after recovery", async () => {
    const w = withGateway(); w.audit.failAppend(true);
    for (let i = 0; i < 6; i++) expect((await w.submit(alice, w.proposal("testSafeEcho"), { turn: `outage-${i}` })).outcome).toBe("DENIED");
    expect(w.executorCalls()).toBe(0); w.audit.failAppend(false);
    expect(await w.submit(alice, w.proposal("testSafeEcho"), { turn: "recovered" })).toEqual(ok);
    expect(w.executorCalls()).toBe(1);
  });
  it("actual policy abuse still blocks the session", async () => {
    const w = withGateway();
    for (let i = 0; i < 7; i++) await w.submit(alice, { callId: `abuse-${i}`, raw: '{"action":"noSuchAction","params":{}}' });
    expect(w.events().at(-1)?.reason).toBe("denial_throttle"); expect(w.executorCalls()).toBe(0);
  });
  it.each([1, 1000])("MEDIUM opt-out justification length %i is executable", async length => {
    const w = withGateway({ mediumConfirmationJustification: "x".repeat(length) });
    expect(await w.submit(alice, w.proposal("testMediumDraft"))).toEqual(ok);
  });
  it.each([["empty", ""], ["blank", " "], ["too long", "x".repeat(1001)]])("invalid MEDIUM justification is rejected at registration (%s)", (_name, justification) => {
    expect(() => withGateway({ mediumConfirmationJustification: justification })).toThrow();
  });
});
