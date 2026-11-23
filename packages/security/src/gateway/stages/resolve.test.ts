import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionId, GatewayDependencies, TenantActionPolicyStore } from "@dap/contracts";
import { buildRegistry } from "../../registry/build-registry.js";
import { createEnablementPolicy } from "../../registry/enablement.js";
import { createResolveStage } from "./resolve.js";
import { createPipeline } from "../pipeline.js";
import { allowedDecision, denyDecision } from "../decision.js";
import { context, dependencies, input, run, stageMap } from "../fixtures.test-support.js";

afterEach(() => { vi.useRealTimers(); });
function harness(overrides: Partial<Pick<GatewayDependencies, "registry" | "globalAllowlist">> = {}, store: TenantActionPolicyStore = { isDisabled: async () => false }) {
  const { deps } = dependencies();
  let executions = 0;
  const stages = stageMap(() => { throw new Error("No execution without a receipt"); });
  stages.audit = () => { executions++; return { kind: "continue", data: {} }; };
  const resolve = createResolveStage({ registry: deps.registry, globalAllowlist: deps.globalAllowlist, ...overrides, tenantPolicy: store }, { hookTimeoutMs: 20 });
  stages.resolve = resolve;
  return { calls: () => executions, async submit(action: string) {
    stages.intake = () => ({ kind: "continue", data: { callId: "call", action, params: {} } });
    return createPipeline(stages).run(input());
  } };
}
describe("exact resolution and live default-deny enablement", () => {
  it.each(["ViewProject", "viewproject", " viewProject", "viewProject ", "viewProject\u200b", "viеwProject", "__proto__", "constructor", "toString", "hasOwnProperty", "missingAction"])("%s never matches", async (name) => {
    const test = harness();
    expect(await test.submit(name)).toMatchObject({ outcome: "INVALID_ACTION", reason: "unknown_action" });
    expect(test.calls()).toBe(0);
  });
  it.each(["executeShell", "EXECUTE_SHELL", "execute-shell", "runQuery", "fetchUrl"])("%s is a reserved policy denial", async (name) => {
    const test = harness();
    expect(await test.submit(name)).toMatchObject({ outcome: "FORBIDDEN_POLICY", reason: "reserved_forbidden_action" });
    expect(test.calls()).toBe(0);
  });
  it("requires the global allowlist before consulting the tenant", async () => {
    let reads = 0;
    const test = harness({ globalAllowlist: new Set() }, { isDisabled: async () => { reads++; return false; } });
    expect(await test.submit("viewProject")).toMatchObject({ outcome: "DENIED", reason: "action_not_enabled" });
    expect(reads).toBe(0);
    expect(test.calls()).toBe(0);
  });
  it("rechecks tenant policy on every request, passing only minted tenant and exact id", async () => {
    let disabled = true;
    const seen: unknown[] = [];
    const test = harness({}, { isDisabled: async (scope, id) => { seen.push([scope, id]); expect(Object.isFrozen(scope)).toBe(true); return disabled; } });
    expect(await test.submit("viewProject")).toMatchObject({ outcome: "DENIED", reason: "tenant_action_disabled" });
    expect(test.calls()).toBe(0);
    disabled = false;
    expect((await test.submit("viewProject"))).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "execute" });
    expect(test.calls()).toBe(1);
    expect(seen).toEqual([[{ tenantId: input().context && (input().context as { tenantId: string }).tenantId }, "viewProject"], [{ tenantId: (input().context as { tenantId: string }).tenantId }, "viewProject"]]);
  });
  it.each([undefined, null, 0, "false", {}])("tenant malformed answer %j is dependency failure", async (answer) => {
    const test = harness({}, { isDisabled: async () => answer } as TenantActionPolicyStore);
    expect(await test.submit("viewProject")).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
    expect(test.calls()).toBe(0);
  });
  it("contains tenant exceptions and timeouts", async () => {
    vi.useFakeTimers();
    for (const isDisabled of [async () => { throw new Error("CANARY"); }, () => new Promise<boolean>(() => {})]) {
      const test = harness({}, { isDisabled });
      const pending = test.submit("viewProject");
      await vi.advanceTimersByTimeAsync(20);
      expect(await pending).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
      expect(test.calls()).toBe(0);
    }
  });
  it("never permits a FORBIDDEN registry entry", async () => {
    const { definition } = dependencies();
    const registry = buildRegistry([{ ...definition, id: "blockedAction" as ActionId, risk: "FORBIDDEN" }]);
    const test = harness({ registry, globalAllowlist: new Set() });
    expect(await test.submit("blockedAction")).toMatchObject({ outcome: "FORBIDDEN_POLICY", reason: "reserved_forbidden_action" });
    expect(test.calls()).toBe(0);
    expect(() => harness({ registry, globalAllowlist: new Set(["blockedAction" as ActionId]) })).toThrow();
  });

  it.each([{}, { action: 5 }, { action: null }, { action: ["viewProject"] }, { params: {} }])("an intake result without a string action (%j) is a dependency failure", async (facts) => {
    let tenantReads = 0;
    let executions = 0;
    const { deps } = dependencies();
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    stages.intake = () => ({ kind: "continue", data: facts as never });
    stages.resolve = createResolveStage({ registry: deps.registry, globalAllowlist: deps.globalAllowlist, tenantPolicy: { isDisabled: async () => { tenantReads++; return false; } } }, { hookTimeoutMs: 20 });
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "resolve" });
    expect(tenantReads).toBe(0);
    expect(executions).toBe(0);
  });

  it("the runner denies at context when no minted context exists, so resolve never runs", async () => {
    let resolves = 0;
    const { deps } = dependencies();
    const real = createResolveStage({ registry: deps.registry, globalAllowlist: deps.globalAllowlist, tenantPolicy: { isDisabled: async () => false } });
    const stages = stageMap(() => { throw new Error("unreachable"); });
    stages.context = () => ({ kind: "continue", data: {} });
    stages.intake = () => ({ kind: "continue", data: { action: "viewProject" } });
    stages.resolve = (request) => { resolves++; return real(request); };
    expect(await createPipeline(stages).run({ ...input(), context: { ...context() } })).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "context" });
    expect(resolves).toBe(0);
  });

  it("still refuses, on its own, a request record that carries no context", async () => {
    let reads = 0;
    const { deps } = dependencies();
    const stage = createResolveStage({ registry: deps.registry, globalAllowlist: deps.globalAllowlist, tenantPolicy: { isDisabled: async () => { reads++; return false; } } });
    const record = { ...input(), run, context: null, facts: { intake: { action: "viewProject" } }, budget: { remainingMs: () => 1 } };
    expect(await stage(record)).toMatchObject({ kind: "stop", decision: { outcome: "DENIED", reason: "dependency_failure", stage: "resolve" } });
    expect(reads).toBe(0);
  });

  it("truncates a very long attempted action name in the decision", async () => {
    const decision = await harness().submit("x".repeat(100_000));
    expect(decision).toMatchObject({ outcome: "INVALID_ACTION", reason: "unknown_action" });
    expect((decision as { attemptedAction: string }).attemptedAction).toHaveLength(64);
  });

  it("continues with only the registry facts later stages may trust", async () => {
    let facts: unknown;
    const { deps, definition } = dependencies();
    const stages = stageMap(() => { throw new Error("unreachable"); });
    stages.intake = () => ({ kind: "continue", data: { action: "viewProject", params: { a: 1 } } });
    stages.resolve = createResolveStage({ registry: deps.registry, globalAllowlist: deps.globalAllowlist, tenantPolicy: { isDisabled: async () => false } });
    stages.validate = (request) => { facts = request.facts.resolve; return { kind: "continue", data: {} }; };
    await createPipeline(stages).run(input());
    expect(facts).toEqual({ id: definition.id, version: 1, risk: "SAFE", definitionHash: deps.registry.get(definition.id)!.definitionHash });
  });

  it("refuses at construction an allowlist naming an unknown action, like the enablement policy", () => {
    const { deps } = dependencies();
    const unknown = new Set(["noSuchAction" as ActionId]);
    expect(() => createResolveStage({ registry: deps.registry, globalAllowlist: unknown, tenantPolicy: { isDisabled: async () => false } })).toThrow(/unknown action id/);
    expect(() => createEnablementPolicy({ registry: deps.registry, globalAllowlist: unknown, tenantPolicy: { isDisabled: async () => false } })).toThrow(/unknown action id/);
  });

  it("snapshots the global allowlist at construction", async () => {
    const { deps, definition } = dependencies();
    const allowlist = new Set([definition.id]);
    const stage = createResolveStage({ registry: deps.registry, globalAllowlist: allowlist, tenantPolicy: { isDisabled: async () => false } });
    allowlist.clear();
    const stages = stageMap(() => { throw new Error("unreachable"); });
    stages.intake = () => ({ kind: "continue", data: { action: "viewProject" } });
    stages.resolve = stage;
    stages.validate = () => ({ kind: "stop", decision: allowedDecision({ decisionId: "decision-request", requestId: "request" as never, actionId: "viewProject" as never, risk: "SAFE", paramsDigest: "a".repeat(64) as never }) });
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "validate" });
  });

  // Resolve keeps richer denial reasons than the boolean enablement policy, but must never disagree on whether
  // an action is enabled: it continues exactly when createEnablementPolicy says so.
  describe.each([
    { allowlisted: true, tenant: false }, { allowlisted: true, tenant: true }, { allowlisted: false, tenant: false }, { allowlisted: true, tenant: "throw" },
    { allowlisted: true, tenant: undefined }, { allowlisted: true, tenant: "false" }, { allowlisted: false, tenant: true },
  ] as const)("agrees with the enablement policy for %j", ({ allowlisted, tenant }) => {
    it("allows or denies identically", async () => {
      const { deps, definition } = dependencies();
      const store = { isDisabled: async () => { if (tenant === "throw") throw new Error("down"); return tenant; } } as unknown as TenantActionPolicyStore;
      const globalAllowlist = new Set(allowlisted ? [definition.id] : []);
      const enabled = await createEnablementPolicy({ registry: deps.registry, globalAllowlist, tenantPolicy: store }).isEnabled({ tenantId: context().tenantId }, "viewProject").catch(() => false);
      let reached = false;
      const stages = stageMap(() => { throw new Error("unreachable"); });
      stages.intake = () => ({ kind: "continue", data: { action: "viewProject" } });
      stages.resolve = createResolveStage({ registry: deps.registry, globalAllowlist, tenantPolicy: store });
      stages.validate = () => { reached = true; return { kind: "continue", data: {} }; };
      const decision = await createPipeline(stages).run(input());
      expect(reached).toBe(enabled);
      expect(decision.outcome === "DENIED" && decision.stage === "resolve").toBe(!enabled);
      expect(enabled).toBe(allowlisted && tenant === false);
    });
  });

  describe("registry entry capture", () => {
    /** The registry answers truthfully while the stage is built (allowlist validation) and `entryFor` afterwards. */
    function run(entryFor: (name: string) => unknown) {
      const { deps, definition } = dependencies();
      let live = false;
      const registry = { get: (name: string) => (live ? entryFor(name) : deps.registry.get(name)), list: deps.registry.list, isReservedForbidden: deps.registry.isReservedForbidden, fingerprint: deps.registry.fingerprint } as unknown as GatewayDependencies["registry"];
      let tenantReads = 0;
      let executions = 0;
      let facts: unknown;
      const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
      stages.intake = () => ({ kind: "continue", data: { action: "viewProject" } });
      stages.resolve = createResolveStage({ registry, globalAllowlist: new Set([definition.id]), tenantPolicy: { isDisabled: async () => { tenantReads++; await Promise.resolve(); return false; } } });
      // validate observes what resolve published, then ends the run with a denial of its own.
      stages.validate = (request) => { facts = request.facts.resolve; return { kind: "stop", decision: denyDecision({ decisionId: request.decisionId, requestId: request.requestId, outcome: "DENIED", reason: "dependency_failure", stage: "validate" }) }; };
      live = true;
      return createPipeline(stages).run(input()).then((decision) => ({ decision, facts, tenantReads, executions }));
    }

    it("reads the entry and each of its fields exactly once, all before the tenant policy await", async () => {
      const { deps, definition } = dependencies();
      const real = deps.registry.get(definition.id)!;
      const reads = new Map<string, number>();
      const count = (key: string) => reads.set(key, (reads.get(key) ?? 0) + 1);
      const entry = {
        get definition() { count("definition"); return { get id() { count("id"); return real.definition.id; }, get version() { count("version"); return real.definition.version; }, get risk() { count("risk"); return real.definition.risk; } }; },
        get definitionHash() { count("definitionHash"); return real.definitionHash; },
      };
      const result = await run(() => entry);
      expect(result.decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "validate" });
      expect(result.facts).toEqual({ id: definition.id, version: 1, risk: "SAFE", definitionHash: real.definitionHash });
      expect([...reads.entries()].sort()).toEqual([["definition", 1], ["definitionHash", 1], ["id", 1], ["risk", 1], ["version", 1]]);
      expect(result.tenantReads).toBe(1);
      expect(Object.isFrozen(result.facts)).toBe(true);
    });

    it("refuses an entry whose definition is not the action that was asked for", async () => {
      const { definition } = dependencies();
      const registry = buildRegistry([{ ...definition, id: "otherAction" as ActionId }]);
      const result = await run(() => registry.get("otherAction"));
      expect(result.decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "resolve" });
      expect(result.tenantReads).toBe(0);
      expect(result.executions).toBe(0);
    });

    it.each([undefined, null, 5, "entry", [], {}, { definition: null, definitionHash: "x" }, { definition: { id: "viewProject", version: "1", risk: "SAFE" }, definitionHash: "x" }, { definition: { id: "viewProject", version: 1, risk: 5 }, definitionHash: "x" }, { definition: { id: "viewProject", version: 1, risk: "SAFE" }, definitionHash: 5 },
    ...[0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2].map((version) => ({ definition: { id: "viewProject", version, risk: "SAFE" }, definitionHash: "a".repeat(64) })),
    { definition: { id: "viewProject", version: 1, risk: "ROOT" }, definitionHash: "a".repeat(64) }, { definition: { id: "viewProject", version: 1, risk: "SAFE" }, definitionHash: "A".repeat(64) }, { definition: { id: "viewProject", version: 1, risk: "SAFE" }, definitionHash: "a".repeat(63) }])("treats the malformed entry %j as a failure, never an allow", async (entry) => {
      const result = await run(() => entry);
      expect(result.decision.outcome).not.toBe("ALLOWED");
      expect(result.decision).toMatchObject({ stage: "resolve" });
      expect(result.tenantReads).toBe(0);
      expect(result.executions).toBe(0);
    });

    it("contains a registry that throws", async () => {
      const result = await run(() => { throw new Error("CANARY"); });
      expect(result.decision).toMatchObject({ outcome: "DENIED", reason: "internal_error", stage: "resolve" });
      expect(JSON.stringify(result.decision)).not.toContain("CANARY");
      expect(result.tenantReads).toBe(0);
    });
  });
});
