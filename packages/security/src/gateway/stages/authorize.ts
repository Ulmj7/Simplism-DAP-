import type { ActionRegistry, AuthorizationContext, Clock, PageContextProvider, PageId, PermissionChecker, PermissionId, ResourceAuthorizer, ResourceRef, RiskLevel } from "@dap/contracts";
import { isMintedContext } from "@dap/contracts/mint";
import { denyDecision } from "../decision.js";
import { wrapHook, type HookKind, type HookOptions, type HookResult } from "../hook-wrapper.js";
import type { PipelineRecord, PolicyStage } from "../pipeline.js";
import { sessionVerdict } from "./context.js";
import type { Limiter } from "../../limits/limiter.js";
import { createLimitGate } from "./limit-gate.js";
import { provenDefinition } from "./registered.js";

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

type Reason = "unauthenticated" | "session_expired" | "permission_missing" | "context_not_allowed" | "resource_not_available" | "tenant_mismatch" | "dependency_failure";

/**
 * Stage 6, authorize (T077, FR-021..FR-025). The user's OWN authority, checked live, sequentially, and stopping at
 * the first denial: (a) the session is still usable now; (b) the host's permission checker answers the literal
 * `true` for the action's permission; (c) a restricted `allowedPages` is narrowed by the current page, which can
 * only ever narrow; (d) a resource the action targets resolves for this user and belongs to this tenant.
 *
 * Nothing here grants: a denial, a throw, a hang, a wrong shape or a missing answer all deny. A host fault is
 * `DENIED` with `dependency_failure` (planner category try_later); a definite "no" is not. An unknown resource, a
 * resource the user may not use and another tenant's resource look identical to the planner: `DENIED`, category
 * not_available; only the internal reason (`resource_not_available` or `tenant_mismatch`) differs.
 *
 * Every host call goes through `wrapHook`, with a timeout of `min(hookTimeoutMs, what is left of the proposal's
 * budget)`, so a slow host can never outlast the runner's overall deadline.
 */
export function createAuthorizeStage({ registry, permissions, resources, pages, clock, limiter }: {
  readonly registry: ActionRegistry;
  readonly permissions: PermissionChecker;
  readonly resources: ResourceAuthorizer;
  readonly pages: PageContextProvider;
  readonly clock: Clock;
  readonly limiter: Pick<Limiter, "checkCapability" | "recordDenial">;
}, options: HookOptions = {}): PolicyStage {
  const { hookTimeoutMs = 2000 } = options;
  const get = registry.get.bind(registry);
  const hasPermission = permissions.has.bind(permissions);
  const resolveResource = resources.resolve.bind(resources);
  const currentPage = pages.currentPage.bind(pages);
  const readClock = clock.now.bind(clock);
  const checkCapability = limiter.checkCapability.bind(limiter);
  const limitGate = createLimitGate(limiter, options);
  return async (request) => {
    const ids = { decisionId: request.decisionId, requestId: request.requestId, stage: "authorize" } as const;
    const resolved = record(request.facts.resolve);
    const validated = record(request.facts.validate);
    const name = typeof resolved?.id === "string" ? resolved.id : undefined;
    const stop = (outcome: "DENIED" | "UNAUTHORIZED", reason: Reason) => ({ kind: "stop" as const, decision: denyDecision({ ...ids, outcome, reason, ...(name === undefined ? {} : { attemptedAction: name }) }) });
    const fault = () => stop("DENIED", "dependency_failure");
    const ctx: unknown = request.context;
    const budget: unknown = (request as Partial<PipelineRecord>).budget?.remainingMs;
    if (!resolved || !validated || !isMintedContext(ctx) || typeof budget !== "function") return fault();
    const definition = provenDefinition(get, resolved);
    const permission: unknown = definition ? Reflect.get(definition, "requiredPermission") : undefined;
    const allowedPages: unknown = definition ? Reflect.get(definition, "allowedPages") : undefined;
    if (!definition || !text(permission) || typeof definition.changesState !== "boolean") return fault();
    const restricted = allowedPages === "any" ? null : Array.isArray(allowedPages) && allowedPages.every(text) ? new Set<string>(allowedPages) : undefined;
    const target = validated.resource === null ? null : record(validated.resource);
    if (restricted === undefined || target === undefined || (target !== null && (!text(target.type) || !text(target.id)))) return fault();

    /** One guarded host call, never allowed more time than the proposal has left. */
    const call = <K extends HookKind, A extends readonly unknown[]>(invoke: (...args: A) => unknown, kind: K, ...args: A): Promise<HookResult<Extract<HookResult<unknown>, { ok: true }>["value"]>> | HookResult<never> => {
      const left = Math.floor((budget as () => number)());
      if (!(left >= 1)) return { ok: false, reason: "dependency_failure" } as const;
      return wrapHook(invoke, kind, { ...options, hookTimeoutMs: Math.min(hookTimeoutMs, left) })(...args) as never;
    };

    // (a) the session, judged against the host clock now: time passes between stages.
    const instant = await call(readClock, "instant");
    if (!instant.ok) return fault();
    const verdict = sessionVerdict(ctx, Date.parse(instant.value as string));
    if (verdict !== "ok") return stop("UNAUTHORIZED", verdict);

    // (b) the user's own permission, live; only the literal true allows.
    const allowed = await call(hasPermission, "boolean", ctx as AuthorizationContext, permission as PermissionId);
    if (!allowed.ok) return allowed.reason === "denied" ? stop("UNAUTHORIZED", "permission_missing") : fault();

    // (c) page narrowing: never grants, and a restricted action with no known page is not allowed.
    if (restricted !== null) {
      const page = await call(currentPage, "page", ctx as AuthorizationContext, request.run);
      if (!page.ok) return page.reason === "denied" ? stop("DENIED", "context_not_allowed") : fault();
      if (!restricted.has(page.value as PageId)) return stop("DENIED", "context_not_allowed");
    }

    if (definition.changesState && target === null) return stop("DENIED", "resource_not_available");

    // (d) the resource the action targets, if any.
    let resource: { readonly type: string; readonly id: string; readonly displayName: string } | null = null;
    if (target !== null) {
      const ref: ResourceRef = Object.freeze({ type: target.type as string, id: target.id as string });
      const found = await call(resolveResource, "resource", ctx as AuthorizationContext, ref, permission as PermissionId);
      if (!found.ok) return found.reason === "denied" ? stop("DENIED", "resource_not_available") : fault();
      const answer = found.value as { readonly ref: ResourceRef; readonly tenantId: string; readonly displayName: string };
      if (answer.tenantId !== (ctx as AuthorizationContext).tenantId) return stop("DENIED", "tenant_mismatch");
      if (answer.ref.type !== ref.type || answer.ref.id !== ref.id) return stop("DENIED", "resource_not_available");
      resource = { type: answer.ref.type, id: answer.ref.id, displayName: answer.displayName };
    }
    const limited = await limitGate(request, "authorize", () => checkCapability({ scope: ctx as AuthorizationContext,
      userId: (ctx as AuthorizationContext).userId, actionId: definition.id, risk: definition.risk as RiskLevel }));
    return limited ?? { kind: "continue", data: { resource } };
  };
}
