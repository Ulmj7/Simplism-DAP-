import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAction } from "@dap/contracts";
import type { ActionId, ActionRegistry, ExecutorId, PermissionId, PolicyDecision } from "@dap/contracts";
import { mintAuthorizationContext } from "@dap/contracts/mint";
import { buildRegistry } from "../../registry/build-registry.js";
import { paramsDigest } from "../../validation/params.js";
import { createValidateStage } from "./validate.js";
import { createPipeline } from "../pipeline.js";
import type { PipelineRecord, PolicyStage } from "../pipeline.js";
import { toPlannerFeedback } from "../feedback.js";
import { context, input, stageMap } from "../fixtures.test-support.js";

const CAPS = { maxPayloadBytes: 16384, maxJsonDepth: 8 };
const definition = defineAction({
  id: "openProject" as ActionId, version: 3, description: "Open a project",
  inputSchema: z.strictObject({ projectId: z.string().trim().min(1).max(12), limit: z.number().int().min(1).max(100).default(10) }),
  risk: "SAFE", requiredPermission: "project:view" as PermissionId, allowedPages: "any", confirmation: { kind: "not-required" }, changesState: false, audit: { params: [] }, executorId: "openProjectExecutor" as ExecutorId,
  resource: (params: { projectId: string }) => ({ type: "project", id: params.projectId }),
} as never);
const registry = buildRegistry([definition]);
const entry = registry.get("openProject")!;
const resolved = { id: "openProject", version: 3, risk: "SAFE", definitionHash: entry.definitionHash };

/** The real validate stage inside the real pipeline, fed by stand-ins for intake and resolve. */
function harness(options: { params?: unknown; intake?: unknown; resolve?: unknown; registry?: ActionRegistry; ctx?: unknown } = {}) {
  const seen: PipelineRecord[] = [];
  const stages = stageMap(() => { throw new Error("No execution without a receipt"); });
  stages.audit = request => { seen.push(request); return { kind: "continue", data: {} }; };
  stages.intake = () => ({ kind: "continue", data: ("intake" in options ? options.intake : { callId: "c", action: "openProject", params: options.params ?? { projectId: "p1" } }) as never });
  stages.resolve = () => ({ kind: "continue", data: ("resolve" in options ? options.resolve : resolved) as never });
  stages.validate = createValidateStage(options.registry ?? registry, CAPS);
  return { seen, run: (): Promise<PolicyDecision> => createPipeline(stages).run({ ...input(), ...(options.ctx ? { context: options.ctx } : {}) }) };
}

describe("validate: the normalized parameters, the resource and the digest", () => {
  it("publishes facts.validate = { params, paramsDigest, resource } from the schema's OUTPUT", async () => {
    const test = harness({ params: { projectId: "  p1  " } });
    expect((await test.run())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "execute" });
    const facts = test.seen[0]!.facts.validate as { params: unknown; paramsDigest: string; resource: unknown };
    expect(Object.keys(facts).sort()).toEqual(["paramsDigest", "params", "resource"].sort());
    expect(facts.params).toEqual({ projectId: "p1", limit: 10 });
    expect(facts.resource).toEqual({ type: "project", id: "p1" });
    expect(facts.paramsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(facts.params)).toBe(true);
  });

  it("binds the digest to the action, version, tenant and user taken from the MINTED context", async () => {
    const test = harness();
    await test.run();
    const ctx = context();
    const facts = test.seen[0]!.facts.validate as { paramsDigest: string };
    const expected = paramsDigest({ actionId: "openProject", version: 3, params: { projectId: "p1", limit: 10 }, resource: { type: "project", id: "p1" }, tenantId: ctx.tenantId, userId: ctx.userId });
    expect(facts.paramsDigest).toBe(expected);
  });

  it("gives another user, another tenant and other parameters a different digest", async () => {
    const digestOf = async (ctx?: unknown, params?: unknown) => { const test = harness({ ...(ctx ? { ctx } : {}), ...(params ? { params } : {}) }); await test.run(); return (test.seen[0]!.facts.validate as { paramsDigest: string }).paramsDigest; };
    const base = await digestOf();
    const other = (overrides: object) => mintAuthorizationContext({ userId: "alice", tenantId: "00000000-0000-4000-8000-000000000001", sessionId: "session", authenticatedAt: "2026-01-01T00:00:00Z", validUntil: "2026-01-01T01:00:00Z", ...overrides } as never);
    expect(await digestOf(other({ userId: "bob" }))).not.toBe(base);
    expect(await digestOf(other({ tenantId: "00000000-0000-4000-8000-000000000002" }))).not.toBe(base);
    expect(await digestOf(undefined, { projectId: "p2" })).not.toBe(base);
    expect(await digestOf(undefined, { projectId: "p1", limit: 11 })).not.toBe(base);
    expect(await digestOf()).toBe(base);
  });
});

