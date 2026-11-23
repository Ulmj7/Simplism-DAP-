import { afterEach, describe, expect, it, vi } from "vitest";
import { PIPELINE_STAGES } from "@dap/contracts";
import type { GatewayDependencies, PolicyDecision } from "@dap/contracts";
import { mintExecutionGrant } from "@dap/contracts/mint";
import { createPipeline, type PolicyStage } from "./pipeline.js";
import { createPolicyGateway } from "./create-gateway.js";
import { allowedDecision, confirmationDecision, denyDecision } from "./decision.js";
import { context, dependencies, input, stageMap } from "./fixtures.test-support.js";

afterEach(() => { vi.useRealTimers(); });

describe("pipeline fail-closed boundary (T058)", () => {
  for (const stage of PIPELINE_STAGES) {
    it.each(["throw", "reject", "undefined", "wrong shape", "getter", "timeout"])(`${stage}${stage === "execute" ? " (unconfirmed receipt stops before the fixture)" : ""}: %s denies before execution`, async (fault) => {
      vi.useFakeTimers();
      let executions = 0;
      const stages = stageMap(() => { executions++; throw new Error("terminal should not run"); });
      const broken = (() => {
        if (fault === "throw") throw new Error("CANARY_SECRET");
        if (fault === "reject") return Promise.reject(new Error("CANARY_SECRET"));
        if (fault === "timeout") return new Promise(() => {});
        if (fault === "getter") return { get kind() { throw new Error("CANARY_SECRET"); } };
        return fault === "undefined" ? undefined : { kind: "continue", data: { value: () => true } };
      }) as PolicyStage;
      stages[stage] = broken;
      const pending = createPipeline(stages, { hookTimeoutMs: 20, proposalBudgetMs: 20 }).run(input());
      // Execute gets what is left of the budget PLUS one hook timeout (the executor may use the budget; recording its result has its own time).
      await vi.advanceTimersByTimeAsync(stage === "execute" ? 40 : 20);
      const decision = await pending;
      expect(decision).toMatchObject({ outcome: "DENIED", reason: stage !== "execute" && ["throw", "reject"].includes(fault) ? "internal_error" : "dependency_failure", stage });
      expect(executions).toBe(0);
      expect(JSON.stringify(decision)).not.toContain("CANARY");
    });
  }

  it.each(PIPELINE_STAGES.filter((name) => name !== "execute"))("%s cannot short-circuit to ALLOWED", async (stage) => {
    let executions = 0;
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    stages[stage] = (request) => ({ kind: "stop", decision: allowedDecision({ decisionId: request.decisionId, requestId: request.requestId, actionId: "viewProject" as never, risk: "SAFE", paramsDigest: "a".repeat(64) as never }) });
    const decision = await createPipeline(stages).run(input());
    expect(decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage });
    expect(executions).toBe(0);
  });

  it.each(PIPELINE_STAGES)("a missing %s denies before terminal execution", async (missing) => {
    let executions = 0;
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    delete stages[missing];
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: missing });
    expect(executions).toBe(0);
  });

  it.each([null, {}, { outcome: "ALLOWED" }, { outcome: "DENIED", reason: "allowed" }])("rejects malformed decision %j", async (decision) => {
    let executions = 0;
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    stages.authorize = () => ({ kind: "stop", decision: decision as PolicyDecision });
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
    expect(executions).toBe(0);
  });

  const missing = ["registry", "registry.get", "registry.list", "registry.isReservedForbidden", "registry.fingerprint", "executors", "executors.executorFor", "globalAllowlist", "hooks", "hooks.permissions", "hooks.permissions.has", "hooks.resources", "hooks.resources.resolve", "hooks.pages", "hooks.pages.currentPage", "state", "state.replay", "state.replay.claim", "state.rateLimiter", "state.rateLimiter.hit", "state.rateLimiter.isBlocked", "state.rateLimiter.block", "state.confirmations", "state.confirmations.create", "state.confirmations.get", "state.confirmations.listPending", "state.confirmations.tryAccept", "state.confirmations.tryReject", "state.confirmations.invalidate", "state.confirmations.recordExecution", "state.tenantPolicy", "state.tenantPolicy.isDisabled", "state.ping", "audit", "audit.append", "confirmationChannel", "confirmationChannel.deliver", "config", "clock", "clock.now", "ids", "ids.newDecisionId", "ids.newConfirmationId", "config.limits", "config.maxPayloadBytes", "config.maxJsonDepth", "config.replayRetentionSeconds", "config.confirmationDefaultTtlSeconds", "config.hookTimeoutMs", "config.limits.proposalsPerTurn", "config.limits.executionsPerTurn", "config.limits.maxChainDepth", "config.limits.turnBudgetMs", "config.limits.perUserPerMinute", "config.limits.perTenantPerMinute", "config.limits.perUserPerCapabilityPerMinute", "config.limits.highRiskPerUserPerHour", "config.limits.denialThrottle"];
  /** Copy only the path being edited, so the shared fixture stays intact. */
  function edit(path: string, change: (parent: Record<string, unknown>, key: string) => void) {
    const { deps, calls } = dependencies();
    const keys = path.split(".");
    let parent = deps as unknown as Record<string, unknown>;
    for (const key of keys.slice(0, -1)) {
      const child = { ...(parent[key] as object) };
      parent[key] = child;
      parent = child;
    }
    change(parent, keys.at(-1)!);
    return { deps: deps as GatewayDependencies, calls };
  }
  it.each(missing)("gateway rejects missing dependency %s at construction", (path) => {
    const { deps, calls } = edit(path, (parent, key) => { delete parent[key]; });
    expect(() => createPolicyGateway(deps)).toThrow();
    expect(calls()).toBe(0);
  });

  it.each(["registry.get", "registry.list", "registry.isReservedForbidden", "executors.executorFor", "hooks.permissions.has", "hooks.resources.resolve", "hooks.pages.currentPage", "state.ping", "state.replay.claim", "state.rateLimiter.hit", "state.confirmations.tryAccept", "state.tenantPolicy.isDisabled", "audit.append", "confirmationChannel.deliver", "clock.now", "ids.newDecisionId", "ids.newConfirmationId"])("gateway rejects a non-function %s", (path) => {
    for (const value of ["method", null, 7, {}]) {
      const { deps, calls } = edit(path, (parent, key) => { parent[key] = value; });
      expect(() => createPolicyGateway(deps)).toThrow();
      expect(calls()).toBe(0);
    }
  });

  it.each(["registry", "executors", "hooks", "hooks.permissions", "state", "state.replay", "state.tenantPolicy", "audit", "confirmationChannel", "clock", "ids", "config", "config.limits", "globalAllowlist"])("gateway rejects a null or primitive %s", (path) => {
    for (const value of [null, undefined, "port", 1]) {
      const { deps, calls } = edit(path, (parent, key) => { parent[key] = value; });
      expect(() => createPolicyGateway(deps)).toThrow();
      expect(calls()).toBe(0);
    }
  });

  it.each([undefined, null, "", "abc", "A".repeat(64), "a".repeat(63), 1])("gateway rejects registry fingerprint %j", (fingerprint) => {
    const { deps } = edit("registry.fingerprint", (parent, key) => { parent[key] = fingerprint; });
    expect(() => createPolicyGateway(deps)).toThrow();
  });

  it.each([0, -1, 1.5, "60", null])("gateway rejects invalid configuration value %j", (value) => {
    for (const path of ["config.hookTimeoutMs", "config.maxPayloadBytes", "config.maxJsonDepth", "config.limits.proposalsPerTurn", "config.limits.perUserPerMinute.limit"]) {
      const { deps } = edit(path, (parent, key) => { parent[key] = value; });
      expect(() => createPolicyGateway(deps)).toThrow();
    }
  });

  it("gateway rejects an allowlist naming an action the registry does not hold", () => {
    const { deps, otherId } = (() => { const made = dependencies(); return { deps: made.deps, otherId: made.otherId }; })();
    Object.assign(deps, { globalAllowlist: new Set([otherId]) });
    expect(() => createPolicyGateway(deps)).toThrow();
  });

  it("a stage cannot report a denial attributed to a different stage", async () => {
    let executions = 0;
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    stages.authorize = (request) => ({ kind: "stop", decision: denyDecision({ decisionId: request.decisionId, requestId: request.requestId, outcome: "UNAUTHORIZED", reason: "permission_missing", stage: "intake" }) });
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "authorize" });
    expect(executions).toBe(0);
  });

  it("a denial can never carry the success reason", async () => {
    let executions = 0;
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    stages.authorize = (request) => ({ kind: "stop", decision: denyDecision({ decisionId: request.decisionId, requestId: request.requestId, reason: "allowed", stage: "authorize" }) });
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "authorize" });
    expect(executions).toBe(0);
  });

  it.each(["decisionId", "requestId"] as const)("a stage cannot answer for a different %s", async (field) => {
    let executions = 0;
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    stages.authorize = (request) => ({ kind: "stop", decision: denyDecision({ decisionId: request.decisionId, requestId: request.requestId, reason: "permission_missing", stage: "authorize", outcome: "UNAUTHORIZED", ...{ [field]: "someone-else" } }) });
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "authorize" });
    expect(executions).toBe(0);
  });

  it.each([["ALLOWED", "risk"], ["REQUIRES_CONFIRMATION", "authorize"], ["REQUIRES_CONFIRMATION", "execute"]] as const)("%s from the %s stage is premature", async (outcome, stage) => {
    let executions = 0;
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    const base = { decisionId: "decision-request", requestId: "request" as never, actionId: "viewProject" as never, risk: "SAFE" as const };
    stages[stage] = () => ({ kind: "stop", decision: outcome === "ALLOWED" ? allowedDecision({ ...base, paramsDigest: "a".repeat(64) as never }) : confirmationDecision({ ...base, confirmationId: "00000000-0000-4000-8000-000000000009" as never }) });
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage });
    expect(executions).toBe(0);
  });

  it.each(["risk", "confirmation"] as const)("REQUIRES_CONFIRMATION from %s is accepted and stops the pipeline", async (stage) => {
    let executions = 0;
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    stages[stage] = () => ({ kind: "stop", decision: confirmationDecision({ decisionId: "decision-request", requestId: "request" as never, actionId: "viewProject" as never, risk: "HIGH", confirmationId: "00000000-0000-4000-8000-000000000009" as never }) });
    expect(await createPipeline(stages).run(input())).toMatchObject({ outcome: "REQUIRES_CONFIRMATION" });
    expect(executions).toBe(0);
  });

  it("preserves the first denial and never runs a later stage", async () => {
    let executions = 0;
    const expected = denyDecision({ decisionId: "decision-request", requestId: "request" as never, outcome: "UNAUTHORIZED", reason: "permission_missing", stage: "authorize" });
    const stages = stageMap(() => { executions++; throw new Error("unreachable"); });
    stages.authorize = () => ({ kind: "stop", decision: expected });
    expect(await createPipeline(stages).run(input())).toEqual(expected);
    expect(executions).toBe(0);
  });

  it("uses a real guarded executor whose counter does change for a valid grant", async () => {
    const { deps, definition, calls } = dependencies();
    const security = context();
    const binding = { requestId: "request" as never, actionId: definition.id, paramsDigest: "a".repeat(64) as never, tenantId: security.tenantId, userId: security.userId };
    const executor = deps.executors.executorFor(definition.executorId)!;
    expect(await executor.execute({ ...binding, security, grant: mintExecutionGrant(binding), params: {}, resource: null })).toEqual({ status: "success" });
    expect(calls()).toBe(1);
  });
});
