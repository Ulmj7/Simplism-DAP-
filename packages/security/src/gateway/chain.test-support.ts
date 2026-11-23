/**
 * A whole proposal chain for tests: the real context, intake, resolve, validate, authorize, audit and execute stages and the real
 * decision auditor, with the real risk and confirmation stages (T104a) and pass-through stand-ins only for rate_limit and replay, which are covered by their own tests (these chains exercise audit and execute). `confirmedStandIns` replaces risk and confirmation for a test that deliberately needs a class the real stage 7 stops, a
 * recording executor behind `defineExecutor`, and an audit sink that can be made to fail.
 */
import { z } from "zod";
import { defineAction, defineExecutor } from "@dap/contracts";
import type { ActionId, AuditEvent, AuditEventType, ExecutionCall, ExecutionResult, ExecutorId, GatewayDependencies, IsoInstant, PageId, PermissionId, PlannerFeedback, RequestId, ResolvedResource, RiskLevel } from "@dap/contracts";
import { bindExecutors } from "../registry/bind-executors.js";
import { buildRegistry } from "../registry/build-registry.js";
import { InMemoryAuditStore } from "../state/memory/audit.js";
import { assemble, pipelineOptions } from "./create-gateway.js";
import { createPipeline, type PipelineOptions, type PolicyStage, type StageMap } from "./pipeline.js";
import { createProposalGateway } from "./submitter.js";
import type { GatewayTelemetry } from "./telemetry.js";
import { context, dependencies, run } from "./fixtures.test-support.js";

export const TENANT = "00000000-0000-4000-8000-000000000001";
export const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";

export interface ChainOptions {
  readonly risk?: RiskLevel;
  readonly resolveResource?: () => unknown;
  readonly permission?: () => unknown;
  readonly execute?: (call: ExecutionCall<unknown>) => Promise<ExecutionResult> | ExecutionResult;
  readonly telemetry?: Partial<GatewayTelemetry>;
  readonly timer?: PipelineOptions["timer"];
  /** What the host clock says; the context's own session runs 2026-01-01T00:00:00Z to 01:00:00Z. */
  readonly now?: string;
  /** Overrides the clock port entirely (it may throw, hang or answer anything). */
  readonly clock?: () => unknown;
  readonly config?: Partial<GatewayDependencies["config"]>;
}

/** Event types the sink refuses (an unavailable audit store for just those records), or everything when `all`. */
export interface SinkFaults { all: boolean; types: Set<AuditEventType>; hang: boolean }

export function chain(options: ChainOptions = {}) {
  const { deps: base } = dependencies();
  const definition = defineAction({
    id: "openProject" as ActionId, version: 2, description: "Open a project", risk: options.risk ?? "SAFE", requiredPermission: "project:view" as PermissionId, allowedPages: "any",
    inputSchema: z.strictObject({ projectId: z.string().min(1).max(12), note: z.string().max(40).optional() }),
    confirmation: (options.risk ?? "SAFE") === "SAFE" || options.risk === "LOW" ? { kind: "not-required" } : { kind: "required" }, changesState: false,
    audit: { params: [{ path: "/projectId", mode: "plain" }, { path: "/note", mode: "masked" }] }, executorId: "openProjectExecutor" as ExecutorId,
    resource: (params: { projectId: string }) => ({ type: "project", id: params.projectId }),
    describeConsequence: () => ({ title: "Open the project", effects: ["Opens it"], irreversible: false }),
  } as never);
  const registry = buildRegistry([definition]);
  const executorCalls: ExecutionCall<unknown>[] = [];
  const executor = defineExecutor({ id: definition.executorId, run: async (call) => {
    executorCalls.push(call);
    return options.execute === undefined ? { status: "success" as const, value: "done" } : options.execute(call);
  } });
  const store = new InMemoryAuditStore();
  const faults: SinkFaults = { all: false, types: new Set(), hang: false };
  const sinkCalls: AuditEvent[] = [];
  const sink = { append: async (event: AuditEvent) => {
    sinkCalls.push(event);
    if (faults.hang) await new Promise(() => {});
    if (faults.all || faults.types.has(event.type)) throw new Error("CANARY audit store down");
    await store.append(event);
  } };
  const resolved = (): ResolvedResource => ({ ref: { type: "project", id: "p1" }, tenantId: TENANT, displayName: "Project One" }) as ResolvedResource;
  const hostCalls: string[] = [];
  const deps: GatewayDependencies = {
    ...base, registry, executors: bindExecutors(registry, [executor]), globalAllowlist: new Set([definition.id]), audit: sink,
    hooks: {
      permissions: { has: async () => { hostCalls.push("has"); return (options.permission ?? (() => true))() as boolean; } },
      resources: { resolve: async (_ctx, ref) => { hostCalls.push("resolve"); return (options.resolveResource ?? (() => ({ ...resolved(), ref })))() as ResolvedResource; } },
      pages: { currentPage: async () => "page" as PageId },
    },
    clock: { now: (options.clock ?? (() => options.now ?? "2026-01-01T00:00:00Z")) as () => IsoInstant }, config: { ...base.config, ...options.config },
  };
  const pass: PolicyStage = () => ({ kind: "continue", data: {} });
  /** Stand-ins for the positions tested elsewhere (rate_limit, replay). Tests only. */
  const standIns: StageMap = {
    rate_limit: pass, replay: pass,
  };
  /** Pass-through risk and confirmation stages, for the tests that deliberately need a class the real stage 7 would stop (a confirmed HIGH, bent facts). */
  const confirmedStandIns: StageMap = {
    risk: (request) => ({ kind: "continue", data: { risk: (request.facts.resolve as { risk: string }).risk, confirmation: "not_required" } }),
    confirmation: () => ({ kind: "continue", data: { state: "not_required", confirmationId: null } }),
  };
  const built = assemble(deps, options.telemetry === undefined ? {} : { telemetry: options.telemetry });
  function pipelineWith(overrides: StageMap = {}) {
    return createPipeline({ ...built.stages, ...standIns, ...overrides }, { ...pipelineOptions(deps.config), audit: built.auditor, ...(options.timer === undefined ? {} : { timer: options.timer }) });
  }
  let next = 0;
  function submitter(overrides: StageMap = {}) {
    const gateway = createProposalGateway({ pipeline: pipelineWith(overrides), ids: { newDecisionId: () => `decision-${++next}` } });
    return gateway.forSession(context(), run);
  }
  const text = (params: unknown, action = "openProject") => JSON.stringify({ action, params });
  const events = async (): Promise<readonly AuditEvent[]> => store.listForTenant(TENANT);
  return { definition, registry, deps, executorCalls, store, faults, sinkCalls, hostCalls, standIns, confirmedStandIns, built, pipelineWith, submitter, text, events, ctx: context(), run };
}
export type Chain = ReturnType<typeof chain>;
export const feedbackOf = async (world: Chain, params: unknown, action = "openProject", overrides: StageMap = {}): Promise<PlannerFeedback> =>
  world.submitter(overrides).submit({ callId: `call-${Math.random().toString(36).slice(2)}`, raw: world.text(params, action) });
export const asRequestId = (id: string) => id as RequestId;
