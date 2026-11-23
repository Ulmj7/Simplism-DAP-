/** T117: intake-to-authorize tests use the real composed rate/replay stages; risk remains absent. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineAction, defineExecutor } from "@dap/contracts";
import type { ActionId, ExecutorId, GatewayDependencies, PermissionId, PlannerFeedback } from "@dap/contracts";
import { bindExecutors } from "../registry/bind-executors.js";
import { buildRegistry } from "../registry/build-registry.js";
import { composeStages, createPolicyGateway } from "./create-gateway.js";
import type { PipelineRecord, PolicyStage } from "./pipeline.js";
import { context, dependencies, run } from "./fixtures.test-support.js";

function world(config: Partial<GatewayDependencies["config"]> = {}) {
  const { deps } = dependencies();
  let executions = 0;
  let tenantChecks = 0;
  const open = defineAction({
    id: "openProject" as ActionId, version: 1, description: "Open a project", inputSchema: z.strictObject({ projectId: z.string().min(1).max(12), limit: z.number().int().min(1).max(100).optional() }),
    risk: "SAFE", requiredPermission: "project:view" as PermissionId, allowedPages: "any", confirmation: { kind: "not-required" }, changesState: false, audit: { params: [] }, executorId: "openProjectExecutor" as ExecutorId,
  });
  const registry = buildRegistry([open]);
  const executor = defineExecutor({ id: open.executorId, run: async () => { executions++; return { status: "success" as const }; } });
  const wired: GatewayDependencies = { ...deps, registry, executors: bindExecutors(registry, [executor]), globalAllowlist: new Set([open.id]),
    state: { ...deps.state, tenantPolicy: { isDisabled: async () => { tenantChecks++; return false; } } }, config: { ...deps.config, ...config } };
  let callIndex = 0;
  const gateway = createPolicyGateway(wired);
  const real = (raw: unknown, callId = `call_${++callIndex}`): Promise<PlannerFeedback> => gateway.proposals.forSession(context(), run).submit({ callId, raw });
  return { real, submit: real, executions: () => executions, tenantChecks: () => tenantChecks };

}
const text = (action: unknown, params: unknown) => JSON.stringify({ action, params });
const TRY_LATER = { outcome: "DENIED", category: "try_later" };
const NOT_AVAILABLE = { outcome: "INVALID_ACTION", category: "not_available" };

describe("the proposal door with intake and validate wired in", () => {
  it("denies a valid proposal fail-closed at the first absent stage, after resolve and validate, before any executor", async () => {
    const w = world();
    expect(await w.real(text("openProject", { projectId: "p1" }))).toEqual(TRY_LATER);
    expect(w.tenantChecks()).toBe(1);
    expect(w.executions()).toBe(0);
  });

  it("lets a valid proposal through intake, resolve and validate, then denies fail-closed at the next absent stage", async () => {
    const w = world();
    expect(await w.submit(text("openProject", { projectId: "p1" }))).toEqual(TRY_LATER);
    expect(w.tenantChecks()).toBe(1); // resolve ran, so intake published a well-formed envelope
    expect(w.executions()).toBe(0);
  });

  it("stops a malformed envelope at intake: generic not_available, and resolve never runs", async () => {
    const w = world();
    for (const raw of ["{}", "not json", '{"action":"openProject","params":{},"callId":"mine"}', text("open Project", {}), text(5, {}), []]) {
      expect(await w.real(raw), String(raw)).toEqual(NOT_AVAILABLE);
    }
    expect(w.tenantChecks()).toBe(0);
  });

  it("stops invalid parameters at validate with structural issues only", async () => {
    const w = world();
    expect(await w.submit(text("openProject", {}))).toEqual({ outcome: "INVALID_PARAMETERS", category: "invalid_input", issues: [{ path: "/projectId", code: "required" }] });
    expect(await w.submit(text("openProject", { projectId: "p", limit: 1000 }))).toEqual({ outcome: "INVALID_PARAMETERS", category: "invalid_input", issues: [{ path: "/limit", code: "out_of_range" }] });
    expect(await w.submit(text("openProject", { projectId: 7 }))).toEqual({ outcome: "INVALID_PARAMETERS", category: "invalid_input", issues: [{ path: "/projectId", code: "type" }] });
    expect(w.tenantChecks()).toBe(3); // validate runs after resolve
    expect(w.executions()).toBe(0);
  });

  it("never echoes a parameter value, a model-authored key or an action name back to the planner", async () => {
    const w = world();
    const results = await Promise.all([
      w.submit(text("openProject", { projectId: "CANARY_VALUE_TOO_LONG", CANARY_KEY: "CANARY_OTHER" })), w.submit(text("CANARY_ACTION\n", { CANARY_KEY: "CANARY_VALUE" })),
      w.submit(text("openProject", { projectId: "p", CANARY_KEY: 1 })), w.submit(text("canaryAction", { CANARY_KEY: "CANARY_VALUE" })),
    ]);
    for (const result of results) expect(JSON.stringify(result)).not.toMatch(/CANARY|canary/i);
    expect(results[2]).toEqual({ outcome: "INVALID_PARAMETERS", category: "invalid_input", issues: [{ path: "", code: "unknown_key" }] });
  });

  it("treats a non-finite or unsafe number as invalid parameters, with no issues to read", async () => {
    const w = world();
    for (const raw of ['{"action":"openProject","params":{"projectId":"p","limit":1e999}}', { action: "openProject", params: { projectId: "p", limit: NaN } }, '{"action":"openProject","params":{"projectId":"p","limit":9007199254740993}}']) {
      expect(await w.submit(raw)).toEqual({ outcome: "INVALID_PARAMETERS", category: "invalid_input" });
    }
    expect(w.tenantChecks()).toBe(0); // decided at intake
  });

  it("applies the gateway's configured payload and depth caps", async () => {
    const ok = text("openProject", { projectId: "p1" });
    expect(await world({ maxPayloadBytes: ok.length }).real(ok)).toEqual(TRY_LATER);
    expect(await world({ maxPayloadBytes: ok.length - 1 }).real(ok)).toEqual(NOT_AVAILABLE);
    expect(await world({ maxJsonDepth: 2 }).real(ok)).toEqual(TRY_LATER);
    expect(await world({ maxJsonDepth: 1 }).real(ok)).toEqual(NOT_AVAILABLE);
  });

  it("treats a malformed callId as the runner's defect (try_later), not as a planner fault", async () => {
    const w = world();
    for (const callId of ["", "a b", "a\nb", "x".repeat(257)]) expect(await w.submit(text("openProject", { projectId: "p1" }), callId), JSON.stringify(callId.slice(0, 4))).toEqual(TRY_LATER);
    expect(w.tenantChecks()).toBe(0);
  });

  it("honours accessors of an already-parsed proposal exactly once", async () => {
    const w = world();
    let reads = 0;
    const raw = { get action() { reads++; return "openProject"; }, get params() { reads++; return { get projectId() { reads++; return "p1"; } }; } };
    expect(await w.submit(raw)).toEqual(TRY_LATER);
    expect(reads).toBe(3);
  });

  it("still resolves first: unknown and reserved actions are not_available and reach no parameter check", async () => {
    const w = world();
    expect(await w.submit(text("missingAction", {}))).toEqual(NOT_AVAILABLE);
    expect(await w.submit(text("executeShell", { command: "id" }))).toEqual({ outcome: "FORBIDDEN_POLICY", category: "not_available" });
    expect(w.executions()).toBe(0);
  });
});

describe("the composed stages", () => {
  const record = (facts: object): PipelineRecord => ({ decisionId: "d", requestId: "r", run, budget: { remainingMs: () => 1000 }, context: context(), readProposal: () => { throw new Error("withheld"); }, facts }) as unknown as PipelineRecord;

  it("are exactly the eleven D6 positions: context, intake, rate_limit, replay, resolve, validate, authorize, risk, confirmation, audit and execute", () => {
    expect(Object.keys(composeStages(dependencies().deps)).sort()).toEqual(["audit", "authorize", "confirmation", "context", "execute", "intake", "rate_limit", "replay", "resolve", "risk", "validate"]);
  });

  it("bind intake to the gateway's configured caps", async () => {
    const { deps } = dependencies();
    const stage = composeStages({ ...deps, config: { ...deps.config, maxPayloadBytes: 36 } }).intake as PolicyStage;
    const proposal = (raw: string) => ({ ...record({}), readProposal: () => ({ callId: "c", raw }) });
    expect(await stage(proposal('{"action":"viewProject","params":{}}'))).toMatchObject({ kind: "continue" }); // exactly 36 bytes
    expect(await stage(proposal('{"action":"viewProject","params":{} }'))).toMatchObject({ kind: "stop", decision: { reason: "payload_too_large" } });
  });

  it("bind validate to the registry and the configured depth", async () => {
    const { deps } = dependencies();
    const entry = deps.registry.get("viewProject")!;
    const resolved = { id: "viewProject", version: entry.definition.version, risk: "SAFE", definitionHash: entry.definitionHash };
    const facts = { intake: { callId: "c", action: "viewProject", params: {} }, resolve: resolved };
    const stage = composeStages(deps).validate as PolicyStage;
    expect(await stage(record(facts))).toMatchObject({ kind: "continue", data: { params: {}, resource: null } });
    // The fixture's schema accepts no keys, so a rejection here also proves the registry's own schema is the one used.
    expect(await stage(record({ ...facts, intake: { ...facts.intake, params: { extra: 1 } } }))).toMatchObject({ kind: "stop", decision: { outcome: "INVALID_PARAMETERS", issues: [{ path: "", code: "unknown_key" }] } });
  });

  it("bind validate to the configured depth, not to a default", async () => {
    const { deps } = dependencies();
    const entry = deps.registry.get("viewProject")!;
    const accepting = { ...deps.registry, get: () => ({ definition: { ...entry.definition, inputSchema: { safeParse: (value: unknown) => ({ success: true, data: value }) } }, definitionHash: entry.definitionHash }) };
    const nested = (levels: number): unknown => levels === 0 ? 1 : { a: nested(levels - 1) };
    const resolved = { id: "viewProject", version: entry.definition.version, risk: "SAFE", definitionHash: entry.definitionHash };
    const facts = { intake: { callId: "c", action: "viewProject", params: nested(10) }, resolve: resolved };
    const deep = composeStages({ ...deps, registry: accepting as never, config: { ...deps.config, maxJsonDepth: 12 } }).validate as PolicyStage;
    const shallow = composeStages({ ...deps, registry: accepting as never, config: { ...deps.config, maxJsonDepth: 4 } }).validate as PolicyStage;
    expect(await deep(record(facts))).toMatchObject({ kind: "continue" }); // deeper than the default of 8
    expect(await shallow(record(facts))).toMatchObject({ kind: "stop", decision: { outcome: "INVALID_PARAMETERS" } });
  });

  it("bind authorize to the gateway's hook timeout and host ports", async () => {
    vi.useFakeTimers();
    try {
      const { deps } = dependencies();
      const entry = deps.registry.get("viewProject")!;
      const hung = new Promise<boolean>(() => {});
      const seen: unknown[] = [];
      const stage = composeStages({ ...deps, config: { ...deps.config, hookTimeoutMs: 40 }, hooks: { ...deps.hooks, permissions: { has: (...args: unknown[]) => { seen.push(args); return hung; } } as never } }).authorize as PolicyStage;
      const facts = { resolve: { id: "viewProject", version: entry.definition.version, risk: "SAFE", definitionHash: entry.definitionHash }, validate: { params: {}, paramsDigest: "a".repeat(64), resource: null } };
      const pending = stage({ ...record(facts), budget: { remainingMs: () => 10_000 } });
      await vi.advanceTimersByTimeAsync(39);
      let settled = false;
      void Promise.resolve(pending).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({ kind: "stop", decision: { outcome: "DENIED", reason: "dependency_failure", stage: "authorize" } });
      expect(seen).toHaveLength(1); // the gateway's own permission port was the one asked
    } finally { vi.useRealTimers(); }
  });
});