describe("validate: rejected parameters", () => {
  it.each([
    ["a missing key", {}, [{ path: "/projectId", code: "required" }]],
    ["a wrong type", { projectId: 5 }, [{ path: "/projectId", code: "type" }]],
    ["a value that is too long", { projectId: "x".repeat(13) }, [{ path: "/projectId", code: "too_long" }]],
    ["a value out of range", { projectId: "p", limit: 101 }, [{ path: "/limit", code: "out_of_range" }]],
    ["an unknown key, reported at its parent", { projectId: "p", CANARY_KEY: 1 }, [{ path: "", code: "unknown_key" }]],
  ])("denies %s as INVALID_PARAMETERS with a structural issue only", async (_name, params, issues) => {
    const test = harness({ params });
    const decision = await test.run();
    expect(decision).toMatchObject({ outcome: "INVALID_PARAMETERS", reason: "invalid_parameters", stage: "validate", attemptedAction: "openProject", issues });
    expect(test.seen).toHaveLength(0);
    expect(JSON.stringify(decision)).not.toMatch(/CANARY|xxxx/);
  });

  it("never echoes a value or a model-authored key to the planner", async () => {
    const decision = await harness({ params: { projectId: "CANARY_VALUE".repeat(3), CANARY_KEY: "CANARY_OTHER" } }).run();
    const feedback = toPlannerFeedback(decision);
    expect(feedback.outcome).toBe("INVALID_PARAMETERS");
    expect(feedback.category).toBe("invalid_input");
    expect(JSON.stringify(feedback)).not.toMatch(/CANARY/);
    expect(JSON.stringify(decision)).not.toMatch(/CANARY/);
  });
});

describe("validate: only the definition resolve authorized is used", () => {
  const denied = async (options: Parameters<typeof harness>[0]) => { const test = harness(options); const decision = await test.run(); expect(test.seen).toHaveLength(0); return decision; };
  const registryReturning = (answer: unknown): ActionRegistry => ({ ...registry, get: () => answer as never, list: registry.list, isReservedForbidden: registry.isReservedForbidden });

  it.each([
    ["a different action than resolve authorized", { intake: { callId: "c", action: "otherAction", params: { projectId: "p" } } }],
    ["params that are not an object", { intake: { callId: "c", action: "openProject", params: [] } }], ["no params", { intake: { callId: "c", action: "openProject" } }],
    ["resolve facts for another version", { resolve: { ...resolved, version: 4 } }], ["resolve facts for another definition hash", { resolve: { ...resolved, definitionHash: "b".repeat(64) } }],
    ["a registry that no longer knows the action", { registry: registryReturning(undefined) }], ["a registry answer that is not an object", { registry: registryReturning("x") }], ["a registry answer that is null", { registry: registryReturning(null) }],
    ["a registry entry without a definition", { registry: registryReturning({ definitionHash: entry.definitionHash }) }],
    ["a scalar definition", { registry: registryReturning({ definition: "bad", definitionHash: entry.definitionHash }) }],
    ["a callable masquerading as a definition", { registry: registryReturning({ definition: Object.assign(() => {}, definition), definitionHash: entry.definitionHash }) }],
    ["a registry that returns another action's definition", { registry: registryReturning({ definition: { ...definition, id: "otherAction" }, definitionHash: entry.definitionHash }) }],
    ["a registry that returns another version", { registry: registryReturning({ definition: { ...definition, version: 9 }, definitionHash: entry.definitionHash }) }],
    ["a registry that returns another hash", { registry: registryReturning({ definition, definitionHash: "c".repeat(64) }) }],
  ])("is a dependency failure for %s", async (_name, options) => {
    expect(await denied(options as never)).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "validate" });
  });

  // The pipeline only lets a stage publish an object, so these shapes are reachable only by running the stage directly.
  const goodFacts = { intake: { callId: "c", action: "openProject", params: { projectId: "p" } }, resolve: resolved };
  const direct = (facts: object, ctx: unknown = context()) => (createValidateStage(registry, CAPS) as PolicyStage)({ ...input(), context: ctx, run: {}, facts } as unknown as PipelineRecord);
  it.each([["no intake facts", { ...goodFacts, intake: undefined }], ["intake facts that are null", { ...goodFacts, intake: null }], ["intake facts that are an array", { ...goodFacts, intake: [] }],
    ["no resolve facts", { ...goodFacts, resolve: undefined }], ["resolve facts that are null", { ...goodFacts, resolve: null }], ["no facts at all", {}]])("is a dependency failure, not a crash, for %s", async (_name, facts) => {
    expect(await direct(facts)).toMatchObject({ kind: "stop", decision: { outcome: "DENIED", reason: "dependency_failure", stage: "validate" } });
  });

  it("is a dependency failure, not a crash, when the stage is run without a minted context", async () => {
    expect(await direct(goodFacts, null)).toMatchObject({ kind: "stop", decision: { outcome: "DENIED", reason: "dependency_failure", stage: "validate" } });
    expect(await direct(goodFacts)).toMatchObject({ kind: "continue" });
  });

  it("reads the registry once and each entry field once per request", async () => {
    let gets = 0;
    const reads = { definition: 0, definitionHash: 0 };
    const counting = registryReturning(null);
    (counting as { get: unknown }).get = () => { gets++; return { get definition() { reads.definition++; return definition; }, get definitionHash() { reads.definitionHash++; return entry.definitionHash; } }; };
    const test = harness({ registry: counting });
    expect((await test.run())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "execute" });
    expect({ gets, ...reads }).toEqual({ gets: 1, definition: 1, definitionHash: 1 });
  });

  it("uses the same first id/version snapshot for the resolve proof and digest", async () => {
    let idReads = 0;
    let versionReads = 0;
    const changing = { ...definition,
      get id() { return ++idReads === 1 ? "openProject" : "otherAction"; },
      get version() { return ++versionReads === 1 ? 3 : 99; },
    };
    const test = harness({ registry: registryReturning({ definition: changing, definitionHash: entry.definitionHash }) });
    expect((await test.run())).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "execute" });
    const facts = test.seen[0]!.facts.validate as { paramsDigest: string };
    const ctx = context();
    expect(facts.paramsDigest).toBe(paramsDigest({ actionId: "openProject", version: 3, params: { projectId: "p1", limit: 10 }, resource: { type: "project", id: "p1" }, tenantId: ctx.tenantId, userId: ctx.userId }));
    expect({ idReads, versionReads }).toEqual({ idReads: 1, versionReads: 1 });
  });

  it("looks the action up by the id resolve published, never by a name the planner typed", async () => {
    const asked: string[] = [];
    const spying = { ...registry, get: (id: string) => { asked.push(id); return registry.get(id); }, list: registry.list, isReservedForbidden: registry.isReservedForbidden } as ActionRegistry;
    await harness({ registry: spying }).run();
    expect(asked).toEqual(["openProject"]);
  });
});

