import type {
  ActionId, ActionRegistry, AuditSink, Clock, ConfirmationChannel, ConfirmationService, ConfirmationStore, ExecutorTable, GatewayConfig, GatewayDependencies,
  IdGenerator, PageContextProvider, PermissionChecker, PolicyGateway, RateLimiter, ReplayGuard, ResourceAuthorizer,
  SecurityStateStore, TenantActionPolicyStore,
} from "@dap/contracts";
import { createLimiter, type Limiter } from "../limits/limiter.js";
import { validateGatewayConfig } from "../limits/limit-config.js";
import { snapshotAnswer } from "./answer-snapshot.js";
import { createPipeline, type DecisionAuditor, type PipelineOptions, type StageMap } from "./pipeline.js";
import { withDeferredLimitDenials } from "./stages/limit-recording.js";
import { recordFinalDenial } from "./denial-throttle.js";
import { createProposalGateway } from "./submitter.js";
import { createIntakeStage } from "./stages/intake.js";
import { createRateLimitStage } from "./stages/rate-limit.js";
import { createReplayStage } from "./stages/replay.js";
import { createAuditEventFactory } from "../audit/event-factory.js";
import { createAuditWriter } from "../audit/audit-writer.js";
import { createDecisionAuditor } from "./decision-auditor.js";
import type { GatewayTelemetry } from "./telemetry.js";
import { createAuditStage } from "./stages/audit.js";
import { createNoConfirmationStage, createRiskGateStage } from "./stages/risk-gate.js";
import { createExecuteStage } from "./stages/execute.js";
import { createAuthorizeStage } from "./stages/authorize.js";
import { createValidateStage } from "./stages/validate.js";
import { createContextStage } from "./stages/context.js";
import { createResolveStage } from "./stages/resolve.js";

/**
 * Compile-time exhaustive method lists: a method added to (or removed from) a contract port
 * fails type-checking here instead of being silently dropped from the captured dependency.
 */
type Methods<T> = { readonly [K in keyof T]-?: true };
const registryMethods: Methods<Omit<ActionRegistry, "fingerprint">> = { get: true, list: true, isReservedForbidden: true };
const permissionMethods: Methods<PermissionChecker> = { has: true };
const resourceMethods: Methods<ResourceAuthorizer> = { resolve: true };
const pageMethods: Methods<PageContextProvider> = { currentPage: true };
const replayMethods: Methods<ReplayGuard> = { claim: true };
const rateLimiterMethods: Methods<RateLimiter> = { hit: true, isBlocked: true, block: true };
const confirmationStoreMethods: Methods<ConfirmationStore> = { create: true, get: true, listPending: true, tryAccept: true, tryReject: true, invalidate: true, recordExecution: true };
const tenantPolicyMethods: Methods<TenantActionPolicyStore> = { isDisabled: true };
const stateMethods: Methods<Pick<SecurityStateStore, "ping">> = { ping: true };
const executorMethods: Methods<ExecutorTable> = { executorFor: true };
const auditMethods: Methods<AuditSink> = { append: true };
const channelMethods: Methods<ConfirmationChannel> = { deliver: true };
const clockMethods: Methods<Clock> = { now: true };
const idMethods: Methods<IdGenerator> = { newDecisionId: true, newConfirmationId: true };

/** Capture the dependency graph once; method receivers remain the host's own port objects. */
function captureDependencies(source: GatewayDependencies): GatewayDependencies {
  const reads = new WeakMap<object, Map<string, unknown>>();
  const read = (parent: unknown, key: string): unknown => {
    if (!parent || typeof parent !== "object") throw new TypeError("Missing gateway dependency");
    let cached = reads.get(parent);
    if (!cached) { cached = new Map(); reads.set(parent, cached); }
    if (!cached.has(key)) cached.set(key, Reflect.get(parent, key));
    return cached.get(key);
  };
  const port = <T extends object>(parent: unknown, key: string, methods: Methods<T>): T => {
    const object = read(parent, key);
    const captured = Object.create(null) as Record<string, unknown>;
    for (const method of Object.keys(methods)) {
      const fn = read(object, method);
      if (typeof fn !== "function") throw new TypeError("Missing gateway dependency");
      captured[method] = Object.freeze((...args: unknown[]) => Reflect.apply(fn, object, args));
    }
    return Object.freeze(captured) as T;
  };
  try {
    const hooks = read(source, "hooks");
    const state = read(source, "state");
    const registrySource = read(source, "registry");
    const fingerprint = read(registrySource, "fingerprint");
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new TypeError("Invalid registry");
    const registry: ActionRegistry = Object.freeze({ ...port<Omit<ActionRegistry, "fingerprint">>(source, "registry", registryMethods), fingerprint: fingerprint as ActionRegistry["fingerprint"] });
    const global = read(source, "globalAllowlist");
    if (!global || typeof global !== "object") throw new TypeError("Missing gateway dependency");
    const globalAllowlist: ReadonlySet<ActionId> = new Set(global as ReadonlySet<ActionId>);
    // The one strict, frozen, detached configuration (T115): the same validator the host uses, never a looser copy.
    const config = validateGatewayConfig(snapshotAnswer(read(source, "config")));
    return Object.freeze({
      registry, globalAllowlist, config,
      executors: port<ExecutorTable>(source, "executors", executorMethods),
      hooks: Object.freeze({ permissions: port<PermissionChecker>(hooks, "permissions", permissionMethods), resources: port<ResourceAuthorizer>(hooks, "resources", resourceMethods), pages: port<PageContextProvider>(hooks, "pages", pageMethods) }),
      state: Object.freeze({
        ...port<Pick<SecurityStateStore, "ping">>(source, "state", stateMethods),
        replay: port<ReplayGuard>(state, "replay", replayMethods), rateLimiter: port<RateLimiter>(state, "rateLimiter", rateLimiterMethods),
        confirmations: port<ConfirmationStore>(state, "confirmations", confirmationStoreMethods), tenantPolicy: port<TenantActionPolicyStore>(state, "tenantPolicy", tenantPolicyMethods),
      }),
      audit: port<AuditSink>(source, "audit", auditMethods), confirmationChannel: port<ConfirmationChannel>(source, "confirmationChannel", channelMethods),
      clock: port<Clock>(source, "clock", clockMethods), ids: port<IdGenerator>(source, "ids", idMethods),
    });
  } catch { throw new TypeError("Missing or invalid gateway dependency"); }
}

/** What the host may add on top of the dependencies: where decision counts go. */
export interface GatewayExtras { readonly telemetry?: Partial<GatewayTelemetry> }

function createGatewayLimiter(deps: GatewayDependencies): Limiter {
  return createLimiter({ rateLimiter: deps.state.rateLimiter, config: deps.config.limits, clock: deps.clock, timeoutMs: deps.config.hookTimeoutMs });
}

/**
 * The D6 stages, bound to the captured dependencies, and the runner's auditor: context, intake, rate_limit, replay, resolve, validate, authorize,
 * risk (stage 7, the deterministic risk decision), confirmation (records that none was needed; the confirmation service replaces it), audit and
 * execute. `ALLOWED` is reachable for the classes that need no confirmation; a class that does is stopped at risk with `REQUIRES_CONFIRMATION`.
 * Exported for tests only; not part of the package surface.
 */
export function assemble(deps: GatewayDependencies, extras: GatewayExtras = {}, limiter: Limiter = createGatewayLimiter(deps)): { readonly stages: StageMap; readonly auditor: DecisionAuditor } {
  const options = { hookTimeoutMs: deps.config.hookTimeoutMs };
  const caps = { maxPayloadBytes: deps.config.maxPayloadBytes, maxJsonDepth: deps.config.maxJsonDepth };
  const host = extras.telemetry; // read once
  const telemetry = host === undefined ? {} : { telemetry: host };
  const writer = createAuditWriter({ sink: deps.audit, ...telemetry }, options);
  const events = createAuditEventFactory({ clock: deps.clock }, options);
  const intake = createIntakeStage(caps);
  const admitMalformed = createRateLimitStage(limiter, options, "intake");
  return Object.freeze({
    stages: {
      context: createContextStage(deps.clock, options),
      intake: async (request) => {
        const result = await intake(request);
        if (result.kind === "stop") {
          const admission = await admitMalformed(request);
          if (admission.kind === "stop") return admission;
        }
        return result;
      },
      rate_limit: createRateLimitStage(limiter, options),
      replay: createReplayStage({ replay: deps.state.replay, retainSeconds: deps.config.replayRetentionSeconds }, options),
      resolve: createResolveStage({ registry: deps.registry, globalAllowlist: deps.globalAllowlist, tenantPolicy: deps.state.tenantPolicy }, options),
      validate: createValidateStage(deps.registry, caps),
      authorize: createAuthorizeStage({ registry: deps.registry, permissions: deps.hooks.permissions, resources: deps.hooks.resources, pages: deps.hooks.pages, clock: deps.clock, limiter }, options),
      risk: createRiskGateStage({ registry: deps.registry, ids: deps.ids }),
      confirmation: createNoConfirmationStage(),
      audit: createAuditStage({ registry: deps.registry, events, writer, limiter, executors: deps.executors }, options),
      execute: createExecuteStage({ registry: deps.registry, executors: deps.executors, events, writer, ...telemetry }),
    },
    auditor: createDecisionAuditor({ registry: deps.registry, events, writer, registeredActionIds: new Set(deps.registry.list().map((entry) => entry.definition.id)), ...telemetry }),
  });
}
export const composeStages = (deps: GatewayDependencies, extras: GatewayExtras = {}, limiter?: Limiter): StageMap => assemble(deps, extras, limiter).stages;

/** The runner's options from the validated config: the per-call timeout and, when configured, the per-proposal budget. */
export function pipelineOptions(config: GatewayConfig): PipelineOptions {
  return { hookTimeoutMs: config.hookTimeoutMs, ...(config.proposalBudgetMs === undefined ? {} : { proposalBudgetMs: config.proposalBudgetMs }) };
}

export function createPolicyGateway(source: GatewayDependencies, extras: GatewayExtras = {}): Readonly<{ proposals: PolicyGateway; confirmations: ConfirmationService }> {
  const deps = captureDependencies(source);
  const limiter = createGatewayLimiter(deps);
  const { stages, auditor } = assemble(deps, extras, limiter);
  const pipeline = createPipeline(stages, { ...pipelineOptions(deps.config), audit: auditor });
  // One emission path: the runner's decision auditor writes every decision event (rate-limit denials included). What remains here is counting
  // a final denial toward the throttle, after the decision stands and outside the proposal deadline.
  const proposals = createProposalGateway({ pipeline: {
    async evaluate(input) {
      let result: Awaited<ReturnType<typeof pipeline.evaluate>> | undefined;
      const decision = await withDeferredLimitDenials(async () => { result = await pipeline.evaluate(input); return result.decision; });
      await recordFinalDenial(limiter, input, decision);
      return result!;
    },
  }, ids: deps.ids });
  const confirmations: ConfirmationService = Object.freeze({
    decide: Object.freeze(async () => Object.freeze({ status: "not_valid", category: "not_found" } as const)),
    listPending: Object.freeze(async () => Object.freeze([])),
  });
  return Object.freeze({ proposals, confirmations });
}