describe("validate: the configured caps", () => {
  // A stand-in schema accepts any plain data, so only the caps decide what passes.
  const anything = { ...registry, get: () => ({ definition: { ...definition, resource: undefined, inputSchema: { safeParse: (value: unknown) => ({ success: true, data: value }) } }, definitionHash: entry.definitionHash }) } as unknown as ActionRegistry;
  const nested = (levels: number): unknown => levels === 0 ? 1 : { a: nested(levels - 1) };
  const facts = (params: unknown) => ({ intake: { callId: "c", action: "openProject", params }, resolve: resolved });
  const run = (caps: object, params: unknown) => (createValidateStage(anything, caps) as PolicyStage)({ ...input(), context: context(), run: {}, facts: facts(params) } as unknown as PipelineRecord);

  it("judge the parameters with the gateway's depth, not a default", async () => {
    expect(await run({ maxJsonDepth: 12 }, nested(10))).toMatchObject({ kind: "continue" }); // beyond the default depth of 8
    expect(await run({ maxJsonDepth: 3 }, nested(2))).toMatchObject({ kind: "continue" });
    expect(await run({ maxJsonDepth: 3 }, nested(3))).toMatchObject({ kind: "continue" });
    expect(await run({ maxJsonDepth: 3 }, nested(4))).toMatchObject({ kind: "stop", decision: { outcome: "INVALID_PARAMETERS", stage: "validate" } });
  });

  it("are copied at construction: the caller cannot widen them afterwards", async () => {
    const caps = { maxJsonDepth: 3 };
    const stage = createValidateStage(anything, caps) as PolicyStage;
    caps.maxJsonDepth = 100;
    expect(await stage({ ...input(), context: context(), run: {}, facts: facts(nested(4)) } as unknown as PipelineRecord)).toMatchObject({ kind: "stop", decision: { outcome: "INVALID_PARAMETERS" } });
  });
});

describe("validate: a defective definition is an internal error, not a planner fault", () => {
  it("denies fail-closed when the schema produces something that is not JSON, without leaking why", async () => {
    // The registry's own rules would refuse such a schema, so a stand-in registry plays a defective host.
    const schema = { safeParse: () => ({ success: true, data: { projectId: new Date() } }) };
    const brokenRegistry = { ...registry, get: () => ({ definition: { ...definition, inputSchema: schema }, definitionHash: entry.definitionHash }) } as unknown as ActionRegistry;
    const decision = await harness({ registry: brokenRegistry, resolve: resolved }).run();
    expect(decision).toMatchObject({ outcome: "DENIED", reason: "internal_error", stage: "validate" });
    expect(toPlannerFeedback(decision)).toEqual({ outcome: "DENIED", category: "try_later" });
  });
});
